/** Pure dispute rules shared by the webhook handler and the balance snapshot. */

export const OPEN_DISPUTE_STATUSES = [
  "needs_response",
  "under_review",
  "warning_needs_response",
  "warning_under_review",
] as const;

export type DisputeOutcome = "won" | "lost" | "warning_closed";

export function isOpenDisputeStatus(status: string): boolean {
  return (OPEN_DISPUTE_STATUSES as readonly string[]).includes(status);
}

/** won / lost / warning_closed; `charge_refunded` closes with no outcome (nothing to freeze or debit). */
export function disputeOutcomeForStatus(status: string): DisputeOutcome | null {
  return status === "won" || status === "lost" || status === "warning_closed" ? status : null;
}

/** What an open dispute freezes: the disputed amount, never more than the payment itself. */
export function frozenCentsForDispute(disputeAmountCents: number, payoutAmountCents: number): number {
  return Math.max(0, Math.min(Math.round(disputeAmountCents), Math.round(payoutAmountCents)));
}

/**
 * What a LOST dispute takes from the vendor: the disputed principal less the PropLane
 * fee share on it (the vendor only ever received the net), capped at what is left unrefunded.
 */
export function lostDisputeVendorDebitCents(input: {
  disputeAmountCents: number;
  payoutAmountCents: number;
  platformFeeCents: number;
  refundedGrossCents: number;
}): number {
  const gross = Math.min(
    Math.max(0, Math.round(input.disputeAmountCents)),
    Math.max(0, input.payoutAmountCents - input.refundedGrossCents),
  );
  const fee = input.payoutAmountCents > 0 ? Math.round((gross * input.platformFeeCents) / input.payoutAmountCents) : 0;
  return Math.max(0, gross - fee);
}
