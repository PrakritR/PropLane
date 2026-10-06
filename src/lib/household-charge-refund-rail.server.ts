import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runReservedPlatformMoneyRefund } from "@/lib/platform-money-refund.server";

/**
 * The one place a paid household charge is refunded, for every entrypoint that
 * sends money back (Refund charge, Return deposit, the uncountersigned-lease
 * auto-refund).
 *
 * Two rails, decided by the payment itself and never by the caller. The
 * discriminator is the hold's own `source_allocation_mode`, not merely whether a
 * `platform_payment_holds` row exists — a destination charge also gets a hold row
 * once `verify_platform_hold_source` stamps it, and that row is `'destination'`.
 *
 * - **Central capture** (`source_arbitration_v=1`, `source_allocation_mode='hold'`):
 *   captured on the PropLane platform with no `transfer_data.destination`. Stripe
 *   rejects `reverse_transfer` on a charge with no transfer, and a refund created
 *   outside the reservation carries no `platform_refund_attempt` metadata — which
 *   leaves the webhook unable to map it and the recipient hold wedged behind
 *   unresolved refund evidence. So it goes through
 *   `runReservedPlatformMoneyRefund`, which reserves the exact component, debits
 *   the recipient's money once, and stamps the metadata the webhook settles on.
 * - **Destination charge** (no hold row, or `source_allocation_mode='destination'`):
 *   the money landed directly in the manager's connected account, so the transfer
 *   is reversed with the refund, or the refund comes out of PropLane's balance
 *   while the manager silently keeps money they no longer hold. `handleStripeRefund`
 *   scopes its reservation requirement to `'hold'` holds for the same reason, so
 *   this refund books through the legacy ledger path without wedging the webhook.
 * - **Pre-arbitration hold** (a hold row with no `source_verified_at` and no
 *   frozen components, written before the central rail landed): refused up front
 *   with no Stripe call. `reserve_platform_money_refund` would raise
 *   'platform refund source needs review' on it anyway, and reversing a transfer
 *   that was never made would take the money out of PropLane's balance.
 */
export const PRE_ARBITRATION_REFUND_REVIEW_MESSAGE =
  "This payment was taken before the new payment system; its refund needs review.";

/** A terminal refusal: retrying never helps, so the caller answers 409, never 500. */
export class HouseholdChargeRefundReviewError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "HouseholdChargeRefundReviewError";
  }
}

type CapturedHold = {
  id: string;
  owner_user_id: string;
  owner_role: string;
  stripe_charge_id: string;
  source_allocation_mode: string | null;
  source_verified_at: string | null;
  source_components: Array<{ source_id: string; principal_cents: number }> | null;
};

export type HouseholdChargeRefundResult = {
  refundId: string;
  rail: "central" | "destination";
};

export async function refundPaidHouseholdCharge(
  stripe: Stripe,
  db: SupabaseClient,
  input: {
    chargeId: string;
    stripeChargeId: string;
    amountCents: number;
    idempotencyKey: string;
    metadata: Record<string, string>;
    reason?: Stripe.RefundCreateParams.Reason;
  },
): Promise<HouseholdChargeRefundResult> {
  if (!input.stripeChargeId.trim() || !Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error("A refund needs its exact source charge and a positive amount.");
  }

  const { data: holds, error } = await db
    .from("platform_payment_holds")
    .select("id,owner_user_id,owner_role,stripe_charge_id,source_allocation_mode,source_verified_at,source_components")
    .eq("stripe_charge_id", input.stripeChargeId)
    .limit(2);
  if (error) throw new Error("Could not resolve the payment's recipient allocation.");
  if ((holds ?? []).length > 1) {
    throw new HouseholdChargeRefundReviewError(
      "This payment has ambiguous recipient allocations; the refund needs review.");
  }
  const hold = (holds?.[0] ?? null) as CapturedHold | null;

  if (!hold || hold.source_allocation_mode === "destination") {
    const refund = await stripe.refunds.create(
      {
        charge: input.stripeChargeId,
        amount: input.amountCents,
        reverse_transfer: true,
        ...(input.reason ? { reason: input.reason } : {}),
        metadata: input.metadata,
      },
      { idempotencyKey: input.idempotencyKey },
    );
    return { refundId: refund.id, rail: "destination" };
  }

  if (hold.source_allocation_mode !== "hold" || !hold.source_verified_at ||
      !Array.isArray(hold.source_components)) {
    throw new HouseholdChargeRefundReviewError(PRE_ARBITRATION_REFUND_REVIEW_MESSAGE);
  }
  if (hold.owner_role !== "manager" || !hold.owner_user_id) {
    throw new HouseholdChargeRefundReviewError(
      "This payment's recipient is not a manager allocation; the refund needs review.");
  }
  const component = hold.source_components.find((part) => part.source_id === input.chargeId) ?? null;
  if (!component || !Number.isSafeInteger(component.principal_cents) || component.principal_cents <= 0) {
    throw new HouseholdChargeRefundReviewError(
      "This payment has no captured component for the charge; the refund needs review.");
  }
  if (input.amountCents > component.principal_cents) {
    throw new HouseholdChargeRefundReviewError(
      "A refund cannot exceed the charge's captured principal.");
  }

  const result = await runReservedPlatformMoneyRefund(stripe, db, {
    ownerUserId: hold.owner_user_id,
    holdId: hold.id,
    principalCents: input.amountCents,
    attemptKey: input.idempotencyKey,
    components: [{ sourceId: input.chargeId, principalCents: input.amountCents }],
    ...(input.reason ? { reason: input.reason } : {}),
  });
  // A failed provider refund moved no money. Throwing keeps the caller from
  // recording `refundedCents` against a refund that never happened.
  if (result.status === "failed") throw new Error("Stripe refused this refund; nothing was refunded.");
  return { refundId: result.refundId, rail: "central" };
}
