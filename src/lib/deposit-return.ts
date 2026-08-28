/**
 * Returning a security deposit.
 *
 * A manager presses one button and money leaves their account for a resident's. That is
 * irreversible in the direction that matters — Stripe will not un-refund — so every question this
 * module answers is weighted toward refusing when it cannot tell.
 *
 * The accounting shape is set by `docs/agents/financials.md`: a deposit is booked to a LIABILITY,
 * not income, because it was never the manager's money. Returning it therefore discharges that
 * liability rather than recording an expense, and a partial return leaves the remainder still
 * owed. This module decides WHETHER and HOW MUCH; the caller performs the Stripe refund and the
 * ledger write.
 *
 * It deliberately holds no Stripe or database access, so the rules can be read and tested without
 * a payment processor in the loop.
 */

/** What the caller knows about a deposit charge before returning any of it. */
export type DepositReturnContext = {
  /** The charge's kind, straight from the record. Only `security_deposit` is returnable. */
  kind: string;
  /** The charge's status. Only a paid deposit has money to send back. */
  status: string;
  /** What the resident actually paid, in cents. */
  paidCents: number;
  /** Sum of everything already returned against this deposit, in cents. */
  alreadyReturnedCents: number;
  /**
   * The Stripe charge the money arrived on. Without it there is nothing to refund against —
   * a deposit paid by cash or Zelle has no Stripe record and must be settled outside PropLane.
   */
  stripeChargeId: string | null;
  /** Whether the original payment has cleared. An ACH debit can still bounce. */
  settled: boolean;
};

export type DepositReturnRefusal =
  | "not_a_deposit"
  | "not_paid"
  | "not_settled"
  | "no_stripe_payment"
  | "nothing_left"
  | "amount_not_positive"
  | "amount_exceeds_remaining";

export type DepositReturnDecision =
  | { ok: true; amountCents: number; remainingAfterCents: number; stripeChargeId: string }
  | { ok: false; reason: DepositReturnRefusal; message: string };

const REFUSAL_MESSAGES: Record<DepositReturnRefusal, string> = {
  not_a_deposit: "Only a security deposit can be returned this way.",
  not_paid: "This deposit has not been paid, so there is nothing to return.",
  not_settled:
    "This payment has not cleared yet. Returning it now could send money that never arrives.",
  no_stripe_payment:
    "This deposit was not paid through PropLane, so it has to be returned the way it was received.",
  nothing_left: "This deposit has already been returned in full.",
  amount_not_positive: "Enter an amount greater than zero.",
  amount_exceeds_remaining: "That is more than is left on this deposit.",
};

/** How much of a deposit is still held, never below zero. */
export function depositRemainingCents(ctx: Pick<DepositReturnContext, "paidCents" | "alreadyReturnedCents">): number {
  return Math.max(0, Math.round(ctx.paidCents) - Math.round(ctx.alreadyReturnedCents));
}

/**
 * Whether this deposit may be returned at all, and for how much.
 *
 * `amountCents` omitted means "return everything still held", which is the common case and the
 * one the button uses. A supplied amount is checked against what remains rather than against the
 * original payment, so two partial returns cannot together exceed what was taken.
 *
 * The `settled` check exists because an ACH debit can bounce days after it appears to succeed.
 * Refunding an unsettled payment can send real money against funds that never arrive, and the
 * manager is left owing it — so an uncleared deposit is refused rather than trusted.
 */
export function decideDepositReturn(
  ctx: DepositReturnContext,
  amountCents?: number,
): DepositReturnDecision {
  const refuse = (reason: DepositReturnRefusal): DepositReturnDecision => ({
    ok: false,
    reason,
    message: REFUSAL_MESSAGES[reason],
  });

  if (ctx.kind !== "security_deposit") return refuse("not_a_deposit");
  if (ctx.status !== "paid") return refuse("not_paid");
  if (!ctx.settled) return refuse("not_settled");

  const stripeChargeId = ctx.stripeChargeId?.trim() ?? "";
  if (!stripeChargeId) return refuse("no_stripe_payment");

  const remaining = depositRemainingCents(ctx);
  if (remaining <= 0) return refuse("nothing_left");

  // Absent means "all of it". A supplied zero or negative is a mistake, not a request to return
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
 * A stable key for one return attempt, passed to Stripe as an idempotency key.
 *
 * Two clicks on the button, or a retry after a timeout that actually succeeded, must not send the
 * deposit twice. The key includes the amount so that a genuine SECOND partial return of the same
 * size is still possible — keyed on the attempt's own sequence number rather than only the charge.
 */
export function depositReturnIdempotencyKey(input: {
  chargeId: string;
  amountCents: number;
  attempt: number;
}): string {
  return `deposit-return:${input.chargeId}:${input.amountCents}:${input.attempt}`;
}
