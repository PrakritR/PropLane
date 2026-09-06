import type { SupabaseClient } from "@supabase/supabase-js";
import type { HouseholdCharge, RecurringRentProfile } from "@/lib/household-charges";
import {
  chartAccountLabel,
  chartAccountScheduleE,
  expenseTaxStatusLabel,
  resolveExpenseTaxDeductible,
} from "@/lib/reports/categories";
import { primeSystemChartOfAccounts, systemChartAccountByCode } from "@/lib/reports/chart-of-accounts-store";
import { humanizeUnitLabel, loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import { scopeLabel } from "@/lib/reports/formal-documents/spec";
import { centsToUsd, dollarsToCents } from "@/lib/reports/money";
import { resolveDocumentScope } from "@/lib/reports/parse-filters";
import type { DocumentScope, ManagerReportFilters, ReportResult } from "@/lib/reports/types";
import { parseMoneyAmount } from "@/lib/parse-money";
import { rentMonthlyEquivalent } from "@/lib/room-pricing";
import {
  queryBalanceSheet,
  queryCashFlowStatement,
  queryGeneralLedger,
  queryTrialBalance,
  queryPayoutHistory,
  queryTrustAccountBalance,
  queryFinancialDiagnostics,
} from "@/lib/reports/queries/gl-reports";
import {
  queryApAging,
  queryBudgetVsActual,
  queryOwnerStatement,
} from "@/lib/reports/queries/ap-reports";

function defaultDateRange(from?: string, to?: string): { from: string; to: string } {
  const now = new Date();
  const toDate = to?.trim() || now.toISOString().slice(0, 10);
  const fromDate =
    from?.trim() ||
    new Date(now.getFullYear(), 0, 1).toISOString().slice(0, 10);
  return { from: fromDate, to: toDate };
}

function daysInclusive(from: Date, to: Date): number {
  if (to < from) return 0;
  return Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

const RENT_RECEIPT_CATEGORIES = new Set(["rent_income", "late_fees", "pet_rent", "application_fee", "other_income"]);

async function loadCharges(db: SupabaseClient, managerUserId: string, propertyId?: string) {
  let query = db
    .from("portal_household_charge_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .limit(2000);
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data } = await query;
  return (data ?? []).map((r) => r.row_data as HouseholdCharge).filter(Boolean);
}

async function loadRentProfiles(db: SupabaseClient, managerUserId: string, propertyId?: string) {
  let query = db
    .from("portal_recurring_rent_profile_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .limit(500);
  if (propertyId) query = query.eq("property_id", propertyId);
  const { data } = await query;
  return (data ?? [])
    .map((r) => r.row_data as RecurringRentProfile)
    .filter((p) => p?.active !== false);
}

type ExpenseWorkOrderRef = {
  id: string;
  residentEmail?: string;
  assignedRoomChoice?: string;
  unit?: string;
};

async function loadExpenseWorkOrders(db: SupabaseClient, managerUserId: string): Promise<Map<string, ExpenseWorkOrderRef>> {
  const { data } = await db
    .from("portal_work_order_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId)
    .limit(2000);
  const map = new Map<string, ExpenseWorkOrderRef>();
  for (const row of data ?? []) {
    const payload = row.row_data as ExpenseWorkOrderRef | null;
    if (!payload) continue;
    map.set(String(row.id), { ...payload, id: String(row.id) });
  }
  return map;
}

function roomLabelsMatch(a: string, b: string): boolean {
  const left = a.trim();
  const right = b.trim();
  if (!left || !right) return false;
  if (left.toLowerCase() === right.toLowerCase()) return true;
  return humanizeUnitLabel(left) === humanizeUnitLabel(right);
}

function expenseMatchesScope(
  expense: { property_id?: string | null; source_work_order_id?: string | null },
  scope: DocumentScope,
  filters: ManagerReportFilters,
  workOrdersById: Map<string, ExpenseWorkOrderRef>,
): boolean {
  const propertyId = filters.propertyId?.trim();

  if (scope === "portfolio") return true;

  if (scope === "property") {
    return propertyId ? String(expense.property_id ?? "") === propertyId : true;
  }

  if (propertyId && String(expense.property_id ?? "") !== propertyId) return false;

  if (scope === "tenant") {
    const email = filters.residentEmail?.trim().toLowerCase();
    if (!email) return true;
    const workOrderId = expense.source_work_order_id?.trim();
    if (!workOrderId) return true;
    const workOrder = workOrdersById.get(workOrderId);
    return workOrder ? (workOrder.residentEmail ?? "").trim().toLowerCase() === email : true;
  }

  if (scope === "room") {
    const roomLabel = filters.roomLabel?.trim();
    if (!roomLabel) return true;
    const workOrderId = expense.source_work_order_id?.trim();
    if (!workOrderId) return false;
    const workOrder = workOrdersById.get(workOrderId);
    if (!workOrder) return false;
    const unitRef = (workOrder.assignedRoomChoice ?? workOrder.unit ?? "").trim();
    return roomLabelsMatch(unitRef, roomLabel);
  }

  return true;
}

export async function queryRentRoll(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const profiles = await loadRentProfiles(db, managerUserId, filters.propertyId);
  const charges = await loadCharges(db, managerUserId, filters.propertyId);

  const depositByResident = new Map<string, number>();
  for (const c of charges) {
    if (c.kind !== "security_deposit" || c.status !== "paid") continue;
    const key = c.residentEmail.toLowerCase();
    depositByResident.set(key, (depositByResident.get(key) ?? 0) + dollarsToCents(parseMoneyAmount(c.amountLabel)));
  }

  const rows = profiles.map((p) => ({
    property: p.propertyLabel,
    unit: p.roomLabel || "—",
    resident: p.residentName,
    email: p.residentEmail,
    monthlyRent: centsToUsd(Math.round(rentMonthlyEquivalent(p.monthlyRent, p.dailyRentPrice, p.weeklyRentPrice) * 100)),
    depositHeld: centsToUsd(depositByResident.get(p.residentEmail.toLowerCase()) ?? 0),
    status: p.active ? "Occupied" : "Inactive",
  }));

  const totalRentCents = profiles.reduce(
    (sum, p) => sum + Math.round(rentMonthlyEquivalent(p.monthlyRent, p.dailyRentPrice, p.weeklyRentPrice) * 100),
    0,
  );

  return {
    id: "rent-roll",
    title: "Rent roll",
    columns: [
      { key: "property", label: "Property" },
      { key: "unit", label: "Unit" },
      { key: "resident", label: "Resident" },
      { key: "email", label: "Email" },
      { key: "monthlyRent", label: "Monthly rent", align: "right", format: "money" },
      { key: "depositHeld", label: "Deposit held", align: "right", format: "money" },
      { key: "status", label: "Status" },
    ],
    rows,
    totals: {
      property: "Total",
      unit: "",
      resident: `${rows.length} units`,
      email: "",
      monthlyRent: centsToUsd(totalRentCents),
      depositHeld: "",
      status: "",
    },
  };
}

function agingBucket(daysPastDue: number): string {
  if (daysPastDue <= 0) return "Current";
  if (daysPastDue <= 30) return "1–30 days";
  if (daysPastDue <= 60) return "31–60 days";
  if (daysPastDue <= 90) return "61–90 days";
  return "90+ days";
}

export async function queryDelinquency(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const charges = (await loadCharges(db, managerUserId, filters.propertyId)).filter((c) => c.status === "pending");
  const today = new Date();

  const rows = charges.map((c) => {
    const due = c.dueDateLabel ? new Date(c.dueDateLabel) : new Date(c.createdAt);
    const daysPastDue = Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
    const balanceCents = dollarsToCents(parseMoneyAmount(c.balanceLabel || c.amountLabel));
    return {
      resident: c.residentName,
      property: c.propertyLabel,
      charge: c.title,
      dueDate: due.toISOString().slice(0, 10),
      balance: centsToUsd(balanceCents),
      bucket: agingBucket(daysPastDue),
      daysPastDue,
    };
  }).sort((a, b) => Number(b.daysPastDue) - Number(a.daysPastDue));

  const totalCents = rows.reduce((sum, r) => sum + dollarsToCents(r.balance as string), 0);

  return {
    id: "delinquency",
    title: "Delinquency aging",
    columns: [
      { key: "resident", label: "Resident" },
      { key: "property", label: "Property" },
      { key: "charge", label: "Charge" },
      { key: "dueDate", label: "Due date", format: "date" },
      { key: "balance", label: "Balance", align: "right", format: "money" },
      { key: "bucket", label: "Aging bucket" },
    ],
    rows: rows.map(({ daysPastDue: _, ...rest }) => rest),
    totals: {
      resident: "Total outstanding",
      property: "",
      charge: "",
      dueDate: "",
      balance: centsToUsd(totalCents),
      bucket: "",
    },
  };
}

export async function queryIncomeStatement(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { from, to } = defaultDateRange(filters.from, filters.to);

  let incomeQuery = db
    .from("ledger_entries")
    .select("category_code, amount_cents")
    .eq("manager_user_id", managerUserId)
    .eq("entry_type", "payment")
    .gte("posted_date", from)
    .lte("posted_date", to);
  if (filters.propertyId) incomeQuery = incomeQuery.eq("property_id", filters.propertyId);

  let expenseQuery = db
    .from("manager_expense_entries")
    .select("category_code, amount_cents")
    .eq("manager_user_id", managerUserId)
    .gte("expense_date", from)
    .lte("expense_date", to);
  if (filters.propertyId) expenseQuery = expenseQuery.eq("property_id", filters.propertyId);

  const [{ data: incomeRows }, { data: expenseRows }] = await Promise.all([incomeQuery, expenseQuery]);

  const incomeByCat = new Map<string, number>();
  let excludedLiabilityCents = 0;
  for (const row of incomeRows ?? []) {
    const code = String(row.category_code);
    const acct = systemChartAccountByCode(code);
    const cents = Number(row.amount_cents);
    if (acct && acct.accountType !== "income") {
      excludedLiabilityCents += cents;
      continue;
    }
    incomeByCat.set(code, (incomeByCat.get(code) ?? 0) + cents);
  }

  const expenseByCat = new Map<string, number>();
  for (const row of expenseRows ?? []) {
    const code = String(row.category_code);
    expenseByCat.set(code, (expenseByCat.get(code) ?? 0) + Number(row.amount_cents));
  }

  const rows: Record<string, string | boolean>[] = [];
  let totalIncome = 0;
  let totalExpense = 0;

  for (const [code, cents] of incomeByCat) {
    totalIncome += cents;
    const schedE = chartAccountScheduleE(code);
    rows.push({
      section: "Rental Income",
      category: chartAccountLabel(code),
      scheduleERef: schedE?.ref ?? "Sch. E, Line 3",
      amount: centsToUsd(cents),
    });
  }
  for (const [code, cents] of expenseByCat) {
    totalExpense += cents;
    const schedE = chartAccountScheduleE(code);
    rows.push({
      section: "Operating Expenses",
      category: chartAccountLabel(code),
      scheduleERef: schedE?.ref ?? "Sch. E, Line 19",
      amount: centsToUsd(cents),
    });
  }

  rows.sort((a, b) => `${a.section}-${a.category}`.localeCompare(`${b.section}-${b.category}`));

  // Append Net Operating Income as a visually distinct total row
  rows.push({
    section: "",
    category: "Net Operating Income",
    scheduleERef: "",
    amount: centsToUsd(totalIncome - totalExpense),
    _isTotal: true,
  });

  return {
    id: "income-statement",
    title: "Income Statement (Schedule E)",
    columns: [
      { key: "section", label: "Section" },
      { key: "category", label: "Category" },
      { key: "scheduleERef", label: "Schedule E Ref." },
      { key: "amount", label: "Amount", align: "right", format: "money" },
    ],
    rows,
    meta: {
      from,
      to,
      totalIncome: centsToUsd(totalIncome),
      totalExpense: centsToUsd(totalExpense),
      ...(excludedLiabilityCents > 0
        ? {
            note: `${centsToUsd(excludedLiabilityCents)} in non-income ledger payments (e.g. security deposits) excluded from rental income.`,
          }
        : {}),
    },
  };
}

export async function queryExpenses(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const scope = resolveDocumentScope(filters);
  const propertyId = filters.propertyId?.trim();
  const needsWorkOrders = scope === "tenant" || scope === "room";
  const [display, workOrdersById] = await Promise.all([
    loadManagerReportDisplayContext(db, managerUserId),
    needsWorkOrders ? loadExpenseWorkOrders(db, managerUserId) : Promise.resolve(new Map<string, ExpenseWorkOrderRef>()),
  ]);

  let query = db
    .from("manager_expense_entries")
    .select("*")
    .eq("manager_user_id", managerUserId)
    .gte("expense_date", from)
    .lte("expense_date", to)
    .order("expense_date", { ascending: false })
    // Bound egress on the Supabase free plan (matches loadCharges / loadExpenseWorkOrders).
    .limit(2000);
  if (scope === "property" && propertyId) query = query.eq("property_id", propertyId);
  if ((scope === "tenant" || scope === "room") && propertyId) query = query.eq("property_id", propertyId);

  const { data } = await query;
  const filtered = (data ?? []).filter((expense) => expenseMatchesScope(expense, scope, filters, workOrdersById));
  const rows = filtered.map((e) => {
    const taxDeductible = resolveExpenseTaxDeductible(e.category_code, e.tax_deductible);
    return {
      id: e.id,
      date: e.expense_date,
      category: chartAccountLabel(e.category_code),
      categoryCode: e.category_code,
      scheduleERef: chartAccountScheduleE(e.category_code)?.ref ?? "Sch. E, Line 19",
      taxStatus: expenseTaxStatusLabel(taxDeductible),
      taxDeductible,
      amount: centsToUsd(Number(e.amount_cents)),
      amountCents: Number(e.amount_cents),
      vendor: display.vendorLabel(e.vendor_id),
      vendorId: e.vendor_id ?? "",
      memo: e.memo ?? "",
      property: display.propertyLabel(e.property_id),
      propertyId: e.property_id ?? "",
      workOrderId: e.source_work_order_id ?? "",
    };
  });

  const totalCents = filtered.reduce((sum, e) => sum + Number(e.amount_cents), 0);
  const propertyLabel = propertyId ? display.propertyLabel(propertyId) : undefined;
  const tenantLabel = filters.residentEmail ? display.residentLabel(filters.residentEmail) : undefined;

  return {
    id: "expenses",
    title: "Property Expense Register (Schedule E)",
    columns: [
      { key: "date", label: "Date", format: "date" },
      { key: "category", label: "Category" },
      { key: "scheduleERef", label: "Sch. E Line" },
      { key: "taxStatus", label: "Tax status" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
      { key: "vendor", label: "Vendor" },
      { key: "memo", label: "Description" },
      { key: "property", label: "Property" },
    ],
    rows,
    totals: { date: "Total expenses", category: "", scheduleERef: "", taxStatus: "", amount: centsToUsd(totalCents), vendor: "", memo: "", property: "" },
    meta: {
      from,
      to,
      scope,
      scopeLabel: scopeLabel(scope, propertyLabel, tenantLabel, filters.roomLabel),
    },
  };
}

export async function queryRentReceipts(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  await primeSystemChartOfAccounts(db);
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const displayPromise = loadManagerReportDisplayContext(db, managerUserId);

  let query = db
    .from("ledger_entries")
    .select("posted_date, description, amount_cents, category_code, property_id, resident_email")
    .eq("manager_user_id", managerUserId)
    .eq("entry_type", "payment")
    .gte("posted_date", from)
    .lte("posted_date", to)
    .order("posted_date", { ascending: false });
  if (filters.propertyId) query = query.eq("property_id", filters.propertyId);

  const [{ data }, display] = await Promise.all([query, displayPromise]);
  const rows = (data ?? [])
    .filter((row) => RENT_RECEIPT_CATEGORIES.has(String(row.category_code)))
    .map((row) => ({
      date: row.posted_date,
      description: row.description?.trim() || chartAccountLabel(String(row.category_code)),
      amount: centsToUsd(Number(row.amount_cents)),
      category: chartAccountLabel(String(row.category_code)),
      property: display.propertyLabel(row.property_id),
      resident: display.residentLabel(row.resident_email),
    }));

  const totalCents = (data ?? [])
    .filter((row) => RENT_RECEIPT_CATEGORIES.has(String(row.category_code)))
    .reduce((sum, row) => sum + Number(row.amount_cents), 0);

  return {
    id: "rent-receipts",
    title: "Rent collection summary",
    columns: [
      { key: "date", label: "Date received", format: "date" },
      { key: "description", label: "Description" },
      { key: "category", label: "Type" },
      { key: "amount", label: "Amount", align: "right", format: "money" },
      { key: "property", label: "Property" },
      { key: "resident", label: "Resident" },
    ],
    rows,
    totals: {
      date: "Total rent collected",
      description: "",
      category: "",
      amount: centsToUsd(totalCents),
      property: "",
      resident: "",
    },
    meta: { from, to, totalEarned: centsToUsd(totalCents) },
  };
}

export async function queryRentalDays(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const rangeStart = new Date(from);
  const rangeEnd = new Date(to);
  const profiles = await loadRentProfiles(db, managerUserId, filters.propertyId);

  const rows = profiles
    .filter((p) => p.active !== false)
    .map((p) => {
      const leaseStart = p.startMonth?.trim()
        ? new Date(`${p.startMonth.trim()}-01T12:00:00`)
        : rangeStart;
      const leaseEnd = p.leaseEnd?.trim() ? new Date(`${p.leaseEnd.trim()}T12:00:00`) : rangeEnd;
      const overlapStart = leaseStart > rangeStart ? leaseStart : rangeStart;
      const overlapEnd = leaseEnd < rangeEnd ? leaseEnd : rangeEnd;
      const daysRented = daysInclusive(overlapStart, overlapEnd);
      return {
        property: p.propertyLabel,
        unit: p.roomLabel || "—",
        resident: p.residentName,
        leaseStart: leaseStart.toISOString().slice(0, 10),
        leaseEnd: p.leaseEnd?.trim() || "—",
        daysRented,
        daysAvailable: daysInclusive(rangeStart, rangeEnd),
        period: `${from} – ${to}`,
      };
    })
    .filter((row) => row.daysRented > 0)
    .sort((a, b) => String(a.property).localeCompare(String(b.property)));

  const totalDays = rows.reduce((sum, row) => sum + Number(row.daysRented), 0);

  return {
    id: "rental-days",
    title: "Days rented",
    columns: [
      { key: "property", label: "Property" },
      { key: "unit", label: "Unit" },
      { key: "resident", label: "Resident" },
      { key: "leaseStart", label: "Lease start", format: "date" },
      { key: "leaseEnd", label: "Lease end", format: "date" },
      { key: "daysRented", label: "Days rented", align: "right", format: "number" },
      { key: "daysAvailable", label: "Days available", align: "right", format: "number" },
    ],
    rows,
    totals: {
      property: "Total occupied unit-days",
      unit: "",
      resident: "",
      leaseStart: "",
      leaseEnd: "",
      daysRented: totalDays,
      daysAvailable: rows.length * daysInclusive(rangeStart, rangeEnd),
    },
    meta: { from, to, totalDaysRented: totalDays },
  };
}

export async function queryTaxSummary(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const { from, to } = defaultDateRange(filters.from, filters.to);
  const [incomeStatement, rentalDays, expensesReport] = await Promise.all([
    queryIncomeStatement(db, managerUserId, filters),
    queryRentalDays(db, managerUserId, filters),
    queryExpenses(db, managerUserId, filters),
  ]);

  const [profiles, display] = await Promise.all([
    loadRentProfiles(db, managerUserId, filters.propertyId),
    loadManagerReportDisplayContext(db, managerUserId),
  ]);
  const propertyLabels = new Map<string, string>();
  for (const profile of profiles) {
    if (profile.propertyId?.trim()) {
      propertyLabels.set(profile.propertyId.trim(), profile.propertyLabel.trim() || display.propertyLabel(profile.propertyId));
    }
  }
  const labelForPropertyId = (propertyId: string) => {
    if (propertyId === "Unassigned") return "Unassigned";
    return propertyLabels.get(propertyId) ?? display.propertyLabel(propertyId);
  };

  const incomeByProperty = new Map<string, number>();
  let incomeQuery = db
    .from("ledger_entries")
    .select("property_id, amount_cents, category_code")
    .eq("manager_user_id", managerUserId)
    .eq("entry_type", "payment")
    .gte("posted_date", from)
    .lte("posted_date", to);
  if (filters.propertyId) incomeQuery = incomeQuery.eq("property_id", filters.propertyId);
  const { data: incomeRows } = await incomeQuery;
  for (const row of incomeRows ?? []) {
    if (!RENT_RECEIPT_CATEGORIES.has(String(row.category_code))) continue;
    const key = labelForPropertyId(String(row.property_id ?? "Unassigned"));
    incomeByProperty.set(key, (incomeByProperty.get(key) ?? 0) + Number(row.amount_cents));
  }

  const expenseByProperty = new Map<string, number>();
  const deductibleByProperty = new Map<string, number>();
  const nonDeductibleByProperty = new Map<string, number>();
  let deductibleCents = 0;
  let nonDeductibleCents = 0;
  let expenseQuery = db
    .from("manager_expense_entries")
    .select("property_id, amount_cents, category_code, tax_deductible")
    .eq("manager_user_id", managerUserId)
    .gte("expense_date", from)
    .lte("expense_date", to);
  if (filters.propertyId) expenseQuery = expenseQuery.eq("property_id", filters.propertyId);
  const { data: expenseRows } = await expenseQuery;
  for (const row of expenseRows ?? []) {
    const key = labelForPropertyId(String(row.property_id ?? "Unassigned"));
    expenseByProperty.set(key, (expenseByProperty.get(key) ?? 0) + Number(row.amount_cents));
    if (resolveExpenseTaxDeductible(row.category_code as string | null, row.tax_deductible as boolean | null)) {
      deductibleByProperty.set(key, (deductibleByProperty.get(key) ?? 0) + Number(row.amount_cents));
      deductibleCents += Number(row.amount_cents);
    } else {
      nonDeductibleByProperty.set(key, (nonDeductibleByProperty.get(key) ?? 0) + Number(row.amount_cents));
      nonDeductibleCents += Number(row.amount_cents);
    }
  }

  const daysByProperty = new Map<string, number>();
  for (const row of rentalDays.rows) {
    const key = String(row.property ?? "Unassigned");
    daysByProperty.set(key, (daysByProperty.get(key) ?? 0) + Number(row.daysRented ?? 0));
  }

  const propertyKeys = new Set([
    ...incomeByProperty.keys(),
    ...expenseByProperty.keys(),
    ...daysByProperty.keys(),
  ]);

  const rows = [...propertyKeys].map((propertyKey) => {
    const earnedCents = incomeByProperty.get(propertyKey) ?? 0;
    const spentCents = expenseByProperty.get(propertyKey) ?? 0;
    return {
      property: propertyKey,
      daysRented: daysByProperty.get(propertyKey) ?? 0,
      rentEarned: centsToUsd(earnedCents),
      houseSpent: centsToUsd(spentCents),
      deductibleExpenses: centsToUsd(deductibleByProperty.get(propertyKey) ?? 0),
      nonDeductibleExpenses: centsToUsd(nonDeductibleByProperty.get(propertyKey) ?? 0),
      netIncome: centsToUsd(earnedCents - spentCents),
    };
  });

  const totalIncomeCents = [...incomeByProperty.values()].reduce((sum, cents) => sum + cents, 0);
  const totalExpenseCents = [...expenseByProperty.values()].reduce((sum, cents) => sum + cents, 0);
  const totalDays = Number(rentalDays.meta?.totalDaysRented ?? 0);

  return {
    id: "tax-summary",
    title: "Tax summary",
    columns: [
      { key: "property", label: "Property" },
      { key: "daysRented", label: "Days rented", align: "right", format: "number" },
      { key: "rentEarned", label: "Rent earned", align: "right", format: "money" },
      { key: "houseSpent", label: "Repairs & expenses", align: "right", format: "money" },
      { key: "deductibleExpenses", label: "Deductible", align: "right", format: "money" },
      { key: "nonDeductibleExpenses", label: "Non-deductible", align: "right", format: "money" },
      { key: "netIncome", label: "Net", align: "right", format: "money" },
    ],
    rows,
    totals: {
      property: "Portfolio total",
      daysRented: totalDays,
      rentEarned: centsToUsd(totalIncomeCents),
      houseSpent: centsToUsd(totalExpenseCents),
      deductibleExpenses: centsToUsd(deductibleCents),
      nonDeductibleExpenses: centsToUsd(nonDeductibleCents),
      netIncome: centsToUsd(totalIncomeCents - totalExpenseCents),
    },
    meta: {
      from,
      to,
      totalEarned: centsToUsd(totalIncomeCents),
      totalSpent: centsToUsd(totalExpenseCents),
      totalDaysRented: totalDays,
      netIncome: centsToUsd(totalIncomeCents - totalExpenseCents),
      totalIncome: incomeStatement.meta?.totalIncome ?? centsToUsd(totalIncomeCents),
      totalExpense: incomeStatement.meta?.totalExpense ?? centsToUsd(totalExpenseCents),
      totalDeductibleExpenses: centsToUsd(deductibleCents),
      totalNonDeductibleExpenses: centsToUsd(nonDeductibleCents),
      expenseCount: expensesReport.rows.length,
    },
  };
}

export async function queryLeaseExpiration(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const daysAhead = filters.daysAhead ?? 90;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + daysAhead);

  let query = db
    .from("portal_recurring_rent_profile_records")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .limit(500);
  if (filters.propertyId) query = query.eq("property_id", filters.propertyId);

  const { data } = await query;
  const rows = (data ?? [])
    .map((r) => r.row_data as RecurringRentProfile)
    .filter((p) => p?.leaseEnd?.trim())
    .filter((p) => {
      const end = new Date(p.leaseEnd!);
      return end <= cutoff && end >= new Date();
    })
    .map((p) => ({
      resident: p.residentName,
      property: p.propertyLabel,
      unit: p.roomLabel || "—",
      leaseEnd: p.leaseEnd!,
      monthlyRent: centsToUsd(Math.round(rentMonthlyEquivalent(p.monthlyRent, p.dailyRentPrice, p.weeklyRentPrice) * 100)),
    }))
    .sort((a, b) => String(a.leaseEnd).localeCompare(String(b.leaseEnd)));

  return {
    id: "lease-expiration",
    title: "Lease expiration",
    columns: [
      { key: "resident", label: "Resident" },
      { key: "property", label: "Property" },
      { key: "unit", label: "Unit" },
      { key: "leaseEnd", label: "Lease end", format: "date" },
      { key: "monthlyRent", label: "Monthly rent", align: "right", format: "money" },
    ],
    rows,
    meta: { daysAhead },
  };
}

export async function queryVendorSpend(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const { from, to } = defaultDateRange(filters.from, filters.to);

  let query = db
    .from("manager_expense_entries")
    .select("vendor_id, amount_cents")
    .eq("manager_user_id", managerUserId)
    .gte("expense_date", from)
    .lte("expense_date", to)
    .not("vendor_id", "is", null);
  if (filters.propertyId) query = query.eq("property_id", filters.propertyId);
  if (filters.vendorId) query = query.eq("vendor_id", filters.vendorId);

  const { data: expenses } = await query;

  const { data: vendorRecords } = await db
    .from("manager_vendor_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId);

  const vendorNames = new Map<string, string>();
  for (const v of vendorRecords ?? []) {
    const row = v.row_data as { id?: string; name?: string } | null;
    if (row?.id) vendorNames.set(row.id, row.name ?? row.id);
  }

  const spendByVendor = new Map<string, number>();
  for (const e of expenses ?? []) {
    const vid = String(e.vendor_id);
    spendByVendor.set(vid, (spendByVendor.get(vid) ?? 0) + Number(e.amount_cents));
  }

  const rows = [...spendByVendor.entries()]
    .map(([vendorId, cents]) => ({
      vendor: vendorNames.get(vendorId) ?? vendorId,
      vendorId,
      totalSpend: centsToUsd(cents),
    }))
    .sort((a, b) => a.vendor.localeCompare(b.vendor));

  const totalCents = [...spendByVendor.values()].reduce((a, b) => a + b, 0);

  return {
    id: "vendor-spend",
    title: "Vendor spend",
    columns: [
      { key: "vendor", label: "Vendor" },
      { key: "vendorId", label: "Vendor ID" },
      { key: "totalSpend", label: "Total spend", align: "right", format: "money" },
    ],
    rows,
    totals: { vendor: "Total", vendorId: "", totalSpend: centsToUsd(totalCents) },
    meta: { from, to },
  };
}

export type TaxProfileCompleteness = {
  complete: boolean;
  missingFields: string[];
};

export function evaluateVendorTaxProfile(profile: {
  legal_name?: string | null;
  address_line1?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  tin_type?: string | null;
  tin_ciphertext?: string | null;
  w9_attestation?: boolean | null;
} | null): TaxProfileCompleteness {
  if (!profile) {
    return { complete: false, missingFields: ["legal_name", "address", "tin", "w9_attestation"] };
  }
  const missing: string[] = [];
  if (!profile.legal_name?.trim()) missing.push("legal_name");
  if (!profile.address_line1?.trim() || !profile.city?.trim() || !profile.state?.trim() || !profile.zip?.trim()) {
    missing.push("address");
  }
  if (!profile.tin_type?.trim() || !profile.tin_ciphertext?.trim()) missing.push("tin");
  if (!profile.w9_attestation) missing.push("w9_attestation");
  return { complete: missing.length === 0, missingFields: missing };
}

export async function query1099Candidates(
  db: SupabaseClient,
  managerUserId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult> {
  const taxYear = filters.taxYear ?? new Date().getFullYear() - 1;
  const from = `${taxYear}-01-01`;
  const to = `${taxYear}-12-31`;

  const { data: expenses } = await db
    .from("manager_expense_entries")
    .select("vendor_id, amount_cents")
    .eq("manager_user_id", managerUserId)
    .gte("expense_date", from)
    .lte("expense_date", to)
    .not("vendor_id", "is", null);

  const totals = new Map<string, number>();
  for (const e of expenses ?? []) {
    const vid = String(e.vendor_id);
    totals.set(vid, (totals.get(vid) ?? 0) + Number(e.amount_cents));
  }

  const vendorIds = [...totals.keys()];
  const [{ data: vendorRecords }, { data: taxProfiles }] = await Promise.all([
    db.from("manager_vendor_records").select("id, row_data").eq("manager_user_id", managerUserId),
    vendorIds.length > 0
      ? db.from("vendor_tax_profiles").select("*").eq("manager_user_id", managerUserId).in("vendor_id", vendorIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const vendorNames = new Map<string, string>();
  for (const v of vendorRecords ?? []) {
    const row = v.row_data as { id?: string; name?: string } | null;
    if (row?.id) vendorNames.set(row.id, row.name ?? row.id);
  }

  const profileByVendor = new Map((taxProfiles ?? []).map((p) => [String(p.vendor_id), p]));

  const rows = vendorIds
    .map((vendorId) => {
      const totalCents = totals.get(vendorId) ?? 0;
      const profile = profileByVendor.get(vendorId) ?? null;
      const { complete, missingFields } = evaluateVendorTaxProfile(profile);
      return {
        vendorId,
        vendorName: vendorNames.get(vendorId) ?? vendorId,
        legalName: profile?.legal_name ?? "",
        totalPaid: centsToUsd(totalCents),
        totalPaidCents: totalCents,
        meetsThreshold: totalCents >= 60_000,
        w9Status: complete ? "Complete" : missingFields.includes("tin") ? "Missing TIN" : "Incomplete",
        canDownload: complete && totalCents >= 60_000,
        missingFields: missingFields.join(", "),
      };
    })
    .filter((r) => Number(r.totalPaidCents) >= 60_000)
    .sort((a, b) => String(a.vendorName).localeCompare(String(b.vendorName)));

  return {
    id: "1099-candidates",
    title: `1099-NEC candidates (${taxYear})`,
    columns: [
      { key: "vendorName", label: "Vendor" },
      { key: "legalName", label: "Legal name" },
      { key: "totalPaid", label: "Total paid", align: "right", format: "money" },
      { key: "w9Status", label: "W-9 status" },
      { key: "missingFields", label: "Missing fields" },
    ],
    rows: rows.map(({ totalPaidCents: _, canDownload: __, meetsThreshold: ___, ...rest }) => rest),
    meta: { taxYear, thresholdCents: 60_000 },
  };
}


export async function queryResidentLedger(
  db: SupabaseClient,
  residentUserId: string,
  residentEmail: string,
  filters: { from?: string; to?: string },
  managerUserId?: string,
): Promise<ReportResult> {
  const now = new Date();
  const from =
    filters.from?.trim() ||
    new Date(now.getFullYear() - 1, now.getMonth(), now.getDate()).toISOString().slice(0, 10);
  const to = filters.to?.trim() || now.toISOString().slice(0, 10);

  let query = db
    .from("ledger_entries")
    .select("*")
    .or(`resident_user_id.eq.${residentUserId},resident_email.eq.${residentEmail}`)
    .gte("posted_date", from)
    .lte("posted_date", to);
  if (managerUserId) query = query.eq("manager_user_id", managerUserId);
  const { data } = await query.order("posted_date", { ascending: true });

  let running = 0;
  const rows = (data ?? []).map((e) => {
    const cents = Number(e.amount_cents);
    if (e.entry_type === "charge") running += cents;
    else running -= cents;
    return {
      date: e.posted_date,
      description: e.description ?? "",
      charge: e.entry_type === "charge" ? centsToUsd(cents) : "",
      payment: e.entry_type === "payment" ? centsToUsd(cents) : "",
      balance: centsToUsd(running),
      // Not columns — exports iterate `columns`, so these are inert there. They
      // let the resident Payments "Paid" tab reconcile against the live charge
      // list instead of contradicting Documents › Rent receipts (F6).
      sourceChargeId: e.source_charge_id ?? "",
      property: e.unit_label ?? "",
    };
  });

  return {
    id: "resident-ledger",
    title: "Rent statement",
    columns: [
      { key: "date", label: "Date", format: "date" },
      { key: "description", label: "Description" },
      { key: "charge", label: "Charge", align: "right", format: "money" },
      { key: "payment", label: "Payment", align: "right", format: "money" },
      { key: "balance", label: "Balance", align: "right", format: "money" },
    ],
    rows,
    meta: { from, to },
  };
}

export async function runManagerReport(
  db: SupabaseClient,
  managerUserId: string,
  reportId: string,
  filters: ManagerReportFilters,
): Promise<ReportResult | null> {
  switch (reportId) {
    case "tax-summary":
      return queryTaxSummary(db, managerUserId, filters);
    case "rent-receipts":
      return queryRentReceipts(db, managerUserId, filters);
    case "rental-days":
      return queryRentalDays(db, managerUserId, filters);
    case "rent-roll":
      return queryRentRoll(db, managerUserId, filters);
    case "delinquency":
      return queryDelinquency(db, managerUserId, filters);
    case "income-statement":
      return queryIncomeStatement(db, managerUserId, filters);
    case "expenses":
      return queryExpenses(db, managerUserId, filters);
    case "lease-expiration":
      return queryLeaseExpiration(db, managerUserId, filters);
    case "vendor-spend":
      return queryVendorSpend(db, managerUserId, filters);
    case "1099-candidates":
      return query1099Candidates(db, managerUserId, filters);
    case "trial-balance":
      return queryTrialBalance(db, managerUserId, filters);
    case "balance-sheet":
      return queryBalanceSheet(db, managerUserId, filters);
    case "general-ledger":
      return queryGeneralLedger(db, managerUserId, filters);
    case "cash-flow-statement":
      return queryCashFlowStatement(db, managerUserId, filters);
    case "payout-history":
      return queryPayoutHistory(db, managerUserId, filters);
    case "trust-account-balance":
      return queryTrustAccountBalance(db, managerUserId, filters);
    case "financial-diagnostics":
      return queryFinancialDiagnostics(db, managerUserId, filters);
    case "ap-aging":
      return queryApAging(db, managerUserId, filters);
    case "budget-vs-actual":
      return queryBudgetVsActual(db, managerUserId, filters);
    case "owner-statement":
      return queryOwnerStatement(db, managerUserId, filters);
    default:
      return null;
  }
}
