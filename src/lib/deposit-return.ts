/** Remaining deposit arithmetic. Authoritative return eligibility and reservation are enforced server-side. */

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
   * a deposit paid by cash or check has no Stripe record and must be settled outside PropLane.
   */
  stripeChargeId: string | null;
  /** Whether the original payment has cleared. An ACH debit can still bounce. */
  settled: boolean;
};

/** How much of a deposit is still held, never below zero. */
export function depositRemainingCents(ctx: Pick<DepositReturnContext, "paidCents" | "alreadyReturnedCents">): number {
  return Math.max(0, Math.round(ctx.paidCents) - Math.round(ctx.alreadyReturnedCents));
}
