import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runReservedPlatformMoneyRefund } from "@/lib/platform-money-refund.server";

/**
 * The one place a paid household charge is refunded, for every entrypoint that
 * sends money back (Refund charge, Return deposit, the uncountersigned-lease
 * auto-refund).
 *
 * Two rails, decided by the payment itself and never by the caller:
 *
 * - **Central capture** (`source_arbitration_v=1`): the money was captured on
 *   the PropLane platform with no `transfer_data.destination`, so there is a
 *   `platform_payment_holds` row for the charge. Stripe rejects
 *   `reverse_transfer` on a charge with no transfer, and a refund created
 *   outside the reservation carries no `platform_refund_attempt` metadata —
 *   which leaves the webhook unable to map it and the recipient hold wedged
 *   behind unresolved refund evidence. So it goes through
 *   `runReservedPlatformMoneyRefund`, which reserves the exact component,
 *   debits (or reverses) the recipient's money once, and stamps the metadata
 *   the webhook settles on.
 * - **Legacy destination charge**: no hold row, the money landed directly in
 *   the manager's connected account, so the transfer is reversed with the
 *   refund or the refund comes out of PropLane's balance while the manager
 *   silently keeps money they no longer hold.
 */
type CapturedHold = {
  id: string;
  owner_user_id: string;
  owner_role: string;
  stripe_charge_id: string;
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
    .select("id,owner_user_id,owner_role,stripe_charge_id,source_components")
    .eq("stripe_charge_id", input.stripeChargeId)
    .limit(2);
  if (error) throw new Error("Could not resolve the payment's recipient allocation.");
  if ((holds ?? []).length > 1) {
    throw new Error("This payment has ambiguous recipient allocations; the refund needs review.");
  }
  const hold = (holds?.[0] ?? null) as CapturedHold | null;

  if (!hold) {
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

  if (hold.owner_role !== "manager" || !hold.owner_user_id) {
    throw new Error("This payment's recipient is not a manager allocation; the refund needs review.");
  }
  const component = (hold.source_components ?? []).find((part) => part.source_id === input.chargeId) ?? null;
  if (!component || !Number.isSafeInteger(component.principal_cents) || component.principal_cents <= 0) {
    throw new Error("This payment has no captured component for the charge; the refund needs review.");
  }
  if (input.amountCents > component.principal_cents) {
    throw new Error("A refund cannot exceed the charge's captured principal.");
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
