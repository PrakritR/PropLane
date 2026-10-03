import { summarizeFinancialActivity } from "../financial-activity-totals";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyReportPropertyScope } from "@/lib/reports/workspace-scope";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import { chartAccountLabel } from "@/lib/reports/categories";
import { primeSystemChartOfAccounts, systemChartAccountByCode } from "@/lib/reports/chart-of-accounts-store";
import { centsToUsd } from "@/lib/reports/money";
import type { ManagerReportFilters, ReportResult } from "@/lib/reports/types";

/** Read recorded cash events only. Charges and bank transfers never become income. */
export async function queryFinancialActivity(db: SupabaseClient, managerUserId: string, filters: ManagerReportFilters): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const display = await loadManagerReportDisplayContext(db, managerUserId);
  const from = filters.from || "1900-01-01";
  const to = filters.to || "9999-12-31";
  let receipts = db.from("ledger_entries")
    .select("id, posted_date, description, amount_cents, category_code, property_id, resident_email, entry_type")
    .eq("manager_user_id", managerUserId).in("entry_type", ["payment", "refund"])
    .gte("posted_date", from).lte("posted_date", to);
  receipts = applyReportPropertyScope(receipts, filters);
  let expenses = db.from("manager_expense_entries")
    .select("id, expense_date, memo, amount_cents, category_code, property_id, vendor_id, source_work_order_id")
    .eq("manager_user_id", managerUserId).gte("expense_date", from).lte("expense_date", to);
  expenses = applyReportPropertyScope(expenses, filters);
  receipts = receipts.order("id", { ascending: true });
  expenses = expenses.order("id", { ascending: true });
  const rows: ReportResult["rows"] = [];
  // Page rather than silently accepting the PostgREST row cap as a complete ledger.
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await receipts.range(offset, offset + 499);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const cents = (row.entry_type === "refund" ? -1 : 1) * Math.abs(Number(row.amount_cents));
      rows.push({ id: `ledger-${row.id}`, date: row.posted_date, description: row.description || chartAccountLabel(row.category_code), amountCents: cents, amount: centsToUsd(cents), category: chartAccountLabel(row.category_code), categoryCode: row.category_code, accountType: systemChartAccountByCode(row.category_code)?.accountType ?? "unclassified", property: display.propertyLabel(row.property_id), propertyId: row.property_id, who: display.residentLabel(row.resident_email), source: "Resident payment", entryType: row.entry_type });
    }
    if (!data || data.length < 500) break;
  }
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await expenses.range(offset, offset + 499);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const cents = -Math.abs(Number(row.amount_cents));
      rows.push({ id: `expense-${row.id}`, date: row.expense_date, description: row.memo || chartAccountLabel(row.category_code), amountCents: cents, amount: centsToUsd(cents), category: chartAccountLabel(row.category_code), categoryCode: row.category_code, accountType: systemChartAccountByCode(row.category_code)?.accountType ?? "unclassified", property: display.propertyLabel(row.property_id), propertyId: row.property_id, who: display.vendorLabel(row.vendor_id), source: row.source_work_order_id ? "Service expense" : "Outside PropLane", entryType: "expense" });
    }
    if (!data || data.length < 500) break;
  }
  let heldDepositsCents = 0;
  let deposits = db.from("security_deposit_ledger").select("id, amount_held_cents").eq("manager_user_id", managerUserId).order("id", { ascending: true });
  deposits = applyReportPropertyScope(deposits, filters);
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await deposits.range(offset, offset + 499);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const amount = Number(row.amount_held_cents);
      if (!Number.isSafeInteger(amount)) throw new Error("Invalid deposit amount.");
      heldDepositsCents += amount;
      if (!Number.isSafeInteger(heldDepositsCents)) throw new Error("Deposit total exceeds supported precision.");
    }
    if (!data || data.length < 500) break;
  }
  rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
  return { id: "financial-activity", title: "Ledger", columns: [
    { key: "date", label: "Date", format: "date" }, { key: "who", label: "Who" }, { key: "description", label: "Description" },
    { key: "property", label: "Property" }, { key: "category", label: "Category" }, { key: "source", label: "Source" }, { key: "amount", label: "Amount", format: "money", align: "right" },
  ], rows, meta: { from, to, summary: JSON.stringify({ ...summarizeFinancialActivity(rows), heldDepositsCents }) } };
}

/** The month report uses the same cash classification as Overview and Dashboard. */
export async function queryMonthlyProfitLoss(db: SupabaseClient, managerUserId: string, filters: ManagerReportFilters): Promise<ReportResult> {
  const activity = await queryFinancialActivity(db, managerUserId, filters);
  const summary = summarizeFinancialActivity(activity.rows);
  const months = Object.entries(summary.months).sort(([a], [b]) => a.localeCompare(b));
  let revenue = 0;
  let expense = 0;
  const rows = months.map(([month, totals]) => {
    revenue += totals.revenueCents;
    expense += totals.expenseCents;
    if (![revenue, expense, revenue - expense].every(Number.isSafeInteger)) throw new Error("Report total exceeds supported precision.");
    return { month, revenue: centsToUsd(totals.revenueCents), expenses: centsToUsd(totals.expenseCents), profit: centsToUsd(totals.profitCents), margin: totals.revenueCents ? `${(totals.profitCents / totals.revenueCents * 100).toFixed(1)}%` : "—" };
  });
  return { id: "monthly-profit-loss", title: "Profit and loss by month", columns: [
    { key: "month", label: "Month" }, { key: "revenue", label: "Revenue", format: "money", align: "right" },
    { key: "expenses", label: "Expenses", format: "money", align: "right" }, { key: "profit", label: "Profit", format: "money", align: "right" }, { key: "margin", label: "Margin", align: "right" },
  ], rows, totals: { month: "Total", revenue: centsToUsd(revenue), expenses: centsToUsd(expense), profit: centsToUsd(revenue - expense), margin: revenue ? `${((revenue - expense) / revenue * 100).toFixed(1)}%` : "—" } };
}
