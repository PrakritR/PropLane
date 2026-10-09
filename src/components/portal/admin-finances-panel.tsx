"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AppWindow,
  ChevronLeft,
  ChevronRight,
  Database,
  Download,
  Globe,
  Mail,
  Megaphone,
  MessageSquare,
  Paperclip,
  Receipt,
  Repeat,
  Scale,
  Server,
  Smartphone,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalEntryRow } from "@/components/portal/portal-entry-row";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import {
  FilterCollapsibleSection,
  FilterFieldsAccordion,
  FilterSingleSelectList,
  filterSingleSelectSummary,
  useFilterAccordionClose,
} from "@/components/portal/filter-field-lists";
import { AdminAddExpenseWizard } from "@/components/portal/admin-add-expense-wizard";
import { Button } from "@/components/ui/button";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import { downloadCsv, toSafeCsv, csvMoneyFromCents } from "@/lib/csv";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { pacificCalendarDateYmd, pacificCalendarMonthKey } from "@/lib/pacific-time";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_RECURRENCE_LABELS,
  REVENUE_STREAM_LABELS,
  computeMonthlyPnl,
  emptyStreams,
  expandExpensesForMonth,
  expenseCategoryLabel,
  expenseTotalsByCategory,
  expenseTotalsByMonth,
  formatCents,
  formatMonthLabel,
  monthsEndingAt,
  shiftMonth,
  type ExpenseOccurrence,
  type MonthlyPnl,
  type PlatformExpense,
  type RevenueStreams,
} from "@/lib/admin/platform-expense-rules";
import type { PlatformPnl } from "@/lib/admin/platform-pnl.server";

const FETCH_TIMEOUT_MS = 30_000;

type TabId = "expenses" | "recurring" | "categories";

const CATEGORY_ICON: Record<string, LucideIcon> = {
  hosting: Server,
  database: Database,
  messaging: MessageSquare,
  ai_models: Sparkles,
  email: Mail,
  domains: Globe,
  app_store: Smartphone,
  software: AppWindow,
  marketing: Megaphone,
  contractors: Users,
  legal_accounting: Scale,
  other: Receipt,
};

type Revenue = PlatformPnl["months"][number];

function categoryIcon(category: string) {
  return CATEGORY_ICON[category] ?? Receipt;
}

function shortDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string };
}

/**
 * Money > Finances: the month's profit and loss (revenue by stream, less Stripe fees and expenses), a
 * twelve-month chart, and the expenses behind it. Revenue and fees come from Stripe through
 * /api/admin/finances; expenses are entered by hand (decision D7) and a recurring one is expanded into
 * every month it covers, so editing it moves every month at once.
 */
export function AdminFinancesPanel() {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const currentMonth = useMemo(() => pacificCalendarMonthKey(Date.now()), []);
  const months = useMemo(() => monthsEndingAt(currentMonth, 12), [currentMonth]);

  const [revenue, setRevenue] = useState<PlatformPnl | null>(null);
  const [revenueError, setRevenueError] = useState(false);
  const [expenses, setExpenses] = useState<PlatformExpense[] | null>(null);
  const [expensesError, setExpensesError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [month, setMonth] = useState(currentMonth);
  const [tab, setTab] = useState<TabId>("expenses");
  const [category, setCategory] = useState("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<PlatformExpense | null>(null);
  const [busy, setBusy] = useState(false);

  const reloadAll = useCallback(() => {
    setRevenue(null);
    setRevenueError(false);
    setExpenses(null);
    setExpensesError(null);
    setTick((n) => n + 1);
  }, []);

  // Stripe is read once per load (and cached on the server); expenses reload alone after an edit.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/admin/finances", { credentials: "include" }, FETCH_TIMEOUT_MS);
        const json = await readJson<PlatformPnl>(res);
        if (cancelled) return;
        if (!res.ok || !json.months) {
          setRevenueError(true);
          return;
        }
        setRevenue(json);
      } catch {
        if (!cancelled) setRevenueError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const loadExpenses = useCallback(async () => {
    try {
      const res = await fetchWithTimeout(
        `/api/admin/expenses?from=${months[0]}&to=${currentMonth}`,
        { credentials: "include" },
        FETCH_TIMEOUT_MS,
      );
      const json = await readJson<{ expenses?: PlatformExpense[] }>(res);
      if (!res.ok || !json.expenses) {
        setExpensesError(json.error ?? "Could not load expenses.");
        return;
      }
      setExpenses(json.expenses);
      setExpensesError(null);
    } catch {
      setExpensesError("Could not load expenses.");
    }
  }, [months, currentMonth]);

  useEffect(() => {
    void loadExpenses();
  }, [loadExpenses, tick]);

  const revenueByMonth = useMemo(() => {
    const map = new Map<string, Revenue>();
    for (const row of revenue?.months ?? []) map.set(row.month, row);
    return map;
  }, [revenue]);

  const pnlByMonth = useMemo(() => {
    const totals = expenseTotalsByMonth(expenses ?? [], months);
    const map = new Map<string, MonthlyPnl>();
    for (const m of months) {
      const r = revenueByMonth.get(m);
      map.set(
        m,
        computeMonthlyPnl({
          month: m,
          streams: r?.streams ?? emptyStreams(),
          refundsCents: r?.refundsCents ?? 0,
          stripeFeesCents: r?.stripeFeesCents ?? 0,
          unclassifiedCents: r?.unclassifiedCents ?? 0,
          expensesCents: totals.get(m) ?? 0,
        }),
      );
    }
    return map;
  }, [expenses, months, revenueByMonth]);

  const revenueKnown = Boolean(revenue?.revenueAvailable);
  const pnl = pnlByMonth.get(month) ?? computeMonthlyPnl({ month, streams: emptyStreams() });

  const occurrences = useMemo(() => expandExpensesForMonth(expenses ?? [], month), [expenses, month]);
  const shownOccurrences = useMemo(
    () => (category === "all" ? occurrences : occurrences.filter((o) => o.expense.category === category)),
    [occurrences, category],
  );
  const recurring = useMemo(
    () =>
      (expenses ?? [])
        .filter((e) => e.recurrence !== "none" && (category === "all" || e.category === category))
        .filter((e) => !e.endsOn || e.endsOn >= `${month}-01`),
    [expenses, category, month],
  );
  const categories = useMemo(() => expenseTotalsByCategory(occurrences), [occurrences]);

  const tabCounts: Record<TabId, number> = {
    expenses: shownOccurrences.length,
    recurring: recurring.length,
    categories: categories.length,
  };

  const selectedExpenseId =
    tab === "expenses"
      ? (shownOccurrences.find((o) => `${o.expenseId}:${o.date}` === selectedKey)?.expenseId ?? null)
      : tab === "recurring"
        ? (recurring.find((e) => e.id === selectedKey)?.id ?? null)
        : null;
  const selectedExpense = (expenses ?? []).find((e) => e.id === selectedExpenseId) ?? null;

  const refreshExpenses = useCallback(async () => {
    setSelectedKey(null);
    await loadExpenses();
  }, [loadExpenses]);

  const deleteExpense = async (expense: PlatformExpense) => {
    const ok = await confirm({
      title: "Delete expense",
      description:
        expense.recurrence === "none"
          ? `Delete ${formatCents(expense.amountCents)} to ${expense.vendor}?`
          : `Delete ${expense.vendor}? Every month it covers loses this expense.`,
      confirmLabel: "Delete expense",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/expenses?id=${encodeURIComponent(expense.id)}`, { method: "DELETE", credentials: "include" });
      const json = await readJson<Record<string, unknown>>(res);
      if (!res.ok) {
        showToast(json.error ?? "Could not delete the expense.");
        return;
      }
      showToast("Expense deleted.");
      await refreshExpenses();
    } catch {
      showToast("Could not delete the expense.");
    } finally {
      setBusy(false);
    }
  };

  const duplicateExpense = async (expense: PlatformExpense, occurrenceDate?: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/expenses", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category: expense.category,
          vendor: expense.vendor,
          amountCents: expense.amountCents,
          spentOn: expense.recurrence === "none" ? (occurrenceDate ?? expense.spentOn) : pacificCalendarDateYmd(),
          recurrence: expense.recurrence,
          endsOn: null,
          receiptPath: null,
          note: expense.note,
        }),
      });
      const json = await readJson<Record<string, unknown>>(res);
      if (!res.ok) {
        showToast(json.error ?? "Could not duplicate the expense.");
        return;
      }
      showToast("Expense duplicated.");
      await refreshExpenses();
    } catch {
      showToast("Could not duplicate the expense.");
    } finally {
      setBusy(false);
    }
  };

  const openReceipt = async (expense: PlatformExpense) => {
    try {
      const res = await fetch(`/api/admin/expenses/receipt?id=${encodeURIComponent(expense.id)}`, { credentials: "include" });
      const json = await readJson<{ url?: string }>(res);
      if (!res.ok || !json.url) {
        showToast(json.error ?? "Could not open the receipt.");
        return;
      }
      window.open(json.url, "_blank", "noopener");
    } catch {
      showToast("Could not open the receipt.");
    }
  };

  const exportMonth = () => {
    const rows: unknown[][] = [["Date", "Vendor", "Category", "Amount", "Repeats", "Note"]];
    for (const o of occurrences) {
      rows.push([o.date, o.expense.vendor, expenseCategoryLabel(o.expense.category), csvMoneyFromCents(o.amountCents), EXPENSE_RECURRENCE_LABELS[o.expense.recurrence], o.expense.note]);
    }
    downloadCsv(`proplane-expenses-${month}.csv`, toSafeCsv(rows));
  };

  const bulkActions = selectedExpense ? (
    <>
      <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-expense-edit" onClick={() => { setEditing(selectedExpense); setWizardOpen(true); }}>
        Edit
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_BULK_BAR_BTN}
        disabled={busy}
        data-attr="admin-expense-duplicate"
        onClick={() => void duplicateExpense(selectedExpense, shownOccurrences.find((o) => o.expenseId === selectedExpense.id)?.date)}
      >
        Duplicate
      </Button>
      {selectedExpense.receiptPath ? (
        <Button type="button" variant="outline" className={PORTAL_BULK_BAR_BTN} data-attr="admin-expense-receipt" onClick={() => void openReceipt(selectedExpense)}>
          Receipt
        </Button>
      ) : null}
      <Button type="button" variant="danger" className={PORTAL_BULK_BAR_BTN} disabled={busy} data-attr="admin-expense-delete" onClick={() => void deleteExpense(selectedExpense)}>
        Delete
      </Button>
    </>
  ) : null;

  const loading = expenses === null && !expensesError;

  const rowFacts = (expense: PlatformExpense) => [
    ...(expense.recurrence !== "none" ? [{ icon: Repeat, label: EXPENSE_RECURRENCE_LABELS[expense.recurrence], srLabel: "Repeats" }] : []),
    ...(expense.receiptPath ? [{ icon: Paperclip, label: "Receipt", srLabel: "Receipt" }] : []),
  ];

  const renderOccurrence = (o: ExpenseOccurrence) => (
    <PortalEntryRow
      key={`${o.expenseId}:${o.date}`}
      tile={{ kind: "glyph", icon: categoryIcon(o.expense.category), label: expenseCategoryLabel(o.expense.category) }}
      title={o.expense.vendor}
      place={`${expenseCategoryLabel(o.expense.category)} · ${shortDay(o.date)}`}
      facts={rowFacts(o.expense)}
      figure={{ value: `−${formatCents(o.amountCents)}` }}
      checked={selectedKey === `${o.expenseId}:${o.date}`}
      onSelectedChange={(on) => setSelectedKey(on ? `${o.expenseId}:${o.date}` : null)}
      onOpen={() => { setEditing(o.expense); setWizardOpen(true); }}
      dataAttr="admin-expense-row"
    />
  );

  return (
    <ManagerPortalPageShell title="Finances" hideTitleOnMobileNav navigationProvidesTitle titleInlineFilter={null} compactFilterRow>
      <PnlCard
        month={month}
        months={months}
        pnl={pnl}
        pnlByMonth={pnlByMonth}
        revenueKnown={revenueKnown}
        revenueLoading={!revenue && !revenueError}
        revenueError={revenueError || (revenue !== null && !revenue.revenueAvailable)}
        revenueTruncated={Boolean(revenue?.revenueTruncated)}
        testMode={Boolean(revenue?.testMode)}
        onMonth={(next) => { setMonth(next); setSelectedKey(null); }}
        onRetry={reloadAll}
      />
      <PortalListControlStack
        className="mb-2"
        variant="command"
        stickyDestinations={false}
        destinationRow={
          <LocalDestinationNav
            appearance="command"
            items={(["expenses", "recurring", "categories"] as const).map((id) => ({
              id,
              label: id === "expenses" ? "Expenses" : id === "recurring" ? "Recurring" : "Categories",
              count: expenses ? tabCounts[id] : undefined,
              dataAttr: `admin-finances-tab-${id}`,
            }))}
            activeId={tab}
            onChange={(id) => {
              setTab(id as TabId);
              setSelectedKey(null);
            }}
            ariaLabel="Finances"
          />
        }
        filterRow={
          <PortalFilterSortSheet
            activeCount={portalFilterActiveCount([category !== "all" ? category : ""])}
            compactPanel
            commandStripTrigger
            filterFieldCount={1}
            constrainDropdownToTitleBand={false}
            mobileFlushBody
            onReset={() => setCategory("all")}
            dataAttr="admin-finances-filter-sheet-open"
          >
            <FilterFieldsAccordion>
              <CategoryFilterField value={category} onChange={setCategory} />
            </FilterFieldsAccordion>
          </PortalFilterSortSheet>
        }
        actions={<PortalIconAction icon={Download} label="Download this month as CSV" data-attr="admin-finances-download" onClick={exportMonth} disabled={occurrences.length === 0} />}
        primary={<PortalPrimaryIconAction label="Add expense" data-attr="admin-finances-add" onClick={() => { setEditing(null); setWizardOpen(true); }} />}
      />


      <PortalRecordListSurface
        loading={loading}
        loadError={expensesError ?? undefined}
        onRetry={() => { setExpenses(null); setExpensesError(null); void loadExpenses(); }}
        isEmpty={tab === "expenses" ? shownOccurrences.length === 0 : tab === "recurring" ? recurring.length === 0 : categories.length === 0}
        empty={
          <PortalDataTableEmpty
            icon="data"
            message={tab === "recurring" ? "No recurring expenses" : tab === "categories" ? "No expenses this month" : `No expenses in ${formatMonthLabel(month)}`}
          />
        }
        bulkCount={selectedExpense ? 1 : 0}
        bulkActions={bulkActions}
        onBulkClear={() => setSelectedKey(null)}
        dataAttr="admin-finances-list"
      >
        {tab === "expenses" ? shownOccurrences.map(renderOccurrence) : null}
        {tab === "recurring"
          ? recurring.map((expense) => (
              <PortalEntryRow
                key={expense.id}
                tile={{ kind: "glyph", icon: categoryIcon(expense.category), label: expenseCategoryLabel(expense.category) }}
                title={expense.vendor}
                place={`${expenseCategoryLabel(expense.category)} · since ${shortDay(expense.spentOn)}${expense.endsOn ? ` · ends ${shortDay(expense.endsOn)}` : ""}`}
                facts={rowFacts(expense)}
                figure={{ value: `−${formatCents(expense.amountCents)}`, subLabel: expense.recurrence === "monthly" ? "per month" : "per year" }}
                checked={selectedKey === expense.id}
                onSelectedChange={(on) => setSelectedKey(on ? expense.id : null)}
                onOpen={() => { setEditing(expense); setWizardOpen(true); }}
                dataAttr="admin-recurring-row"
              />
            ))
          : null}
        {tab === "categories"
          ? categories.map((row) => (
              <PortalEntryRow
                key={row.category}
                tile={{ kind: "glyph", icon: categoryIcon(row.category), label: expenseCategoryLabel(row.category) }}
                title={expenseCategoryLabel(row.category)}
                place={`${row.count} ${row.count === 1 ? "expense" : "expenses"}`}
                figure={{ value: `−${formatCents(row.cents)}` }}
                onOpen={() => { setCategory(row.category); setTab("expenses"); }}
                dataAttr="admin-category-row"
              />
            ))
          : null}
      </PortalRecordListSurface>

      <AdminAddExpenseWizard
        open={wizardOpen}
        editing={editing}
        onClose={() => { setWizardOpen(false); setEditing(null); }}
        onSaved={(saved) => {
          setWizardOpen(false);
          setEditing(null);
          showToast(`${saved.vendor} saved.`);
          void refreshExpenses();
        }}
      />
    </ManagerPortalPageShell>
  );
}

function CategoryFilterField({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  const closeFieldMenu = useFilterAccordionClose();
  const options = [{ value: "all", label: "All categories" }, ...EXPENSE_CATEGORIES.map((c) => ({ value: c.id, label: c.label }))];
  return (
    <FilterCollapsibleSection
      sectionId="expense-category"
      label="Category"
      summary={filterSingleSelectSummary(value, options, "All categories")}
      empty={value === "all"}
      menuOptionCount={options.length}
      dataAttr="admin-finances-category-trigger"
    >
      <FilterSingleSelectList options={options} value={value} onChange={onChange} onPick={closeFieldMenu} dataAttr="admin-finances-category" />
    </FilterCollapsibleSection>
  );
}

const STREAM_KEYS = Object.keys(REVENUE_STREAM_LABELS) as Array<keyof RevenueStreams>;

function PnlCard({
  month,
  months,
  pnl,
  pnlByMonth,
  revenueKnown,
  revenueLoading,
  revenueError,
  revenueTruncated,
  testMode,
  onMonth,
  onRetry,
}: {
  month: string;
  months: string[];
  pnl: MonthlyPnl;
  pnlByMonth: Map<string, MonthlyPnl>;
  revenueKnown: boolean;
  revenueLoading: boolean;
  revenueError: boolean;
  revenueTruncated: boolean;
  testMode: boolean;
  onMonth: (month: string) => void;
  onRetry: () => void;
}) {
  const first = months[0]!;
  const last = months[months.length - 1]!;
  const line = "flex items-baseline justify-between gap-3 px-[var(--portal-card-padding,14px)] py-[7px]";
  const money = (cents: number, sign: "" | "−" = "") => (cents === 0 ? formatCents(0) : `${sign}${formatCents(cents)}`);

  return (
    <section className="mb-3 overflow-hidden rounded-[10px] border border-border bg-card" data-attr="admin-finances-pnl">
      <div className="flex items-center gap-2 border-b border-border px-[var(--portal-card-padding,14px)] py-[9px]">
        <h2 className="text-[14px] font-[650] tracking-[-0.01em] text-foreground">Profit and loss</h2>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Month">
          <PortalIconAction icon={ChevronLeft} label="Previous month" disabled={month <= first} data-attr="admin-finances-month-prev" onClick={() => onMonth(shiftMonth(month, -1))} />
          <span className="min-w-[8.5rem] text-center text-[13.5px] font-semibold tabular-nums text-foreground" aria-live="polite" data-attr="admin-finances-month">
            {formatMonthLabel(month)}
          </span>
          <PortalIconAction icon={ChevronRight} label="Next month" disabled={month >= last} data-attr="admin-finances-month-next" onClick={() => onMonth(shiftMonth(month, 1))} />
        </div>
      </div>

      {testMode ? (
        <p className="border-b border-border px-[var(--portal-card-padding,14px)] py-2 text-[13px] font-semibold text-[#a34a06]" role="status">
          Stripe is in test mode
        </p>
      ) : null}

      {revenueTruncated && !revenueError ? (
        <p className="border-b border-border px-[var(--portal-card-padding,14px)] py-2 text-[13px] font-semibold text-[#a34a06]" role="status" data-attr="admin-finances-truncated">
          Stripe returned more rows than one read holds — the oldest months are at least this much
        </p>
      ) : null}

      {revenueError ? (
        <div className="flex items-center justify-between gap-3 border-b border-border px-[var(--portal-card-padding,14px)] py-3" role="alert">
          <span className="text-[13.5px] font-semibold text-foreground">Couldn&apos;t reach Stripe</span>
          <Button type="button" variant="outline" onClick={onRetry} data-attr="admin-finances-retry">
            Retry
          </Button>
        </div>
      ) : null}

      <div className="divide-y divide-border/60 py-1" data-attr="admin-finances-pnl-rows">
        {revenueKnown ? (
          <>
            <div className={line}>
              <span className="text-[14px] font-semibold text-foreground">Revenue</span>
              <span className="text-[14px] font-semibold tabular-nums text-foreground" data-attr="admin-finances-revenue">{money(pnl.revenueCents)}</span>
            </div>
            {STREAM_KEYS.map((key) => (
              <div key={key} className={`${line} pl-[calc(var(--portal-card-padding,14px)+14px)]`}>
                <span className="text-[13.5px] text-muted">{REVENUE_STREAM_LABELS[key]}</span>
                <span className="text-[13.5px] tabular-nums text-foreground">{money(pnl.streams[key])}</span>
              </div>
            ))}
            {pnl.refundsCents > 0 ? (
              <div className={`${line} pl-[calc(var(--portal-card-padding,14px)+14px)]`}>
                <span className="text-[13.5px] text-muted">Refunds</span>
                <span className="text-[13.5px] tabular-nums text-foreground">{money(pnl.refundsCents, "−")}</span>
              </div>
            ) : null}
            <div className={line}>
              <span className="text-[14px] font-semibold text-foreground">Stripe fees</span>
              <span className="text-[14px] font-semibold tabular-nums text-foreground" data-attr="admin-finances-fees">{money(pnl.stripeFeesCents, "−")}</span>
            </div>
          </>
        ) : revenueLoading ? (
          <div className={line}>
            <span className="text-[14px] font-semibold text-foreground">Revenue</span>
            <span className="h-4 w-20 animate-pulse rounded bg-accent" aria-label="Loading" />
          </div>
        ) : null}
        <div className={line}>
          <span className="text-[14px] font-semibold text-foreground">Expenses</span>
          <span className="text-[14px] font-semibold tabular-nums text-foreground" data-attr="admin-finances-expenses">{money(pnl.expensesCents, "−")}</span>
        </div>
        {revenueKnown ? (
          <div className={`${line} border-t-2 border-border`}>
            <span className="text-[15px] font-bold text-foreground">Profit</span>
            <span
              className={`text-[18px] font-bold tabular-nums ${pnl.profitCents < 0 ? "text-[var(--status-overdue-fg)]" : "text-[var(--status-confirmed-fg)]"}`}
              data-attr="admin-finances-profit"
            >
              {formatCents(pnl.profitCents)}
            </span>
          </div>
        ) : null}
        {revenueKnown && pnl.unclassifiedCents > 0 ? (
          <div className={line}>
            <span className="text-[13px] text-muted">Not counted: other Stripe charges</span>
            <span className="text-[13px] tabular-nums text-muted">{formatCents(pnl.unclassifiedCents)}</span>
          </div>
        ) : null}
      </div>

      {revenueKnown ? <PnlChart months={months} pnlByMonth={pnlByMonth} selected={month} onSelect={onMonth} /> : null}
    </section>
  );
}

const CHART_W = 720;
const CHART_H = 190;
const PAD = { l: 8, r: 8, t: 12, b: 26 };

function PnlChart({
  months,
  pnlByMonth,
  selected,
  onSelect,
}: {
  months: string[];
  pnlByMonth: Map<string, MonthlyPnl>;
  selected: string;
  onSelect: (month: string) => void;
}) {
  const rows = months.map((m) => pnlByMonth.get(m)!).filter(Boolean);
  const top = Math.max(1, ...rows.flatMap((r) => [r.revenueCents, r.expensesCents, r.profitCents]));
  const bottom = Math.min(0, ...rows.map((r) => r.profitCents));
  const plotH = CHART_H - PAD.t - PAD.b;
  const y = (cents: number) => PAD.t + ((top - cents) / (top - bottom)) * plotH;
  const slot = (CHART_W - PAD.l - PAD.r) / Math.max(1, rows.length);
  const barW = Math.min(18, slot * 0.28);
  const cx = (i: number) => PAD.l + slot * i + slot / 2;
  const profitPath = rows.map((r, i) => `${i === 0 ? "M" : "L"}${cx(i).toFixed(1)},${y(r.profitCents).toFixed(1)}`).join(" ");
  const summary = `Twelve months of revenue, expenses and profit. ${formatMonthLabel(selected)}: profit ${formatCents(pnlByMonth.get(selected)?.profitCents ?? 0)}.`;

  return (
    <div className="border-t border-border px-[var(--portal-card-padding,14px)] pb-3 pt-3" data-attr="admin-finances-chart">
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="h-auto w-full" role="img" aria-label={summary}>
        <line x1={PAD.l} x2={CHART_W - PAD.r} y1={y(0)} y2={y(0)} stroke="var(--color-border)" strokeWidth={1} />
        {rows.map((r, i) => (
          <g
            key={r.month}
            role="button"
            tabIndex={0}
            aria-label={`${formatMonthLabel(r.month)}: revenue ${formatCents(r.revenueCents)}, expenses ${formatCents(r.expensesCents)}, profit ${formatCents(r.profitCents)}`}
            aria-pressed={r.month === selected}
            className="cursor-pointer outline-none"
            onClick={() => onSelect(r.month)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(r.month);
              }
            }}
            data-attr={`admin-finances-chart-${r.month}`}
          >
            <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={plotH + 14} rx={6} fill={r.month === selected ? "var(--color-primary)" : "transparent"} fillOpacity={0.08} />
            <rect x={cx(i) - barW - 1} y={Math.min(y(0), y(r.revenueCents))} width={barW} height={Math.max(1, Math.abs(y(0) - y(r.revenueCents)))} rx={2} fill="var(--color-primary)" />
            <rect x={cx(i) + 1} y={Math.min(y(0), y(r.expensesCents))} width={barW} height={Math.max(1, Math.abs(y(0) - y(r.expensesCents)))} rx={2} fill="var(--color-muted)" fillOpacity={0.45} />
            <text x={cx(i)} y={CHART_H - 8} textAnchor="middle" fontSize={11.5} fill="var(--color-muted)" fontWeight={r.month === selected ? 700 : 400}>
              {formatMonthLabel(r.month, "short")}
            </text>
          </g>
        ))}
        <path d={profitPath} fill="none" stroke="#15803d" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
        {rows.map((r, i) => (
          <circle key={`dot-${r.month}`} cx={cx(i)} cy={y(r.profitCents)} r={r.month === selected ? 4 : 2.5} fill="#15803d" stroke="var(--color-card)" strokeWidth={1.5} pointerEvents="none" />
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted">
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--color-primary)" }} aria-hidden />Revenue</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: "var(--color-muted)", opacity: 0.45 }} aria-hidden />Expenses</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-0.5 w-3 rounded" style={{ background: "#15803d" }} aria-hidden />Profit</span>
      </div>
    </div>
  );
}
