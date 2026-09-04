/**
 * QuickBooks Online journal-entry CSV export.
 * Maps Axis GL journal lines to QBO-compatible columns so managers can import
 * rent, expenses, and work-order costs without manual consolidation.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { escapeCsv } from "@/lib/csv";
import { primeSystemChartOfAccounts, systemChartAccountByCode } from "@/lib/reports/chart-of-accounts-store";
import { centsToUsd } from "@/lib/reports/money";
import type { ManagerReportFilters } from "@/lib/reports/types";

type JournalLineRow = {
  account_code: string;
  debit_cents: number;
  credit_cents: number;
  memo?: string | null;
};

type JournalEntryRow = {
  id: string;
  entry_date: string;
  memo: string | null;
  source_type: string;
  gl_journal_lines: JournalLineRow[] | null;
};

function defaultDateRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const toDate = to?.trim() || now.toISOString().slice(0, 10);
  const fromDate = from?.trim() || new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}


function qbAccountName(code: string): string {
  const acct = systemChartAccountByCode(code);
  const num = acct?.accountNumber;
  const name = acct?.name ?? code;
  return num != null ? `${num} ${name}` : name;
}

async function loadJournalEntriesInRange(
  db: SupabaseClient,
  managerUserId: string,
  from: string,
  to: string,
  propertyId?: string,
): Promise<JournalEntryRow[]> {
  let query = db
    .from("gl_journal_entries")
    .select("id, entry_date, memo, source_type, gl_journal_lines(account_code, debit_cents, credit_cents, memo)")
    .eq("manager_user_id", managerUserId)
    .eq("is_reversal", false)
    .gte("entry_date", from)
    .lte("entry_date", to)
    .order("entry_date", { ascending: true })
    .limit(5000);

  if (propertyId) query = query.eq("property_id", propertyId);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as JournalEntryRow[] | null) ?? [];
}

/** Build a QuickBooks journal-entry CSV from Axis GL data. */
export async function buildQuickBooksJournalCsv(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<string> {
  await primeSystemChartOfAccounts(db);
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const entries = await loadJournalEntriesInRange(db, managerUserId, from, to, filters.propertyId);

  const header = [
    "Journal No",
    "Journal Date",
    "Account",
    "Debits",
    "Credits",
    "Description",
    "Name",
    "Source",
  ]
    .map(escapeCsv)
    .join(",");

  const rows: string[] = [];
  for (const entry of entries) {
    const journalNo = entry.id.slice(0, 8);
    const date = entry.entry_date;
    const baseMemo = (entry.memo ?? "").trim() || entry.source_type.replace(/_/g, " ");
    for (const line of entry.gl_journal_lines ?? []) {
      const debit = Number(line.debit_cents) || 0;
      const credit = Number(line.credit_cents) || 0;
      if (debit === 0 && credit === 0) continue;
      const lineMemo = (line.memo ?? "").trim();
      rows.push(
        [
          journalNo,
          date,
          qbAccountName(String(line.account_code)),
          debit > 0 ? centsToUsd(debit) : "",
          credit > 0 ? centsToUsd(credit) : "",
          lineMemo || baseMemo,
          "",
          entry.source_type,
        ]
          .map((v) => escapeCsv(String(v)))
          .join(","),
      );
    }
  }

  return [header, ...rows].join("\n");
}
