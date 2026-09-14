import type { SupabaseClient } from "@supabase/supabase-js";
import { chartAccountLabel } from "@/lib/reports/categories";
import { primeSystemChartOfAccounts } from "@/lib/reports/chart-of-accounts-store";
import { apAgingBucket } from "@/lib/manager-bills";
import { centsToUsd } from "@/lib/reports/money";
import type { ManagerReportFilters, ReportResult } from "@/lib/reports/types";
import { applyReportPropertyScope } from "@/lib/reports/workspace-scope";

function defaultDateRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const toDate = to?.trim() || now.toISOString().slice(0, 10);
  const fromDate = from?.trim() || new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}

export async function queryApAging(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  let query = db
    .from("manager_bills")
    .select("id, description, vendor_id, amount_cents, due_date, status, property_id")
    .eq("manager_user_id", managerUserId)
    .in("status", ["approved", "scheduled", "pending_approval"])
    .order("due_date", { ascending: true })
    .limit(500);

  query = applyReportPropertyScope(query, filters);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const today = new Date();
  const rows = (data ?? []).map((row) => {
    const due = row.due_date ? new Date(`${String(row.due_date).slice(0, 10)}T12:00:00`) : today;
    const daysPast = Math.floor((today.getTime() - due.getTime()) / (24 * 60 * 60 * 1000));
    return {
      billId: row.id,
      description: row.description,
      vendor: row.vendor_id ?? "—",
      dueDate: row.due_date ? String(row.due_date).slice(0, 10) : "—",
      bucket: apAgingBucket(daysPast),
      amount: centsToUsd(Number(row.amount_cents)),
      status: row.status,
    };
  });

  return {
    id: "ap-aging",
    title: "AP Aging",
    columns: [
      { key: "description", label: "Bill" },
      { key: "vendor", label: "Vendor" },
      { key: "dueDate", label: "Due", format: "date" },
      { key: "bucket", label: "Aging" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
      { key: "status", label: "Status" },
    ],
    rows,
    meta: { count: rows.length },
  };
}

export async function queryBudgetVsActual(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const fiscalYear = filters.taxYear ?? new Date().getFullYear();
  const { from, to } = defaultDateRange(`${fiscalYear}-01-01`, `${fiscalYear}-12-31`);

  let budgetQuery = db
    .from("manager_budgets")
    .select("category_code, monthly_amounts_cents, property_id")
    .eq("manager_user_id", managerUserId)
    .eq("fiscal_year", fiscalYear);
  budgetQuery = applyReportPropertyScope(budgetQuery, filters);

  let expenseQuery = db
    .from("manager_expense_entries")
    .select("category_code, amount_cents, expense_date")
    .eq("manager_user_id", managerUserId)
    .gte("expense_date", from)
    .lte("expense_date", to);
  expenseQuery = applyReportPropertyScope(expenseQuery, filters);

  const [{ data: budgets }, { data: expenses }] = await Promise.all([budgetQuery, expenseQuery]);

  const budgetByCat = new Map<string, number>();
  for (const row of budgets ?? []) {
    const monthly = row.monthly_amounts_cents as Record<string, number> | null;
    const annual = monthly
      ? Object.values(monthly).reduce((s, v) => s + Number(v), 0)
      : 0;
    const code = String(row.category_code);
    budgetByCat.set(code, (budgetByCat.get(code) ?? 0) + annual);
  }

  const actualByCat = new Map<string, number>();
  for (const row of expenses ?? []) {
    const code = String(row.category_code);
    actualByCat.set(code, (actualByCat.get(code) ?? 0) + Number(row.amount_cents));
  }

  const codes = new Set([...budgetByCat.keys(), ...actualByCat.keys()]);
  const rows = [...codes].sort().map((code) => {
    const budget = budgetByCat.get(code) ?? 0;
    const actual = actualByCat.get(code) ?? 0;
    return {
      category: chartAccountLabel(code),
      budget: centsToUsd(budget),
      actual: centsToUsd(actual),
      variance: centsToUsd(actual - budget),
    };
  });

  return {
    id: "budget-vs-actual",
    title: "Budget vs Actual",
    columns: [
      { key: "category", label: "Category" },
      { key: "budget", label: "Budget", align: "right", format: "money" },
      { key: "actual", label: "Actual", align: "right", format: "money" },
      { key: "variance", label: "Variance", align: "right", format: "money" },
    ],
    rows,
    meta: { fiscalYear, from, to },
  };
}

export async function queryOwnerStatement(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const propertyId = filters.propertyId ?? "";

  let incomeQuery = db
    .from("ledger_entries")
    .select("amount_cents, category_code")
    .eq("manager_user_id", managerUserId)
    .eq("entry_type", "payment")
    .gte("posted_date", from)
    .lte("posted_date", to);
  incomeQuery = applyReportPropertyScope(incomeQuery, filters, propertyId);

  let expenseQuery = db
    .from("manager_expense_entries")
    .select("amount_cents")
    .eq("manager_user_id", managerUserId)
    .gte("expense_date", from)
    .lte("expense_date", to);
  expenseQuery = applyReportPropertyScope(expenseQuery, filters, propertyId);

  let billsQuery = db
    .from("manager_bills")
    .select("amount_cents")
    .eq("manager_user_id", managerUserId)
    .in("status", ["approved", "scheduled", "pending_approval"]);
  billsQuery = applyReportPropertyScope(billsQuery, filters, propertyId);

  const [{ data: incomeRows }, { data: expenseRows }, { data: billRows }] = await Promise.all([
    incomeQuery,
    expenseQuery,
    billsQuery,
  ]);

  const cashIn = (incomeRows ?? []).reduce((s, r) => s + Number(r.amount_cents), 0);
  const cashOut = (expenseRows ?? []).reduce((s, r) => s + Number(r.amount_cents), 0);
  const billsDue = (billRows ?? []).reduce((s, r) => s + Number(r.amount_cents), 0);
  const managementFee = 0;
  const reserveHoldback = 0;
  const distribution = cashIn - cashOut - managementFee - reserveHoldback;

  const rows = [
    { line: "Cash in (collections)", amount: centsToUsd(cashIn) },
    { line: "Cash out (expenses paid)", amount: centsToUsd(-cashOut) },
    { line: "Management fee", amount: centsToUsd(-managementFee) },
    { line: "Reserve holdback", amount: centsToUsd(-reserveHoldback) },
    { line: "Distribution", amount: centsToUsd(distribution) },
    { line: "Bills due (unpaid AP)", amount: centsToUsd(billsDue) },
  ];

  return {
    id: "owner-statement",
    title: "Owner Statement",
    columns: [
      { key: "line", label: "Line" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
    ],
    rows,
    meta: { from, to, propertyId: propertyId || null, distribution: centsToUsd(distribution) },
  };
}
