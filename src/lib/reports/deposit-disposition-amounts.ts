import type { SecurityDepositLedgerRow } from "./security-deposits";

/** A disposition records only the amount released in that journal. Money still
 * held is never a refund due, and prior deductions remain cumulative. */
export function depositDispositionAmounts(deposit: SecurityDepositLedgerRow) {
  const deductions = deposit.itemization.filter(item => item.kind !== "refund");
  const current = deposit.itemization.filter(item => item.journalId && item.journalId === deposit.dispositionJournalId);
  const priorRefundCents = deposit.itemization.filter(item => item.kind === "refund" && !current.includes(item)).reduce((sum, item) => sum + item.amountCents, 0);
  const withheldCents = deductions.length ? deductions.reduce((sum, item) => sum + item.amountCents, 0)
    : deposit.dispositionType === "full_withhold" ? deposit.amountCents - deposit.amountHeldCents - priorRefundCents : 0;
  const trackedHistory = deposit.itemization.some(item => item.sourceId || item.journalId || item.kind === "refund");
  const refundCents = current.length || trackedHistory
    ? current.filter(item => item.kind === "refund").reduce((sum, item) => sum + item.amountCents, 0)
    : Math.max(0, deposit.amountCents - deposit.amountHeldCents - withheldCents - priorRefundCents);
  return { deductions, priorRefundCents, withheldCents, refundCents, remainingHeldCents: deposit.amountHeldCents };
}
