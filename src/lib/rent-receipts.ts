import type { HouseholdCharge } from "@/lib/household-charges";
import { parseMoneyAmount } from "@/lib/parse-money";
import type { ReportRow } from "@/lib/reports/types";

export type ReceiptRow = {
  /**
   * Stable per-row id. Positional, so true-duplicate ledger payments — the
   * resident ledger legitimately contains payments identical on
   * (date, amount, description) — stay individually selectable. Selecting the
   * open receipt by those fields (the old behaviour) collapses duplicates onto
   * each other. See {@link buildReceiptRows}.
   */
  id: string;
  date: string;
  description: string;
  amount: string;
  processingFeeLabel?: string;
  totalChargedLabel?: string;
};

/**
 * Map resident-ledger report rows to receipt rows: payment entries only,
 * newest first, each with a stable UNIQUE id.
 *
 * The id is load-bearing. The resident ledger can hold several payments that
 * are identical on (date, amount, description) — e.g. two application-fee
 * payments of $45 on the same day. Tracking the open receipt by those three
 * fields (as this tab used to) makes the duplicates indistinguishable: clicking
 * one opens both, and clicking its twin toggles the shared value off, so the
 * receipt disappears entirely — the "clicking a row does not open it inline"
 * bug. A positional id keeps each row distinct, mirroring the stable `row.id`
 * the Other-documents table already selects on.
 */
export function paidChargeToLedgerReportRow(charge: HouseholdCharge): ReportRow {
  const faceCents = Math.round(parseMoneyAmount(charge.amountLabel) * 100);
  const paidCents = charge.paidAmountCents;
  const feeCents = paidCents && paidCents > faceCents ? paidCents - faceCents : 0;
  return {
    date: String(charge.paidAt ?? "").slice(0, 10),
    description: `${charge.title} · ${charge.propertyLabel}`,
    payment: charge.amountLabel,
    ...(feeCents > 0 ? { processingFee: `$${(feeCents / 100).toFixed(2)}` } : {}),
    ...(paidCents && paidCents > faceCents ? { totalCharged: `$${(paidCents / 100).toFixed(2)}` } : {}),
  };
}

export function buildReceiptRows(rows: ReadonlyArray<ReportRow>): ReceiptRow[] {
  return rows
    .filter((row) => typeof row.payment === "string" && row.payment.trim() !== "")
    .map((row, index) => ({
      id: String(index),
      date: String(row.date ?? ""),
      // NOT "Rent payment" — this ledger row may be utilities, a deposit or an
      // application fee, and the label built from it is an exportable financial
      // record (resident audit U9).
      description: String(row.description ?? "").trim() || "Payment",
      amount: String(row.payment),
      processingFeeLabel:
        typeof row.processingFee === "string" && row.processingFee.trim() ? String(row.processingFee) : undefined,
      totalChargedLabel:
        typeof row.totalCharged === "string" && row.totalCharged.trim() ? String(row.totalCharged) : undefined,
    }))
    .reverse();
}
