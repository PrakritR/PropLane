/**
 * The one rule for what can be approved. Dependency-free so the server action and the UI import the
 * same predicate (see work-order-bid-cycle.ts).
 */

/** The minimal shape both the DB record (snake_case) and the client bid (camelCase) reduce to. */
export type BidApprovalFacts = {
  status: string;
  amountCents: number | null;
  bidSubmittedAt: string | null;
};

/**
 * Only a SUBMITTED BID can be approved: a price, a submitted-at stamp, and a still-open row.
 * An estimate (or a booked visit) alone never qualifies.
 */
export function bidCanBeApproved(bid: BidApprovalFacts): boolean {
  return bid.status === "submitted" && bid.amountCents != null && bid.amountCents > 0 && Boolean(bid.bidSubmittedAt);
}
