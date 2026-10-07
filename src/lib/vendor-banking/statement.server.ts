import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { PROPLANE_SERVICE_FEE_LABEL } from "@/lib/platform-fees";
import { listVendorBankingLedgerEntries, type VendorBankingLedgerEntry } from "@/lib/vendor-banking/ledger.server";

export type VendorStatementLine = VendorBankingLedgerEntry & { runningBalanceCents: number };

export type VendorReconciliationStamp = {
  reconciledAt: string;
  matches: boolean;
  ledgerTotalCents: number;
  stripeTotalCents: number;
} | null;

export type VendorStatement = {
  lines: VendorStatementLine[];
  reconciliation: VendorReconciliationStamp;
};

/** Every ledger line for the vendor (optionally one UTC month), each carrying a running balance — computed once, in order, never per-row from scratch. */
export async function buildVendorStatement(
  db: SupabaseClient,
  vendorUserId: string,
  opts: { month?: string | null } = {},
): Promise<VendorStatement> {
  const entries = await listVendorBankingLedgerEntries(db, vendorUserId, { month: opts.month });
  let running = 0;
  // A month filter still needs the running balance to reflect everything
  // BEFORE that month, so it reads as a real bank statement rather than
  // resetting to 0 every filter change.
  if (opts.month) {
    const all = await listVendorBankingLedgerEntries(db, vendorUserId, {});
    const monthStartId = entries[0]?.id;
    for (const row of all) {
      if (row.id === monthStartId) break;
      running += row.amountCents;
    }
  }
  const lines: VendorStatementLine[] = entries.map((entry) => {
    running += entry.amountCents;
    return { ...entry, runningBalanceCents: running };
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

  return { lines, reconciliation };
}

const KIND_LABEL: Record<VendorBankingLedgerEntry["kind"], string> = {
  charge: "Charge",
  platform_fee: PROPLANE_SERVICE_FEE_LABEL,
  hold: "Held",
  transfer: "Transfer",
  withdrawal: "Withdrawal",
  refund: "Refund",
  adjustment: "Adjustment",
};

export function vendorStatementCsv(statement: VendorStatement): string {
  const header = ["Date", "Type", "Description", "Amount", "Running balance"];
  const rows = statement.lines.map((line) => [
    line.createdAt,
    KIND_LABEL[line.kind],
    line.description.replace(/"/g, '""'),
    (line.amountCents / 100).toFixed(2),
    (line.runningBalanceCents / 100).toFixed(2),
  ]);
  return [header, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(",")).join("\n");
}
