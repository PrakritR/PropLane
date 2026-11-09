import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  HouseholdChargeRefundReviewError,
  refundPaidHouseholdCharge,
  resolveHouseholdChargeRefundRail,
} from "@/lib/household-charge-refund-rail.server";

/**
 * The one durable coordinator every general charge refund goes through: Refund charge, the
 * uncountersigned-lease auto-refund and the unhonored stay add-on.
 *
 * ## Why it exists
 *
 * A refund can come back `pending` — normal for a bank-funded charge on the destination and
 * managed rails — and a pending refund is NOT refunded money. The three initiators used to write
 * `refundedCents` themselves the moment the provider answered `succeeded`, and refused anything
 * else; so a pending refund left the charge reading un-refunded forever, with its whole amount
 * still offered as refundable, and nothing else ever wrote that field. Meanwhile the refund
 * attempt counter those routes keyed Stripe idempotency on lived in unlocked row JSON, so two
 * concurrent differing amounts could mint distinct provider keys against the same balance.
 *
 * So: the budget is reserved in `household_charge_refund_attempts` under the charge's own row
 * lock, against the authoritative payment ledger entry, and the reservation is durably
 * acknowledged BEFORE the provider is called. Provider idempotency is the reserved attempt's own
 * id — never an amount and never an unlocked counter. The money is projected onto the charge by
 * `bind_household_charge_refund`, once, from re-read terminal provider evidence, which is the
 * webhook's job (`handleStripeRefund`). Nothing here reports a refund as complete.
 *
 * Every outcome a caller can see is therefore `pending` (reserved and sent, terminal accounting
 * to follow), `unknown` (the provider's answer was lost or refused mid-flight — reconcile before
 * retrying) or `review` (a terminal refusal that moved no money).
 */
export type HouseholdChargeRefundOutcome =
  | { kind: "pending"; attemptId: string; refundId: string }
  | { kind: "unknown"; attemptId: string; refundId: string | null; message: string }
  | { kind: "review"; message: string };

/** `household-refund:<attempt id>` — the provider idempotency key AND the webhook's way back. */
export function householdRefundPlatformAttemptKey(attemptId: string): string {
  return `household-refund:${attemptId}`;
}

/** The attempt id a `household-refund:` platform key names, or null if it is not one of ours. */
export function householdRefundAttemptIdFromPlatformKey(key: string | null | undefined): string | null {
  const value = key?.trim() ?? "";
  return value.startsWith("household-refund:") ? value.slice("household-refund:".length) || null : null;
}

const UNCERTAIN = "Refund status requires reconciliation before retrying.";

type ReservedAttempt = {
  id: string;
  status: string;
  provider_refund_id: string | null;
  platform_attempt_key: string | null;
};

function storedOutcome(attempt: ReservedAttempt): HouseholdChargeRefundOutcome {
  if (attempt.status === "pending" || attempt.status === "succeeded") {
    return { kind: "pending", attemptId: attempt.id, refundId: attempt.provider_refund_id ?? "" };
  }
  return { kind: "unknown", attemptId: attempt.id, refundId: attempt.provider_refund_id, message: UNCERTAIN };
}

export async function runHouseholdChargeRefund(
  stripe: Stripe,
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    chargeId: string;
    stripeChargeId: string;
    paymentIntentId?: string | null;
    amountCents: number;
    /** One id per SUBMISSION, retained across that submission's retries. */
    operationKey: string;
    /** The full reviewed basis this reservation was made on; a changed basis refuses the replay. */
    basis: Record<string, unknown>;
    metadata?: Record<string, string>;
    reason?: Stripe.RefundCreateParams.Reason;
  },
): Promise<HouseholdChargeRefundOutcome> {
  let rail: Awaited<ReturnType<typeof resolveHouseholdChargeRefundRail>>;
  try {
    rail = await resolveHouseholdChargeRefundRail(db, {
      chargeId: input.chargeId,
      stripeChargeId: input.stripeChargeId,
      amountCents: input.amountCents,
    });
  } catch (error) {
    if (error instanceof HouseholdChargeRefundReviewError) return { kind: "review", message: error.message };
    throw error;
  }

  const { data: reserved, error: reserveError } = await db.rpc("reserve_household_charge_refund", {
    p_owner: input.ownerUserId,
    p_charge: input.chargeId,
    p_operation_key: input.operationKey,
    p_stripe_charge: input.stripeChargeId,
    p_payment_intent: input.paymentIntentId ?? null,
    p_rail: rail.rail,
    p_amount: input.amountCents,
    p_basis: { ...input.basis, rail: rail.rail, amountCents: input.amountCents },
  });
  const attempt = (reserved ?? null) as ReservedAttempt | null;
  if (reserveError || !attempt?.id) {
    return { kind: "review", message: "Refund requires reconciliation before retrying." };
  }
  // A replay of the SAME submission that already reached the provider reports what is stored.
  // Issuing a second provider call on an unknown or in-flight attempt is how one refund
  // becomes two.
  if (attempt.provider_refund_id || attempt.status !== "reserved") return storedOutcome(attempt);

  const platformAttemptKey = householdRefundPlatformAttemptKey(attempt.id);
  if (rail.rail === "central") {
    // Durably acknowledged before the call: the central rail's provider metadata carries only
    // the PLATFORM attempt, so this stamp is the webhook's only exact way back to this row.
    const { error } = await db.rpc("stamp_household_charge_refund_platform_key", {
      p_attempt: attempt.id, p_key: platformAttemptKey,
    });
    if (error) return { kind: "unknown", attemptId: attempt.id, refundId: null, message: UNCERTAIN };
  }

  const uncertain = async (refundId: string | null): Promise<HouseholdChargeRefundOutcome> => {
    await db.from("household_charge_refund_attempts")
      .update({ provider_refund_id: refundId || null, status: "unknown", updated_at: new Date().toISOString() })
      .eq("id", attempt.id).eq("status", "reserved");
    return { kind: "unknown", attemptId: attempt.id, refundId, message: UNCERTAIN };
  };

  let refund: Awaited<ReturnType<typeof refundPaidHouseholdCharge>>;
  try {
    refund = await refundPaidHouseholdCharge(stripe, db, {
      chargeId: input.chargeId,
      stripeChargeId: input.stripeChargeId,
      amountCents: input.amountCents,
      idempotencyKey: platformAttemptKey,
      metadata: { ...(input.metadata ?? {}), household_refund_attempt: attempt.id },
      ...(input.reason ? { reason: input.reason } : {}),
    });
  } catch (error) {
    if (error instanceof HouseholdChargeRefundReviewError) {
      // Only the rail RESOLVER raises this, and it runs before any provider call, so nothing
      // was sent. The reservation is released — leaving it held would block every later refund
      // of this charge — and the refusal is reported as terminal.
      await db.from("household_charge_refund_attempts")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("id", attempt.id).eq("status", "reserved");
      return { kind: "review", message: error.message };
    }
    // The call may or may not have left. Uncertainty is recorded durably, never a release:
    // releasing the budget on a refund that did go out is how the same money goes back twice.
    // The error itself is re-thrown so each caller keeps its own terminal/transient reading.
    await uncertain(null);
    throw error;
  }

  // `succeeded` from the provider is not terminal accounting: the webhook re-reads the refund,
  // records its evidence and projects the money through `bind_household_charge_refund`.
  if (refund.status === "pending" || refund.status === "succeeded") {
    const { error } = await db.from("household_charge_refund_attempts")
      .update({ provider_refund_id: refund.refundId || null, status: "pending", updated_at: new Date().toISOString() })
      .eq("id", attempt.id).eq("status", "reserved");
    if (error) return await uncertain(refund.refundId);
    return { kind: "pending", attemptId: attempt.id, refundId: refund.refundId };
  }
  // A failed or unknown provider answer releases nothing here: only verified terminal evidence
  // in the webhook may mark this attempt failed.
  return await uncertain(refund.refundId);
}
