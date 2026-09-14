import type { SupabaseClient } from "@supabase/supabase-js";
import { chartAccountLabel } from "@/lib/reports/categories";
import { primeSystemChartOfAccounts, systemChartAccountByCode } from "@/lib/reports/chart-of-accounts-store";
import { centsToUsd } from "@/lib/reports/money";
import type { ManagerReportFilters, ReportResult } from "@/lib/reports/types";
import { applyReportPropertyScope } from "@/lib/reports/workspace-scope";

function defaultDateRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const toDate = to?.trim() || now.toISOString().slice(0, 10);
  const fromDate = from?.trim() || new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}

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
  source_id: string;
  property_id: string | null;
  gl_journal_lines: JournalLineRow[] | null;
};

function accountBalanceCents(accountCode: string, debitTotal: number, creditTotal: number): number {
  const acct = systemChartAccountByCode(accountCode);
  const normal = acct?.normalBalance ?? "debit";
  return normal === "credit" ? creditTotal - debitTotal : debitTotal - creditTotal;
}

async function loadJournalEntriesThrough(
  db: SupabaseClient,
  managerUserId: string,
  to: string,
  filters: ManagerReportFilters,
): Promise<JournalEntryRow[]> {
  let query = db
    .from("gl_journal_entries")
    .select("id, entry_date, memo, source_type, source_id, property_id, gl_journal_lines(account_code, debit_cents, credit_cents)")
    .eq("manager_user_id", managerUserId)
    .eq("is_reversal", false)
    .lte("entry_date", to)
    .order("entry_date", { ascending: true })
    .limit(5000);

  query = applyReportPropertyScope(query, filters);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data as JournalEntryRow[] | null) ?? [];
}

function aggregateAccountTotals(entries: JournalEntryRow[]): Map<string, { debits: number; credits: number }> {
  const totals = new Map<string, { debits: number; credits: number }>();
  for (const entry of entries) {
    for (const line of entry.gl_journal_lines ?? []) {
      const code = String(line.account_code);
      const cur = totals.get(code) ?? { debits: 0, credits: 0 };
      cur.debits += Number(line.debit_cents);
      cur.credits += Number(line.credit_cents);
      totals.set(code, cur);
    }
  }
  return totals;
}

export async function queryTrialBalance(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { to } = defaultDateRange(filters.from, filters.to);

  const entries = await loadJournalEntriesThrough(db, managerUserId, to, filters);
  const totals = aggregateAccountTotals(entries);

  const rows: Record<string, string | number | boolean | null>[] = [];
  let totalDebits = 0;
  let totalCredits = 0;

  for (const [code, sums] of [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (sums.debits === 0 && sums.credits === 0) continue;
    totalDebits += sums.debits;
    totalCredits += sums.credits;
    const balance = accountBalanceCents(code, sums.debits, sums.credits);
    rows.push({
      account: chartAccountLabel(code),
      accountCode: code,
      debit: centsToUsd(sums.debits),
      credit: centsToUsd(sums.credits),
      balance: centsToUsd(balance),
    });
  }

  return {
    id: "trial-balance",
    title: "Trial Balance",
    columns: [
      { key: "account", label: "Account" },
      { key: "debit", label: "Debits", align: "right", format: "money" },
      { key: "credit", label: "Credits", align: "right", format: "money" },
      { key: "balance", label: "Balance", align: "right", format: "money" },
    ],
    rows,
    totals: {
      account: "Totals",
      debit: centsToUsd(totalDebits),
      credit: centsToUsd(totalCredits),
      balance: centsToUsd(totalDebits - totalCredits),
    },
    meta: {
      asOf: to,
      balanced: totalDebits === totalCredits,
      totalDebits: centsToUsd(totalDebits),
      totalCredits: centsToUsd(totalCredits),
    },
  };
}

export async function queryBalanceSheet(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { to } = defaultDateRange(filters.from, filters.to);

  const entries = await loadJournalEntriesThrough(db, managerUserId, to, filters);
  const totals = aggregateAccountTotals(entries);

  const rows: Record<string, string | number | boolean | null>[] = [];
  let assetTotal = 0;
  let liabilityTotal = 0;
  let equityTotal = 0;

  for (const [code, sums] of [...totals.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const acct = systemChartAccountByCode(code);
    const type = acct?.accountType;
    if (!type || !["asset", "liability", "equity"].includes(type)) continue;
    const balance = accountBalanceCents(code, sums.debits, sums.credits);
    if (balance === 0) continue;

    if (type === "asset") assetTotal += balance;
    else if (type === "liability") liabilityTotal += balance;
    else equityTotal += balance;

    rows.push({
      section: type === "asset" ? "Assets" : type === "liability" ? "Liabilities" : "Equity",
      account: chartAccountLabel(code),
      amount: centsToUsd(balance),
    });
  }

  rows.sort((a, b) => `${a.section}-${a.account}`.localeCompare(`${b.section}-${b.account}`));

  rows.push({
    section: "",
    account: "Total liabilities + equity",
    amount: centsToUsd(liabilityTotal + equityTotal),
    _isTotal: true,
  });

  return {
    id: "balance-sheet",
    title: "Balance Sheet",
    columns: [
      { key: "section", label: "Section" },
      { key: "account", label: "Account" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
    ],
    rows,
    meta: {
      asOf: to,
      assets: centsToUsd(assetTotal),
      liabilities: centsToUsd(liabilityTotal),
      equity: centsToUsd(equityTotal),
      balanced: assetTotal === liabilityTotal + equityTotal,
    },
  };
}

export async function queryGeneralLedger(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { from, to } = defaultDateRange(filters.from, filters.to);

  let query = db
    .from("gl_journal_entries")
    .select(
      "id, entry_date, memo, source_type, source_id, property_id, gl_journal_lines(account_code, debit_cents, credit_cents, memo)",
    )
    .eq("manager_user_id", managerUserId)
    .eq("is_reversal", false)
    .gte("entry_date", from)
    .lte("entry_date", to)
    .order("entry_date", { ascending: true })
    .limit(5000);

  query = applyReportPropertyScope(query, filters);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const rows: Record<string, string | number | boolean | null>[] = [];
  for (const entry of (data as JournalEntryRow[] | null) ?? []) {
    for (const line of entry.gl_journal_lines ?? []) {
      rows.push({
        date: entry.entry_date,
        source: entry.source_type,
        sourceId: entry.source_id,
        account: chartAccountLabel(line.account_code),
        memo: line.memo ?? entry.memo ?? "",
        debit: Number(line.debit_cents) > 0 ? centsToUsd(line.debit_cents) : "",
        credit: Number(line.credit_cents) > 0 ? centsToUsd(line.credit_cents) : "",
      });
    }
  }

  return {
    id: "general-ledger",
    title: "General Ledger",
    columns: [
      { key: "date", label: "Date", format: "date" },
      { key: "account", label: "Account" },
      { key: "memo", label: "Memo" },
      { key: "debit", label: "Debit", align: "right", format: "money" },
      { key: "credit", label: "Credit", align: "right", format: "money" },
      { key: "source", label: "Source" },
    ],
    rows,
    meta: { from, to },
  };
}

const CASH_ACCOUNTS = new Set([
  "operating_cash",
  "trust_account_rental_ops",
  "trust_account_security_deposits",
]);

export async function queryCashFlowStatement(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { from, to } = defaultDateRange(filters.from, filters.to);

  let query = db
    .from("gl_journal_entries")
    .select("entry_date, gl_journal_lines(account_code, debit_cents, credit_cents)")
    .eq("manager_user_id", managerUserId)
    .eq("is_reversal", false)
    .gte("entry_date", from)
    .lte("entry_date", to)
    .limit(5000);

  query = applyReportPropertyScope(query, filters);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let inflows = 0;
  let outflows = 0;

  for (const entry of (data as JournalEntryRow[] | null) ?? []) {
    for (const line of entry.gl_journal_lines ?? []) {
      if (!CASH_ACCOUNTS.has(line.account_code)) continue;
      inflows += Number(line.debit_cents);
      outflows += Number(line.credit_cents);
    }
  }

  const net = inflows - outflows;

  return {
    id: "cash-flow-statement",
    title: "Cash Flow Statement",
    columns: [
      { key: "line", label: "Line" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
    ],
    rows: [
      { line: "Cash inflows", amount: centsToUsd(inflows) },
      { line: "Cash outflows", amount: centsToUsd(outflows) },
      { line: "Net cash change", amount: centsToUsd(net), _isTotal: true },
    ],
    meta: {
      from,
      to,
      note: "Simplified cash-basis view from bank/trust GL accounts; accrual adjustments land in a later phase.",
      netCash: centsToUsd(net),
    },
  };
}

export async function queryPayoutHistory(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const { from, to } = defaultDateRange(filters.from, filters.to);

  const { data, error } = await db
    .from("stripe_payouts")
    .select("stripe_payout_id, amount_cents, currency, status, arrival_date, failure_message, created_at")
    .eq("manager_user_id", managerUserId)
    .gte("created_at", `${from}T00:00:00.000Z`)
    .lte("created_at", `${to}T23:59:59.999Z`)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) throw new Error(error.message);

  const rows = (data ?? []).map((row) => ({
    date: String(row.created_at ?? "").slice(0, 10),
    payoutId: row.stripe_payout_id,
    amount: centsToUsd(Number(row.amount_cents)),
    status: row.status,
    arrivalDate: row.arrival_date ?? "",
    note: row.failure_message ?? "",
  }));

  return {
    id: "payout-history",
    title: "Payout History",
    columns: [
      { key: "date", label: "Date", format: "date" },
      { key: "payoutId", label: "Payout ID" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
      { key: "status", label: "Status" },
      { key: "arrivalDate", label: "Arrival", format: "date" },
      { key: "note", label: "Note" },
    ],
    rows,
    meta: { from, to, count: rows.length },
  };
}

const TRUST_LIABILITY_CODE = "security_deposit_liability";
const TRUST_CASH_CODE = "trust_account_security_deposits";

function glLiabilityBalanceCents(totals: Map<string, { debits: number; credits: number }>, code: string): number {
  const sums = totals.get(code) ?? { debits: 0, credits: 0 };
  return sums.credits - sums.debits;
}

function glAssetBalanceCents(totals: Map<string, { debits: number; credits: number }>, code: string): number {
  const sums = totals.get(code) ?? { debits: 0, credits: 0 };
  return sums.debits - sums.credits;
}

export async function queryTrustAccountBalance(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { to } = defaultDateRange(filters.from, filters.to);

  const entries = await loadJournalEntriesThrough(db, managerUserId, to, filters);
  const totals = aggregateAccountTotals(entries);

  const glTrustCashCents = glAssetBalanceCents(totals, TRUST_CASH_CODE);
  const glLiabilityCents = glLiabilityBalanceCents(totals, TRUST_LIABILITY_CODE);

  const { sumHeldDepositsCents } = await import("@/lib/reports/security-deposits");
  const subLedgerCents = await sumHeldDepositsCents(db, managerUserId, filters);

  let bankBalanceCents = glTrustCashCents;
  const { data: trustAccounts } = await db
    .from("manager_bank_accounts")
    .select("id")
    .eq("manager_user_id", managerUserId)
    .eq("account_type", "trust_security_deposit")
    .eq("is_active", true)
    .limit(5);

  if (trustAccounts && trustAccounts.length > 0) {
    const accountIds = trustAccounts.map((a) => String(a.id));
    const { data: statements } = await db
      .from("manager_bank_statements")
      .select("closing_balance_cents")
      .in("bank_account_id", accountIds)
      .order("statement_date", { ascending: false })
      .limit(1);
    if (statements?.[0]) bankBalanceCents = Number(statements[0].closing_balance_cents);
  }

  const bankVsGl = bankBalanceCents - glTrustCashCents;
  const glVsSub = glLiabilityCents - subLedgerCents;
  const balanced = bankVsGl === 0 && glVsSub === 0;

  const rows = [
    { line: "Trust bank balance", source: "Bank statement (or GL trust cash)", amount: centsToUsd(bankBalanceCents), status: bankVsGl === 0 ? "Matched" : "Mismatch" },
    { line: "GL trust cash account", source: TRUST_CASH_CODE, amount: centsToUsd(glTrustCashCents), status: bankVsGl === 0 ? "Matched" : `Δ ${centsToUsd(Math.abs(bankVsGl))}` },
    { line: "GL deposit liability", source: TRUST_LIABILITY_CODE, amount: centsToUsd(glLiabilityCents), status: glVsSub === 0 ? "Matched" : `Δ ${centsToUsd(Math.abs(glVsSub))}` },
    { line: "Deposit sub-ledger total held", source: "security_deposit_ledger", amount: centsToUsd(subLedgerCents), status: glVsSub === 0 ? "Matched" : `Δ ${centsToUsd(Math.abs(glVsSub))}` },
  ];

  return {
    id: "trust-account-balance",
    title: "Trust Account Balance",
    columns: [
      { key: "line", label: "Line" },
      { key: "source", label: "Source" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
      { key: "status", label: "Status" },
    ],
    rows,
    meta: { to, balanced, note: balanced ? "Three-way trust check passed." : "Trust account mismatch detected." },
  };
}

export async function queryFinancialDiagnostics(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { to } = defaultDateRange(filters.from, filters.to);
  const rows: Record<string, string | boolean>[] = [];

  const entries = await loadJournalEntriesThrough(db, managerUserId, to, filters);
  const totals = aggregateAccountTotals(entries);
  let totalDebits = 0;
  let totalCredits = 0;
  for (const sums of totals.values()) {
    totalDebits += sums.debits;
    totalCredits += sums.credits;
  }
  if (totalDebits !== totalCredits) {
    rows.push({
      severity: "high",
      issue: "Unbalanced journal entries",
      detail: `Debits ${centsToUsd(totalDebits)} ≠ credits ${centsToUsd(totalCredits)}`,
      action: "Run trial balance",
    });
  }

  const trustReport = await queryTrustAccountBalance(db, managerUserId, filters);
  if (trustReport.meta?.balanced === false) {
    rows.push({
      severity: "high",
      issue: "Trust / deposit liability mismatch",
      detail: String(trustReport.meta?.note ?? ""),
      action: "Open Trust Account Balance report",
    });
  }

  const { reclassifyMisclassifiedDeposits } = await import("@/lib/reports/security-deposits");
  const reclassifyPreview = await reclassifyMisclassifiedDeposits(db, managerUserId, { dryRun: true });
  if (reclassifyPreview.rowCount > 0) {
    rows.push({
      severity: "medium",
      issue: "Misclassified historical security deposits",
      detail: `${reclassifyPreview.rowCount} payment(s), ${centsToUsd(reclassifyPreview.totalCents)} as income`,
      action: "Run deposit reclassification",
    });
  }

  const { data: expiredDocs } = await db
    .from("manager_documents")
    .select("id")
    .eq("manager_user_id", managerUserId)
    .eq("category", "insurance")
    .is("deleted_at", null)
    .lt("expires_at", to)
    .limit(20);
  if ((expiredDocs ?? []).length > 0) {
    rows.push({
      severity: "medium",
      issue: "Expired insurance documents",
      detail: `${expiredDocs!.length}+ expired insurance file(s)`,
      action: "Review Documents library",
    });
  }

  if (rows.length === 0) {
    rows.push({ severity: "ok", issue: "No issues flagged", detail: "Books look healthy", action: "—" });
  }

  return {
    id: "financial-diagnostics",
    title: "Financial Diagnostics",
    columns: [
      { key: "severity", label: "Severity" },
      { key: "issue", label: "Issue" },
      { key: "detail", label: "Detail" },
      { key: "action", label: "Suggested action" },
    ],
    rows,
    meta: { to, issueCount: rows.filter((r) => r.severity !== "ok").length },
  };
}
