/**
 * Pure refund math for a vendor refund on the central rail. No I/O: the server
 * reads the funds, this decides what is recoverable. The fee share mirrors the
 * rail's own SQL (`reserve_platform_money_refund`): the PropLane fee returned is
 * the difference between two cumulative proportional targets, so partial refunds
 * add up to exactly the fee on the whole payment and the rail never disagrees.
 */

export type RefundablePayout = {
  amountCents: number;
  platformFeeCents: number;
  refundedGrossCents: number;
};

/** Cumulative fee returned once `cumulativeGrossCents` of a payment has been refunded. */
export function cumulativeFeeReturnedCents(
  payout: Pick<RefundablePayout, "amountCents" | "platformFeeCents">,
  cumulativeGrossCents: number,
): number {
  if (payout.amountCents <= 0) return 0;
  return Math.round((cumulativeGrossCents * payout.platformFeeCents) / payout.amountCents);
}

export function refundFeeShareCents(payout: RefundablePayout, grossCents: number): number {
  return (
    cumulativeFeeReturnedCents(payout, payout.refundedGrossCents + grossCents) -
    cumulativeFeeReturnedCents(payout, payout.refundedGrossCents)
  );
}

/** What the vendor's own balance gives up for this much refunded to the manager. */
export function refundNetDebitCents(payout: RefundablePayout, grossCents: number): number {
  return grossCents - refundFeeShareCents(payout, grossCents);
}

export function remainingRefundableGrossCents(payout: RefundablePayout): number {
  return Math.max(0, payout.amountCents - payout.refundedGrossCents);
}

/** The largest gross refund whose net debit fits inside `netCapCents` (net debit is non-decreasing in gross). */
export function maxGrossForNetCents(payout: RefundablePayout, netCapCents: number): number {
  let lo = 0;
  let hi = remainingRefundableGrossCents(payout);
  if (netCapCents <= 0) return 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (refundNetDebitCents(payout, mid) <= netCapCents) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export type RecoverableFunds = {
  /** Still held on PropLane for this job (never reached the vendor's account). */
  heldCents: number;
  /** Released to the vendor's account for this job and not yet reversed. */
  transferredOutstandingCents: number;
  /** What the vendor's connected account can actually give back right now. */
  availableBalanceCents: number;
  /** Frozen by an open dispute: neither refundable nor withdrawable. */
  frozenCents: number;
};

export type RefundCapRefusal = "fully_refunded" | "withdrawn" | "frozen";

export type RefundCap = {
  /** Net the vendor can give back: held + the released money still in their account, less frozen. */
  recoverableNetCents: number;
  maxGrossCents: number;
  refusal: RefundCapRefusal | null;
};

export function computeVendorRefundCap(payout: RefundablePayout, funds: RecoverableFunds): RefundCap {
  const remaining = remainingRefundableGrossCents(payout);
  if (remaining <= 0) return { recoverableNetCents: 0, maxGrossCents: 0, refusal: "fully_refunded" };
  const releasedRecoverable = Math.max(
    0,
    Math.min(funds.transferredOutstandingCents, funds.availableBalanceCents),
  );
  const gross = Math.max(0, funds.heldCents) + releasedRecoverable;
  const recoverableNetCents = Math.max(0, gross - Math.max(0, funds.frozenCents));
  const maxGrossCents = maxGrossForNetCents(payout, recoverableNetCents);
  if (maxGrossCents > 0) return { recoverableNetCents, maxGrossCents, refusal: null };
  if (funds.frozenCents > 0 && gross > 0) return { recoverableNetCents, maxGrossCents: 0, refusal: "frozen" };
  return { recoverableNetCents, maxGrossCents: 0, refusal: "withdrawn" };
}

export const VENDOR_REFUND_REFUSAL_COPY: Record<RefundCapRefusal, string> = {
  fully_refunded: "This payment has already been fully refunded.",
  withdrawn: "This money has already been withdrawn, so it can't be refunded from here. Message the manager.",
  frozen: "This money is frozen by an open dispute, so it can't be refunded right now.",
};

/** Stable key caps: the modal mints one per open, so a retry or double-submit replays the same attempt. */
export function vendorRefundAttemptKey(payoutId: string, clientKey: string): string | null {
  const cleaned = clientKey.trim();
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(cleaned)) return null;
  return `vendor-refund:${payoutId}:${cleaned}`;
}
