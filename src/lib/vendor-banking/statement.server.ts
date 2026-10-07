import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { listVendorBankingLedgerEntries, type VendorBankingLedgerEntry } from "@/lib/vendor-banking/ledger.server";
import {
  statementMonthKey,
  summarizeStatementMonths,
  vendorStatementEventType,
  VENDOR_STATEMENT_EVENT_LABELS,
  type StatementMonthSummary,
  type VendorStatementEventType,
} from "@/lib/vendor-banking/statement-events";

export type VendorStatementLine = VendorBankingLedgerEntry & {
  runningBalanceCents: number;
  /** The plain-language type (charge, fee, transfer, withdrawal, instant fee, refund, dispute, hold expiry …). */
  eventType: VendorStatementEventType;
};

export type VendorReconciliationStamp = {
  reconciledAt: string;
  matches: boolean;
  ledgerTotalCents: number;
  stripeTotalCents: number;
} | null;

export type VendorStatement = {
  lines: VendorStatementLine[];
  reconciliation: VendorReconciliationStamp;
  /** Balance before the first line shown (everything before the month, or 0 for all time). */
  openingCents: number;
  /** Balance after the last line shown. */
  closingCents: number;
  /** One summary per month with activity, newest first — the Statements list. */
  months: StatementMonthSummary[];
};

/**
 * Every ledger line for the vendor (optionally one PACIFIC month), each carrying
 * a running balance — computed once, in order, never per-row from scratch. A
 * month filter still carries everything BEFORE that month into the opening
 * balance, so it reads as a real bank statement rather than resetting to 0.
 *
 * The read is unlimited and paged: a statement that silently stopped at a row
 * cap would show a stale closing balance as if it were the real one.
 *
 * Throws on a read failure: the caller must answer with a real error, never an
 * empty statement that reads as "No activity yet".
 */
export async function buildVendorStatement(
  db: SupabaseClient,
  vendorUserId: string,
  opts: { month?: string | null } = {},
): Promise<VendorStatement> {
  const all = await listVendorBankingLedgerEntries(db, vendorUserId);
  const month = opts.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : null;
  const inScope = month ? all.filter((entry) => statementMonthKey(entry.createdAt) === month) : all;
  let running = month ? all.filter((entry) => statementMonthKey(entry.createdAt) < month).reduce((sum, entry) => sum + entry.amountCents, 0) : 0;
  const openingCents = running;
  const lines: VendorStatementLine[] = inScope.map((entry) => {
    running += entry.amountCents;
    return { ...entry, runningBalanceCents: running, eventType: vendorStatementEventType(entry) };
  });

  const { data } = await db
    .from("vendor_banking_reconciliation")
    .select("reconciled_at, matches, ledger_total_cents, stripe_total_cents")
    .eq("vendor_user_id", vendorUserId)
    .maybeSingle();
  const reconciliation: VendorReconciliationStamp = data
    ? {
        reconciledAt: String((data as { reconciled_at: string }).reconciled_at),
        matches: Boolean((data as { matches: boolean }).matches),
        ledgerTotalCents: Number((data as { ledger_total_cents: number }).ledger_total_cents) || 0,
        stripeTotalCents: Number((data as { stripe_total_cents: number }).stripe_total_cents) || 0,
      }
    : null;

  return {
    lines,
    reconciliation,
    openingCents,
    closingCents: running,
    months: summarizeStatementMonths(all),
  };
}

/** Free text in a spreadsheet cell must never start a formula. */
function csvSafeText(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function vendorStatementCsv(statement: Pick<VendorStatement, "lines">): string {
  const header = ["Date", "Type", "Description", "Amount", "Running balance"];
  const rows = statement.lines.map((line) => [
    line.createdAt,
    VENDOR_STATEMENT_EVENT_LABELS[vendorStatementEventType(line)],
    csvSafeText(line.description).replace(/"/g, '""'),
    (line.amountCents / 100).toFixed(2),
    (line.runningBalanceCents / 100).toFixed(2),
  ]);
  return [header, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
}
