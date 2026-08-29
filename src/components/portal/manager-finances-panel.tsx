"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { useShallowTabId } from "@/components/ui/tabs";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  FinanceFilterSortFields,
  financeFilterFieldCount,
  type FinanceRowFilterState,
} from "@/components/portal/finance-filter-sort-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { FinanceDestinationNav } from "@/components/portal/finance-destination-nav";
import { ExpenseTaxStatusToggle } from "@/components/portal/expense-tax-status-toggle";
import { PortalAdaptiveHeaderActions } from "@/components/portal/portal-adaptive-header-actions";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  ManagerPortalPageShell,
  MANAGER_TABLE_TH,
  PORTAL_HEADER_ACTION_BTN,
  PORTAL_HEADER_PRIMARY_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import {
  ManagerBankReconciliationPanel,
  type ManagerBankReconciliationPanelHandle,
} from "@/components/portal/manager-bank-reconciliation-panel";
import { ManagerBillsPanel, type ManagerBillsPanelHandle } from "@/components/portal/manager-bills-panel";
import { ManagerBudgetsPanel } from "@/components/portal/manager-budgets-panel";
import {
  ManagerOwnerDistributionsPanel,
  type ManagerOwnerDistributionsPanelHandle,
} from "@/components/portal/manager-owner-distributions-panel";
import { ManagerSecurityDepositsPanel } from "@/components/portal/manager-security-deposits-panel";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import {
  ReportExportButtons,
  type ReportFilterState,
} from "@/components/portal/reports/report-filter-bar";
import { PORTAL_DATA_TABLE, PORTAL_DATA_TABLE_WRAP,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_MOBILE_CARD_CLASS,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TR,
  PORTAL_TABLE_TD,
  PortalDataTableEmpty,} from "@/components/portal/portal-data-table";
import type { ReportColumn, ReportResult, ReportRow } from "@/lib/reports/types";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import {
  readChargesForManager,
  syncHouseholdChargesFromServer,
  HOUSEHOLD_CHARGES_EVENT,
} from "@/lib/household-charges";
import {
  buildManagerPropertyFilterOptions,
  collectLinkedPropertyIdsForModule,
} from "@/lib/manager-portfolio-access";
import {
  MANAGER_OUTGOING_PAYMENTS_EVENT,
  readManagerOutgoingExpenses,
  syncManagerOutgoingExpensesFromServer,
} from "@/lib/manager-outgoing-payments";
import {
  bucketByMonth,
  lastNMonths,
  mergeMonthlyCashflow,
  parseMoneyLabel,
} from "@/lib/portal-monthly-profit";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { expenseTaxStatusLabel, isCategoryDeductible, SYSTEM_CHART_ACCOUNTS } from "@/lib/reports/categories";
import { cn } from "@/lib/utils";
import { centsToUsd, dollarsToCents } from "@/lib/reports/money";
import {
  MANAGER_VENDORS_EVENT,
  readActiveManagerVendorRows,
  syncManagerVendorsFromServer,
} from "@/lib/manager-vendors-storage";

const HIDDEN_FINANCE_COLS = new Set(["scheduleERef", "id", "workOrderId", "taxDeductible"]);

function emptyRowFilters(): FinanceRowFilterState {
  return { resident: "", type: "", category: "", vendor: "" };
}

function parseMoneyAmount(raw: unknown): number {
  return dollarsToCents(typeof raw === "string" || typeof raw === "number" ? raw : null);
}

function filterFinanceReport(
  report: ReportResult,
  tabId: string,
  rowFilters: FinanceRowFilterState,
  searchQuery = "",
): ReportResult {
  if (LEDGER_TAB_IDS.has(tabId)) return report;
  let rows = report.rows;
  if (tabId === "income") {
    if (rowFilters.resident) rows = rows.filter((row) => String(row.resident ?? "") === rowFilters.resident);
    if (rowFilters.type) rows = rows.filter((row) => String(row.category ?? "") === rowFilters.type);
  } else {
    if (rowFilters.category) rows = rows.filter((row) => String(row.category ?? "") === rowFilters.category);
    if (rowFilters.vendor) rows = rows.filter((row) => String(row.vendor ?? "") === rowFilters.vendor);
  }

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  if (normalizedSearch) {
    rows = rows.filter((row) =>
      Object.entries(row).some(
        ([key, value]) =>
          !HIDDEN_FINANCE_COLS.has(key) && String(value ?? "").toLocaleLowerCase().includes(normalizedSearch),
      ),
    );
  }

  if (!report.totals) return { ...report, rows };

  const filteredTotalCents = rows.reduce((sum, row) => sum + parseMoneyAmount(row.amount), 0);
  const totalLabel = tabId === "income" ? "Total rent collected" : "Total expenses";
  return {
    ...report,
    rows,
    totals: {
      ...report.totals,
      date: totalLabel,
      amount: centsToUsd(filteredTotalCents),
    },
  };
}

function cellAlign(col: ReportColumn) {
  return col.align === "right" ? "text-right tabular-nums" : "text-left";
}

function formatCellValue(col: ReportColumn, raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) return "—";
  if (col.format === "date" && /^\d{4}-\d{2}-\d{2}/.test(text)) {
    const d = new Date(`${text.slice(0, 10)}T12:00:00`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
  }
  return text;
}

function compareRows(a: ReportRow, b: ReportRow, key: string, dir: "asc" | "desc"): number {
  const av = String(a[key] ?? "");
  const bv = String(b[key] ?? "");
  const an = Number.parseFloat(av.replace(/[^0-9.-]/g, ""));
  const bn = Number.parseFloat(bv.replace(/[^0-9.-]/g, ""));
  let cmp = 0;
  if (!Number.isNaN(an) && !Number.isNaN(bn) && (av.includes("$") || bv.includes("$"))) {
    cmp = an - bn;
  } else if (/^\d{4}-\d{2}-\d{2}/.test(av) && /^\d{4}-\d{2}-\d{2}/.test(bv)) {
    cmp = av.localeCompare(bv);
  } else {
    cmp = av.localeCompare(bv, undefined, { sensitivity: "base" });
  }
  return dir === "asc" ? cmp : -cmp;
}

function FinancesDataTable({
  report,
  sortKey,
  sortDir,
  onHeaderSort,
  onTaxStatusChange,
}: {
  report: ReportResult;
  sortKey: string;
  sortDir: "asc" | "desc";
  onHeaderSort: (key: string) => void;
  onTaxStatusChange?: (expenseId: string, deductible: boolean) => void;
}) {
  const visibleCols = useMemo(
    () => report.columns.filter((c) => !HIDDEN_FINANCE_COLS.has(c.key)),
    [report.columns],
  );

  const sortedRows = useMemo(
    () => [...report.rows].sort((a, b) => compareRows(a, b, sortKey, sortDir)),
    [report.rows, sortKey, sortDir],
  );

  if (report.rows.length === 0) {
    return <PortalDataTableEmpty message="No finance entries yet." icon="finance" />;
  }

  const renderCellValue = (col: ReportColumn, row: ReportRow) =>
    col.key === "taxStatus" && onTaxStatusChange && row.id ? (
      <ExpenseTaxStatusToggle
        compact
        deductible={row.taxDeductible !== false}
        onChange={(next) => onTaxStatusChange(String(row.id), next)}
      />
    ) : (
      formatCellValue(col, row[col.key])
    );

  return (
    <>
      <div className="space-y-2 lg:hidden">
        {sortedRows.map((row, idx) => (
          <div key={`${row.id ?? idx}-${idx}`} className={PORTAL_MOBILE_CARD_CLASS}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {visibleCols.map((col) => (
                <div key={col.key} className={cn("min-w-0", col.key === "taxStatus" && "col-span-2")}>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">{col.label}</p>
                  <div
                    className={`break-words text-sm ${
                      col.key === "amount" || col.key === "property" || col.key === "resident"
                        ? "font-medium text-foreground"
                        : "text-foreground/80"
                    }`}
                  >
                    {renderCellValue(col, row)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {report.totals ? (
          <div className={`${PORTAL_MOBILE_CARD_CLASS} bg-accent/10`}>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {visibleCols.map((col) => (
                <div key={col.key} className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted/70">{col.label}</p>
                  <p className="break-words text-sm font-semibold text-foreground">
                    {formatCellValue(col, report.totals![col.key])}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className={`${PORTAL_DATA_TABLE_WRAP} hidden lg:block`}>
      <div className={PORTAL_DATA_TABLE_SCROLL}>
        <table className={PORTAL_DATA_TABLE}>
          <thead>
            <tr className={PORTAL_TABLE_HEAD_ROW}>
              {visibleCols.map((col) => (
                <th
                  key={col.key}
                  className={`${MANAGER_TABLE_TH} ${cellAlign(col)} p-0 transition hover:bg-accent/30`}
                  aria-sort={sortKey === col.key ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className={`flex w-full items-center gap-1 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] ${
                      col.align === "right" ? "justify-end text-right" : "justify-start text-left"
                    }`}
                    onClick={() => onHeaderSort(col.key)}
                    data-attr={`finances-sort-${col.key}`}
                  >
                    <span>{col.label}</span>
                    <span className="text-[10px] text-muted/60" aria-hidden>
                      {sortKey === col.key ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row, idx) => (
              <tr key={`${row.id ?? idx}-${idx}`} className={PORTAL_TABLE_TR}>
                {visibleCols.map((col) => (
                  <td
                    key={col.key}
                    className={`${PORTAL_TABLE_TD} ${cellAlign(col)} ${
                      col.key === "amount" ? "font-medium text-foreground" : ""
                    } ${col.key === "property" || col.key === "resident" ? "font-medium text-foreground" : ""}`}
                  >
                    {renderCellValue(col, row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {report.totals ? (
            <tfoot>
              <tr className="border-t-2 border-border bg-accent/10 font-semibold text-sm">
                {visibleCols.map((col) => (
                  <td key={col.key} className={`${PORTAL_TABLE_TD} ${cellAlign(col)}`}>
                    {formatCellValue(col, report.totals![col.key])}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      </div>
    </>
  );
}

const FINANCE_TABS = [
  { id: "income", label: "Income" },
  { id: "expenses", label: "Expenses" },
  { id: "trial-balance", label: "Trial balance" },
  { id: "balance-sheet", label: "Balance sheet" },
  { id: "general-ledger", label: "General ledger" },
  { id: "cash-flow-statement", label: "Cash flow" },
  { id: "payout-history", label: "Payout history" },
  { id: "trust-account-balance", label: "Trust account" },
  { id: "security-deposits", label: "Deposits" },
  { id: "financial-diagnostics", label: "Diagnostics" },
  { id: "ap-aging", label: "AP aging" },
  { id: "bills", label: "Bills" },
  { id: "budget-vs-actual", label: "Budget" },
  { id: "bank-reconciliation", label: "Bank rec" },
  { id: "owner-statement", label: "Owner statement" },
  { id: "owner-distributions", label: "Distributions" },
] as const;

const LEDGER_TAB_IDS = new Set([
  "trial-balance",
  "balance-sheet",
  "general-ledger",
  "cash-flow-statement",
  "payout-history",
  "trust-account-balance",
  "financial-diagnostics",
  "ap-aging",
  "budget-vs-actual",
  "owner-statement",
]);

const TAB_TO_REPORT: Record<string, string> = {
  income: "rent-receipts",
  expenses: "expenses",
  "trial-balance": "trial-balance",
  "balance-sheet": "balance-sheet",
  "general-ledger": "general-ledger",
  "cash-flow-statement": "cash-flow-statement",
  "payout-history": "payout-history",
  "trust-account-balance": "trust-account-balance",
  "financial-diagnostics": "financial-diagnostics",
  "ap-aging": "ap-aging",
  "budget-vs-actual": "budget-vs-actual",
  "owner-statement": "owner-statement",
};

const DEFAULT_SORT: Record<string, { key: string; dir: "asc" | "desc" }> = {
  income: { key: "date", dir: "desc" },
  expenses: { key: "date", dir: "desc" },
  "trial-balance": { key: "account", dir: "asc" },
  "balance-sheet": { key: "account", dir: "asc" },
  "general-ledger": { key: "date", dir: "asc" },
  "cash-flow-statement": { key: "line", dir: "asc" },
  "payout-history": { key: "date", dir: "desc" },
  "trust-account-balance": { key: "line", dir: "asc" },
  "financial-diagnostics": { key: "severity", dir: "asc" },
  "ap-aging": { key: "dueDate", dir: "asc" },
  "budget-vs-actual": { key: "category", dir: "asc" },
  "owner-statement": { key: "line", dir: "asc" },
};

function defaultFilters(): ReportFilterState {
  const now = new Date();
  const yearStart = new Date(now.getFullYear(), 0, 1);
  return {
    propertyId: "",
    from: yearStart.toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
    daysAhead: "90",
    taxYear: String(now.getFullYear() - 1),
  };
}

type ExpenseDraft = {
  categoryCode: string;
  amount: string;
  expenseDate: string;
  memo: string;
  vendorId: string;
  propertyId: string;
  taxDeductible: boolean;
  // Once the manager touches the tax field, category changes stop re-suggesting it.
  taxTouched: boolean;
};

const EXPENSE_CATEGORIES = SYSTEM_CHART_ACCOUNTS.filter((a) => a.accountType === "expense");
const INCOME_CATEGORIES = SYSTEM_CHART_ACCOUNTS.filter((a) => a.accountType === "income");

type IncomeDraft = {
  categoryCode: string;
  amount: string;
  postedDate: string;
  description: string;
  propertyId: string;
};

function FinancesFilterSheet({
  activeCount,
  onReset,
  tabId,
  propertyOptions,
  filters,
  onFiltersChange,
  report,
  rowFilters,
  onRowFiltersChange,
  sortOptions,
  sortKey,
  onSortKeyChange,
  sortDir,
  onSortDirChange,
  defaultSortKey,
  defaultSortDir,
  defaultFilters,
  defaultRowFilters,
  filterFieldCount,
  open,
  onOpenChange,
}: {
  activeCount: number;
  onReset: () => void;
  tabId: string;
  propertyOptions: { id: string; label: string }[];
  filters: ReportFilterState;
  onFiltersChange: (next: Partial<ReportFilterState>) => void;
  report: ReportResult | null;
  rowFilters: FinanceRowFilterState;
  onRowFiltersChange: (next: Partial<FinanceRowFilterState>) => void;
  sortOptions: { value: string; label: string }[];
  sortKey: string;
  onSortKeyChange: (next: string) => void;
  sortDir: "asc" | "desc";
  onSortDirChange: (next: "asc" | "desc") => void;
  defaultSortKey: string;
  defaultSortDir: "asc" | "desc";
  defaultFilters: ReportFilterState;
  defaultRowFilters: FinanceRowFilterState;
  filterFieldCount: number;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <PortalFilterSortSheet
      activeCount={activeCount}
      compactPanel
      filterFieldCount={filterFieldCount}
      constrainDropdownToTitleBand
      mobileFlushBody
      className="min-w-0 w-auto shrink-0 max-md:w-full max-md:[&_button]:w-full max-md:[&_button]:px-2.5 md:!w-auto md:!max-w-none"
      onReset={onReset}
      dataAttr="finances-filter-sheet-open"
      open={open}
      onOpenChange={onOpenChange}
    >
      <FinanceFilterSortFields
        tabId={tabId}
        propertyOptions={propertyOptions}
        filters={filters}
        onFiltersChange={onFiltersChange}
        report={report}
        rowFilters={rowFilters}
        onRowFiltersChange={onRowFiltersChange}
        sortOptions={sortOptions}
        sortKey={sortKey}
        onSortKeyChange={onSortKeyChange}
        sortDir={sortDir}
        onSortDirChange={onSortDirChange}
        defaultFilters={defaultFilters}
        defaultRowFilters={defaultRowFilters}
        defaultSortKey={defaultSortKey}
        defaultSortDir={defaultSortDir}
      />
    </PortalFilterSortSheet>
  );
}

export function ManagerFinancesPanel({
  tabId: serverTabId,
  basePath = "/portal",
}: {
  tabId: string;
  basePath?: string;
}) {
  // Tab switches are shallow (client-only) — see TabNav `shallow` below.
  const tabId = useShallowTabId(
    serverTabId,
    FINANCE_TABS.map((t) => t.id),
  );
  const { showToast } = useAppUi();
  const { userId, ready } = useManagerUserId();
  const [propertyTick, setPropertyTick] = useState(0);
  const [vendorTick, setVendorTick] = useState(0);
  const [cashflowChartTick, setCashflowChartTick] = useState(0);
  // The chart window is "the last 24 months from now", but reading the clock DURING
  // render makes the render impure: two renders in the same tick could produce different
  // windows. Stamp it once per mount and re-stamp whenever the chart is asked to refresh.
  const [cashflowNowMs, setCashflowNowMs] = useState(0);
  useEffect(() => {
    setCashflowNowMs(Date.now());
  }, [cashflowChartTick]);
  const [filters, setFilters] = useState(defaultFilters);
  const [report, setReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [rowFilters, setRowFilters] = useState(emptyRowFilters);
  const [searchQuery, setSearchQuery] = useState("");
  const [expenseModal, setExpenseModal] = useState(false);
  const [incomeModal, setIncomeModal] = useState(false);
  const billsRef = useRef<ManagerBillsPanelHandle>(null);
  const bankReconciliationRef = useRef<ManagerBankReconciliationPanelHandle>(null);
  const ownerDistributionsRef = useRef<ManagerOwnerDistributionsPanelHandle>(null);
  const [canAddBankStatement, setCanAddBankStatement] = useState(false);
  const [expenseDraft, setExpenseDraft] = useState<ExpenseDraft>({
    categoryCode: "maintenance",
    amount: "",
    expenseDate: new Date().toISOString().slice(0, 10),
    memo: "",
    vendorId: "",
    propertyId: "",
    taxDeductible: isCategoryDeductible("maintenance"),
    taxTouched: false,
  });
  const [incomeDraft, setIncomeDraft] = useState<IncomeDraft>({
    categoryCode: "other_income",
    amount: "",
    postedDate: new Date().toISOString().slice(0, 10),
    description: "",
    propertyId: "",
  });

  const reportId = TAB_TO_REPORT[tabId] ?? "rent-receipts";
  const [sortKey, setSortKey] = useState(DEFAULT_SORT[tabId]?.key ?? "date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">(DEFAULT_SORT[tabId]?.dir ?? "desc");

  const filteredReport = useMemo(
    () => (report ? filterFinanceReport(report, tabId, rowFilters, searchQuery) : null),
    [report, tabId, rowFilters, searchQuery],
  );

  const monthlyProfitPoints = useMemo(() => {
    void cashflowChartTick;
    if (!userId || tabId !== "cash-flow-statement" || !cashflowNowMs) return [];
    const months = lastNMonths(cashflowNowMs, 24);
    const charges = readChargesForManager(userId, {
      linkedPropertyIds: collectLinkedPropertyIdsForModule(userId, "payments"),
    }).filter((c) => c.status === "paid");
    const scopedCharges = filters.propertyId
      ? charges.filter((c) => c.propertyId === filters.propertyId)
      : charges;
    const expenses = readManagerOutgoingExpenses().filter((e) =>
      filters.propertyId ? e.propertyId === filters.propertyId : true,
    );
    const paymentsByMonth = bucketByMonth(
      scopedCharges,
      months,
      (c) => c.paidAt ?? c.createdAt,
      (c) => parseMoneyLabel(c.amountLabel || c.balanceLabel),
    );
    const expensesByMonth = bucketByMonth(
      expenses,
      months,
      (e) => e.expenseDate,
      (e) => e.amountCents / 100,
    );
    return mergeMonthlyCashflow(paymentsByMonth, expensesByMonth);
  }, [userId, tabId, cashflowChartTick, cashflowNowMs, filters.propertyId]);

  useEffect(() => {
    if (!ready || tabId !== "cash-flow-statement") return;
    void Promise.all([syncHouseholdChargesFromServer(true), syncManagerOutgoingExpensesFromServer()]).then(() =>
      setCashflowChartTick((n) => n + 1),
    );
    const bump = () => setCashflowChartTick((n) => n + 1);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    window.addEventListener(MANAGER_OUTGOING_PAYMENTS_EVENT, bump);
    return () => {
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
      window.removeEventListener(MANAGER_OUTGOING_PAYMENTS_EVENT, bump);
    };
  }, [ready, tabId, userId]);

  const propertyOptions = useMemo(() => {
    void propertyTick;
    return buildManagerPropertyFilterOptions(userId ?? null);
  }, [userId, propertyTick]);

  const activeVendors = useMemo(() => {
    void vendorTick;
    return readActiveManagerVendorRows();
  }, [userId, vendorTick]);

  useEffect(() => {
    if (!ready) return;
    // Not forced: the pipeline sync has a session TTL + in-flight guard, so
    // tab switches reuse fresh data instead of refetching the full snapshot.
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
    void syncManagerVendorsFromServer();
    const onVendors = () => setVendorTick((n) => n + 1);
    window.addEventListener(MANAGER_VENDORS_EVENT, onVendors);
    return () => window.removeEventListener(MANAGER_VENDORS_EVENT, onVendors);
  }, [ready, userId]);

  const loadTable = useCallback(async () => {
    if (!ready) return;
    if (isDemoModeActive()) {
      // No authenticated reports API in the sandbox — build the same report
      // shapes from the browser-local demo stores instead.
      const { buildDemoFinanceReport } = await import("@/lib/demo/demo-finance-reports");
      setReport(buildDemoFinanceReport(reportId, filters.propertyId || undefined));
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ from: filters.from, to: filters.to });
      if (filters.propertyId) params.set("propertyId", filters.propertyId);
      const res = await fetch(`/api/reports/${reportId}?${params}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load finances.");
      setReport(data as ReportResult);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Failed to load finances.");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [reportId, filters, showToast, ready]);

  useEffect(() => {
    const defaults = DEFAULT_SORT[tabId] ?? { key: "date", dir: "desc" as const };
    queueMicrotask(() => {
      setSortKey(defaults.key);
      setSortDir(defaults.dir);
      setRowFilters(emptyRowFilters());
      setSearchQuery("");
    });
  }, [tabId]);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => void loadTable(), 250);
    return () => window.clearTimeout(timer);
  }, [loadTable, ready, tabId]);

  async function saveIncome() {
    const amountCents = Math.round(Number.parseFloat(incomeDraft.amount.replace(/[^0-9.]/g, "")) * 100);
    if (!(amountCents > 0)) {
      showToast("Enter a valid amount.");
      return;
    }
    if (isDemoModeActive()) {
      showToast("Income entries are simulated in this demo.");
      setIncomeModal(false);
      return;
    }
    const res = await fetch("/api/income", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryCode: incomeDraft.categoryCode,
        amountCents,
        postedDate: incomeDraft.postedDate,
        description: incomeDraft.description,
        propertyId: incomeDraft.propertyId || filters.propertyId || undefined,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to save income.");
      return;
    }
    showToast("Income saved.");
    setIncomeModal(false);
    void loadTable();
  }

  async function saveExpense() {
    const amountCents = Math.round(Number.parseFloat(expenseDraft.amount.replace(/[^0-9.]/g, "")) * 100);
    if (!(amountCents > 0)) {
      showToast("Enter a valid amount.");
      return;
    }
    if (isDemoModeActive()) {
      showToast("Expenses are simulated in this demo.");
      setExpenseModal(false);
      return;
    }
    const res = await fetch("/api/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        categoryCode: expenseDraft.categoryCode,
        amountCents,
        expenseDate: expenseDraft.expenseDate,
        memo: expenseDraft.memo,
        vendorId: expenseDraft.vendorId || undefined,
        propertyId: expenseDraft.propertyId || filters.propertyId || undefined,
        taxDeductible: expenseDraft.taxDeductible,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to save expense.");
      return;
    }
    showToast("Expense saved.");
    setExpenseModal(false);
    void loadTable();
  }

  async function updateExpenseTaxStatus(expenseId: string, deductible: boolean) {
    if (isDemoModeActive()) {
      showToast("Tax status changes are simulated in this demo.");
      return;
    }
    const res = await fetch("/api/expenses", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: expenseId, taxDeductible: deductible }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error ?? "Failed to update tax status.");
      return;
    }
    showToast(`Marked ${expenseTaxStatusLabel(deductible).toLowerCase()}.`);
    void loadTable();
  }

  function onHeaderSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "date" || key === "amount" ? "desc" : "asc");
    }
  }

  const query = (() => {
    const params = new URLSearchParams({ from: filters.from, to: filters.to });
    if (filters.propertyId) params.set("propertyId", filters.propertyId);
    return params.toString();
  })();

  const financeTabItems = useMemo(
    () => FINANCE_TABS.map((tab) => ({ ...tab, href: `${basePath}/financials/${tab.id}` })),
    [basePath],
  );

  const specialFinancePanels = new Set(["bills", "bank-reconciliation", "security-deposits", "owner-distributions"]);
  const showScopedReportFilters = !specialFinancePanels.has(tabId);
  const showTransactionSearch = tabId === "income" || tabId === "expenses";
  const activeDefaultSort = DEFAULT_SORT[tabId] ?? { key: "date", dir: "desc" as const };
  const financeSortOptions = (report?.columns ?? [])
    .filter((column) => !HIDDEN_FINANCE_COLS.has(column.key))
    .map((column) => ({ value: column.key, label: column.label }));
  const defaultFinanceFilters = defaultFilters();
  const dateRangeChanged =
    filters.from !== defaultFinanceFilters.from || filters.to !== defaultFinanceFilters.to;
  const sortChanged = sortKey !== activeDefaultSort.key || sortDir !== activeDefaultSort.dir;

  const resetFinanceFilters = () => {
    setFilters(defaultFilters());
    setRowFilters(emptyRowFilters());
    setSortKey(activeDefaultSort.key);
    setSortDir(activeDefaultSort.dir);
  };

  const financeFilterSheetFieldCount = financeFilterFieldCount({
    tabId,
    hasProperty: propertyOptions.length > 0,
    hasRowFilters: !LEDGER_TAB_IDS.has(tabId) && Boolean(report && report.rows.length > 0),
    hasSortOptions: financeSortOptions.length > 0,
  });

  const financesFilterSheetProps = {
    activeCount: portalFilterActiveCount([
      filters.propertyId,
      rowFilters.resident,
      rowFilters.type,
      rowFilters.category,
      rowFilters.vendor,
      dateRangeChanged,
      sortChanged,
    ]),
    onReset: resetFinanceFilters,
    tabId,
    propertyOptions,
    filters,
    onFiltersChange: (next: Partial<ReportFilterState>) => setFilters((current) => ({ ...current, ...next })),
    report,
    rowFilters,
    onRowFiltersChange: (next: Partial<FinanceRowFilterState>) =>
      setRowFilters((current) => ({ ...current, ...next })),
    sortOptions: financeSortOptions,
    sortKey,
    onSortKeyChange: setSortKey,
    sortDir,
    onSortDirChange: setSortDir,
    filterFieldCount: financeFilterSheetFieldCount,
    defaultFilters: defaultFinanceFilters,
    defaultRowFilters: emptyRowFilters(),
    defaultSortKey: activeDefaultSort.key,
    defaultSortDir: activeDefaultSort.dir,
  };

  const financesFilterControl = showScopedReportFilters ? (
    <FinancesFilterSheet {...financesFilterSheetProps} />
  ) : null;

  const activeFinanceFilterChips = useMemo((): PortalActiveFilterChip[] => {
    if (!showScopedReportFilters) return [];
    const chips: PortalActiveFilterChip[] = [];
    const defaults = defaultFilters();
    if (filters.propertyId) {
      const label = propertyOptions.find((p) => p.id === filters.propertyId)?.label ?? filters.propertyId;
      chips.push({ id: "property", label: `Property: ${label}`, onRemove: () => setFilters((f) => ({ ...f, propertyId: "" })) });
    }
    if (filters.from !== defaults.from || filters.to !== defaults.to) {
      chips.push({
        id: "dates",
        label: `Dates: ${filters.from} – ${filters.to}`,
        onRemove: () => setFilters((f) => ({ ...f, from: defaults.from, to: defaults.to })),
      });
    }
    if (sortChanged) {
      const sortLabel = financeSortOptions.find((option) => option.value === sortKey)?.label ?? sortKey;
      chips.push({
        id: "sort",
        label: `Sort: ${sortLabel} · ${sortDir === "asc" ? "Ascending" : "Descending"}`,
        onRemove: () => {
          setSortKey(activeDefaultSort.key);
          setSortDir(activeDefaultSort.dir);
        },
      });
    }
    if (tabId === "income") {
      if (rowFilters.resident) chips.push({ id: "resident", label: `Resident: ${rowFilters.resident}`, onRemove: () => setRowFilters((f) => ({ ...f, resident: "" })) });
      if (rowFilters.type) chips.push({ id: "type", label: `Type: ${rowFilters.type}`, onRemove: () => setRowFilters((f) => ({ ...f, type: "" })) });
    } else if (tabId === "expenses") {
      if (rowFilters.category) chips.push({ id: "category", label: `Category: ${rowFilters.category}`, onRemove: () => setRowFilters((f) => ({ ...f, category: "" })) });
      if (rowFilters.vendor) chips.push({ id: "vendor", label: `Vendor: ${rowFilters.vendor}`, onRemove: () => setRowFilters((f) => ({ ...f, vendor: "" })) });
    }
    return chips;
  }, [
    showScopedReportFilters,
    filters,
    rowFilters,
    tabId,
    propertyOptions,
    sortChanged,
    financeSortOptions,
    sortKey,
    sortDir,
    activeDefaultSort.key,
    activeDefaultSort.dir,
  ]);

  function openAddIncome() {
    setIncomeDraft({
      categoryCode: "other_income",
      amount: "",
      postedDate: new Date().toISOString().slice(0, 10),
      description: "",
      propertyId: filters.propertyId,
    });
    setIncomeModal(true);
  }

  function openAddExpense() {
    setExpenseDraft({
      categoryCode: "maintenance",
      amount: "",
      expenseDate: new Date().toISOString().slice(0, 10),
      memo: "",
      vendorId: "",
      propertyId: filters.propertyId,
      taxDeductible: isCategoryDeductible("maintenance"),
      taxTouched: false,
    });
    setExpenseModal(true);
  }

  const financesFormalPdfLink =
    tabId === "owner-statement" ? (
      <a
        href={`/api/reports/owner-statement/formal-export?${query}`}
        className={`inline-flex items-center justify-center ${PORTAL_HEADER_ACTION_BTN}`}
        data-attr="owner-statement-formal-pdf"
      >
        Formal PDF
      </a>
    ) : null;

  const financesExportButtons =
    report && report.rows.length > 0 ? (
      <ReportExportButtons
        reportId={reportId}
        query={query}
        formats={tabId === "general-ledger" ? ["csv", "pdf", "quickbooks"] : ["csv"]}
      />
    ) : tabId === "general-ledger" ? (
      <ReportExportButtons reportId={reportId} query={query} formats={["quickbooks"]} />
    ) : null;

  const financesAddButton =
    tabId === "income" ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN}
        onClick={openAddIncome}
        data-attr="finances-add-income"
      >
        Add
      </Button>
    ) : tabId === "expenses" ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN}
        onClick={openAddExpense}
        data-attr="finances-add-expense"
      >
        Add
      </Button>
    ) : tabId === "bills" ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN}
        onClick={() => billsRef.current?.openAddBill()}
        data-attr="finances-add-bill"
      >
        Add bill
      </Button>
    ) : tabId === "bank-reconciliation" ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN}
        onClick={() => bankReconciliationRef.current?.openAddAccount()}
        data-attr="bank-add-account"
      >
        Add account
      </Button>
    ) : tabId === "owner-distributions" ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_PRIMARY_ACTION_BTN}
        onClick={() => ownerDistributionsRef.current?.openNewDistribution()}
        data-attr="finances-add-distribution"
      >
        New distribution
      </Button>
    ) : null;

  const financesBankStatementButton =
    tabId === "bank-reconciliation" ? (
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_ACTION_BTN}
        disabled={!canAddBankStatement}
        onClick={() => bankReconciliationRef.current?.openAddStatement()}
        data-attr="bank-add-statement"
      >
        Add statement
      </Button>
    ) : null;

  const financesListAddRow =
    tabId === "income" || tabId === "expenses" ? (
      <PortalListAddRow
        label="Add"
        icon={PORTAL_LIST_ADD_ICONS.payment}
        onClick={tabId === "income" ? openAddIncome : openAddExpense}
        dataAttr={tabId === "income" ? "finances-list-add-income" : "finances-list-add-expense"}
      />
    ) : null;

  const financesDestinationRow = (
    <FinanceDestinationNav tabId={tabId} tabItems={financeTabItems} />
  );

  const financesSecondaryActions =
    financesFormalPdfLink ||
    financesExportButtons ||
    financesAddButton ||
    financesBankStatementButton ? (
      <PortalAdaptiveHeaderActions
        className="w-full min-w-0"
        moreDataAttr="finances-more-actions"
        moreAriaLabel="More finance actions"
        actions={[
          ...(financesFormalPdfLink
            ? [
                {
                  id: "formal-pdf",
                  keepPriority: 2,
                  node: financesFormalPdfLink,
                  menuItem: (
                    <DropdownMenuItem asChild>
                      <a href={`/api/reports/owner-statement/formal-export?${query}`} data-attr="owner-statement-formal-pdf-menu">
                        Formal PDF
                      </a>
                    </DropdownMenuItem>
                  ),
                },
              ]
            : []),
          ...(financesExportButtons
            ? [
                {
                  id: "export",
                  keepPriority: 2,
                  node: financesExportButtons,
                  menuItem: (
                    <DropdownMenuItem disabled className="text-muted">
                      Export options
                    </DropdownMenuItem>
                  ),
                },
              ]
            : []),
          ...(financesBankStatementButton
            ? [
                {
                  id: "bank-statement",
                  keepPriority: 2,
                  node: financesBankStatementButton,
                  menuItem: (
                    <DropdownMenuItem
                      data-attr="bank-add-statement-menu"
                      disabled={!canAddBankStatement}
                      onSelect={() => bankReconciliationRef.current?.openAddStatement()}
                    >
                      Add statement
                    </DropdownMenuItem>
                  ),
                },
              ]
            : []),
          ...(financesAddButton
            ? [
                {
                  id: "add",
                  alwaysVisible: true,
                  pinEdge: "end" as const,
                  node: financesAddButton,
                  menuItem: (
                    <DropdownMenuItem
                      data-attr="finances-add-menu"
                      onSelect={() => {
                        if (tabId === "income") openAddIncome();
                        else if (tabId === "expenses") openAddExpense();
                        else if (tabId === "bills") billsRef.current?.openAddBill();
                        else if (tabId === "bank-reconciliation") bankReconciliationRef.current?.openAddAccount();
                        else if (tabId === "owner-distributions") ownerDistributionsRef.current?.openNewDistribution();
                      }}
                    >
                      {tabId === "owner-distributions" ? "New distribution" : tabId === "bills" ? "Add bill" : tabId === "bank-reconciliation" ? "Add account" : "Add"}
                    </DropdownMenuItem>
                  ),
                },
              ]
            : []),
        ]}
      />
    ) : null;

  const financesTitleAside = financesSecondaryActions;

  const financesInlineFilter = showScopedReportFilters
    ? financesFilterControl
    : financesTitleAside
      ? null
      : undefined;

  return (
    <ManagerPortalPageShell
      title="Finances"
      titleInlineFilter={financesInlineFilter}
      titleAside={financesTitleAside}
      hideTitleOnMobileNav
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        destinationRow={financesDestinationRow}
        stickyDestinations={false}
        destinationInset
        search={
          showTransactionSearch
            ? {
                value: searchQuery,
                onChange: setSearchQuery,
                placeholder: `Search ${tabId}`,
                dataAttr: "finances-search",
              }
            : undefined
        }
        activeFilterChips={
          activeFinanceFilterChips.length > 0 ? (
            <PortalActiveFilterChips chips={activeFinanceFilterChips} />
          ) : null
        }
      />
      {tabId === "bills" ? (
        <ManagerBillsPanel ref={billsRef} />
      ) : tabId === "bank-reconciliation" ? (
        <ManagerBankReconciliationPanel
          ref={bankReconciliationRef}
          onCanAddStatementChange={setCanAddBankStatement}
        />
      ) : tabId === "security-deposits" ? (
        <ManagerSecurityDepositsPanel />
      ) : tabId === "owner-distributions" ? (
        <ManagerOwnerDistributionsPanel ref={ownerDistributionsRef} />
      ) : (
      <div className="min-w-0 space-y-4 max-lg:space-y-3">
        {tabId === "budget-vs-actual" ? <ManagerBudgetsPanel /> : null}
        {tabId === "cash-flow-statement" ? (
          <MonthlyProfitChart points={monthlyProfitPoints} />
        ) : null}

        {loading && !report ? (
          <div className={PORTAL_DATA_TABLE_WRAP}>
            <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">Loading entries…</div>
          </div>
        ) : filteredReport ? (
          <div className="space-y-3">
            {filteredReport.rows.length === 0 ? (
              report && report.rows.length > 0 ? (
                <PortalDataTableEmpty message="No finance entries match your search or filters." icon="finance" />
              ) : financesListAddRow ? null : (
                <PortalDataTableEmpty message="No finance entries yet." icon="finance" />
              )
            ) : (
              <FinancesDataTable
                report={filteredReport}
                sortKey={sortKey}
                sortDir={sortDir}
                onHeaderSort={onHeaderSort}
                onTaxStatusChange={tabId === "expenses" ? (id, d) => void updateExpenseTaxStatus(id, d) : undefined}
              />
            )}
            {financesListAddRow ? (
              <div className={`${PORTAL_LIST_ADD_ROW_WRAP_CLASS} ${filteredReport && filteredReport.rows.length > 0 ? "pt-5 sm:pt-6" : ""}`}>
                {financesListAddRow}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <PortalDataTableEmpty message="No finance entries yet." icon="finance" />
            {financesListAddRow ? (
              <div className={`${PORTAL_LIST_ADD_ROW_WRAP_CLASS} pt-5 sm:pt-6`}>{financesListAddRow}</div>
            ) : null}
          </div>
        )}
      </div>
      )}

      <Modal
        open={expenseModal}
        onClose={() => setExpenseModal(false)}
        title="Add expense"
        footer={
          <ModalFooter>
            <Button variant="primary" onClick={() => saveExpense()}>
              Save expense
            </Button>
          </ModalFooter>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Property
            <Select
              value={expenseDraft.propertyId}
              onChange={(e) => setExpenseDraft({ ...expenseDraft, propertyId: e.target.value })}
            >
              <option value="">All properties / unassigned</option>
              {propertyOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Category
            <Select
              value={expenseDraft.categoryCode}
              onChange={(e) =>
                setExpenseDraft((d) => ({
                  ...d,
                  categoryCode: e.target.value,
                  taxDeductible: d.taxTouched ? d.taxDeductible : isCategoryDeductible(e.target.value),
                }))
              }
            >
              {EXPENSE_CATEGORIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-2 text-xs font-medium text-muted sm:col-span-2">
            Tax status (suggested from category)
            <ExpenseTaxStatusToggle
              deductible={expenseDraft.taxDeductible}
              onChange={(taxDeductible) =>
                setExpenseDraft((d) => ({
                  ...d,
                  taxDeductible,
                  taxTouched: true,
                }))
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Amount (USD)
            <Input value={expenseDraft.amount} onChange={(e) => setExpenseDraft({ ...expenseDraft, amount: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Date
            <Input
              type="date"
              value={expenseDraft.expenseDate}
              onChange={(e) => setExpenseDraft({ ...expenseDraft, expenseDate: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Vendor (optional, for 1099)
            <Select
              value={expenseDraft.vendorId}
              onChange={(e) => setExpenseDraft({ ...expenseDraft, vendorId: e.target.value })}
            >
              <option value="">No vendor</option>
              {activeVendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                  {v.trade ? ` · ${v.trade}` : ""}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Description / memo
            <Input value={expenseDraft.memo} onChange={(e) => setExpenseDraft({ ...expenseDraft, memo: e.target.value })} />
          </label>
        </div>
      </Modal>

      <Modal
        open={incomeModal}
        onClose={() => setIncomeModal(false)}
        title="Add income"
        footer={
          <ModalFooter>
            <Button variant="primary" onClick={() => saveIncome()}>
              Save income
            </Button>
          </ModalFooter>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Property
            <Select
              value={incomeDraft.propertyId}
              onChange={(e) => setIncomeDraft({ ...incomeDraft, propertyId: e.target.value })}
            >
              <option value="">All properties / unassigned</option>
              {propertyOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Type
            <Select
              value={incomeDraft.categoryCode}
              onChange={(e) => setIncomeDraft({ ...incomeDraft, categoryCode: e.target.value })}
            >
              {INCOME_CATEGORIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Amount (USD)
            <Input value={incomeDraft.amount} onChange={(e) => setIncomeDraft({ ...incomeDraft, amount: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            Date received
            <Input
              type="date"
              value={incomeDraft.postedDate}
              onChange={(e) => setIncomeDraft({ ...incomeDraft, postedDate: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
            Description
            <Input
              value={incomeDraft.description}
              onChange={(e) => setIncomeDraft({ ...incomeDraft, description: e.target.value })}
              placeholder="e.g. Utilities reimbursement"
            />
          </label>
        </div>
      </Modal>
    </ManagerPortalPageShell>
  );
}
