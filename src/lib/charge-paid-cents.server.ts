import "server-only";

import { dollarsToCents } from "@/lib/reports/money";

/** Ledger payment amount wins; offline receipts may only have row_data. */
export function resolveChargePaidCents(
  ledgerPaymentAmountCents: number | null | undefined,
  charge: Record<string, unknown>,
): number {
  const fromLedger = Number(ledgerPaymentAmountCents ?? 0);
  if (Number.isFinite(fromLedger) && fromLedger > 0) return Math.round(fromLedger);
  const paidField = Number(charge.paidAmountCents ?? 0);
  if (Number.isFinite(paidField) && paidField > 0) return Math.round(paidField);
  const fromLabel = dollarsToCents(charge.amountLabel as string | number | null | undefined);
  return fromLabel > 0 ? fromLabel : 0;
}
