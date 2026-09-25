/**
 * Refunding a paid rent or fee charge (anything but a security deposit — that keeps its own
 * dedicated Return-deposit flow in `deposit-return.ts`).
 *
 * Until now the only way to send money back to a resident was Return deposit. A paid rent
 * payment, a paid service fee, a paid late fee, and so on had no reversal at all — the only
 * portal action against a paid charge was Delete, which quietly deletes the charge's ledger
 * line without refunding anyone and orphans the real payment line (see C024 / `removePayment`).
 * This module is the other half of closing that gap: once a charge is paid, Delete goes away
 * and Refund (full or partial) is the only way to reverse it.
 *
 * Same irreversible-money shape as `deposit-return.ts`, so the same discipline applies: this
 * module holds no Stripe or database access, only the decision of whether and how much, and it
 * is deliberately biased toward refusing when it cannot tell.
 */

/** What the caller knows about a charge before refunding any of it. */
export type ChargeRefundContext = {
  /** The charge's kind. `security_deposit` is refused — it uses Return deposit instead. */
  kind: string;
  /** The charge's status. Only a paid charge has money to send back. */
  status: string;
  /** What the resident actually paid, in cents. */
  paidCents: number;
  /** Sum of everything already refunded against this charge, in cents. */
  alreadyRefundedCents: number;
  /** The Stripe charge the money arrived on. Without it there is nothing to refund against. */
  stripeChargeId: string | null;
  /** Whether the original payment has cleared. An ACH debit can still bounce. */
  settled: boolean;
};

export type ChargeRefundRefusal =
  | "is_a_deposit"
  | "not_paid"
  | "not_settled"
  | "no_stripe_payment"
  | "nothing_left"
  | "amount_not_positive"
  | "amount_exceeds_remaining";

export type ChargeRefundDecision =
  | { ok: true; amountCents: number; remainingAfterCents: number; stripeChargeId: string }
  | { ok: false; reason: ChargeRefundRefusal; message: string };

const REFUSAL_MESSAGES: Record<ChargeRefundRefusal, string> = {
  is_a_deposit: "Use Return deposit for a security deposit.",
  not_paid: "This charge has not been paid, so there is nothing to refund.",
  not_settled: "This payment has not cleared yet. Refunding it now could send money that never arrives.",
  no_stripe_payment: "This charge was not paid through PropLane, so it has to be refunded the way it was received.",
  nothing_left: "This charge has already been refunded in full.",
  amount_not_positive: "Enter an amount greater than zero.",
  amount_exceeds_remaining: "That is more than is left on this charge.",
};

/** How much of a paid charge is still refundable, never below zero. */
export function chargeRefundRemainingCents(
  ctx: Pick<ChargeRefundContext, "paidCents" | "alreadyRefundedCents">,
): number {
  return Math.max(0, Math.round(ctx.paidCents) - Math.round(ctx.alreadyRefundedCents));
}

/**
 * Whether this charge may be refunded at all, and for how much.
 *
 * `amountCents` omitted means "refund everything still paid" (a full refund), the common case.
 * A supplied amount is checked against what remains rather than the original payment, so two
 * partial refunds cannot together exceed what was paid.
 *
 * Deliberately NO time-window cap (C099: matches the real Stripe-refund path — Return deposit
 * has none either, and Stripe itself only limits a refund to within 180 days of the charge,
 * which this module does not need to reimplement since Stripe enforces it on its side).
 */
export function decideChargeRefund(ctx: ChargeRefundContext, amountCents?: number): ChargeRefundDecision {
  const refuse = (reason: ChargeRefundRefusal): ChargeRefundDecision => ({
    ok: false,
    reason,
    message: REFUSAL_MESSAGES[reason],
  });

  if (ctx.kind === "security_deposit") return refuse("is_a_deposit");
  if (ctx.status !== "paid") return refuse("not_paid");
  if (!ctx.settled) return refuse("not_settled");

  const stripeChargeId = ctx.stripeChargeId?.trim() ?? "";
  if (!stripeChargeId) return refuse("no_stripe_payment");

  const remaining = chargeRefundRemainingCents(ctx);
  if (remaining <= 0) return refuse("nothing_left");

  // Absent means "all of it". A supplied zero or negative is a mistake, not a request to refund
  // everything, so the two are kept distinct.
  const requested = amountCents === undefined ? remaining : Math.round(amountCents);
  if (requested <= 0) return refuse("amount_not_positive");
  if (requested > remaining) return refuse("amount_exceeds_remaining");

  return {
    ok: true,
    amountCents: requested,
    remainingAfterCents: remaining - requested,
    stripeChargeId,
  };
}

/**
 * A stable key for one refund attempt, passed to Stripe as an idempotency key. Two clicks on the
 * button, or a retry after a timeout that actually succeeded, must not send the refund twice.
 */
export function chargeRefundIdempotencyKey(input: { chargeId: string; amountCents: number; attempt: number }): string {
  return `charge-refund:${input.chargeId}:${input.amountCents}:${input.attempt}`;
}
