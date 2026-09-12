"use client";

import Link from "next/link";
import { ArrowDownRight, ArrowRight, ArrowUpRight, ChevronDown, Minus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import {
  HOUSEHOLD_CHARGES_EVENT,
  householdChargeDueDate,
  readChargesForManager,
  syncHouseholdChargesFromServer,
  type HouseholdCharge,
} from "@/lib/household-charges";
import {
  MANAGER_OUTGOING_PAYMENTS_EVENT,
  readManagerOutgoingExpenses,
  syncManagerOutgoingExpensesFromServer,
  type ManagerExpenseSnapshot,
} from "@/lib/manager-outgoing-payments";
import { collectLinkedPropertyIdsForModule, type ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { bucketByMonth, lastNMonths, mergeMonthlyCashflow, parseMoneyLabel } from "@/lib/portal-monthly-profit";
import { cn } from "@/lib/utils";

/**
 * Finances · Overview — the page a manager lands on. Net operating income,
 * rent collected against rent due, expenses with their top category, and the
 * deposit liability, over a chosen period; then the cash-flow chart, expenses
 * by category, net by property, and what falls due in the next two weeks.
 *
 * Every figure comes from the same client stores the Income and Expenses tabs
 * and the dashboard read (household charges, outgoing expenses) — this is a
 * new front on the ledger, not new bookkeeping.
 */

export type FinancesPeriodKind = "month" | "year" | "12m";

export const FINANCES_PERIOD_LABELS: Record<FinancesPeriodKind, string> = {
  month: "This month",
  year: "This year",
  "12m": "Last 12 months",
};

const RENT_KINDS = new Set<HouseholdCharge["kind"]>([
  "rent",
  "first_month_rent",
  "prorated_rent",
  "prorated_last_month_rent",
  "stay_total",
]);
/** Money that is not income: it is held for, or credited back to, the resident. */
const LIABILITY_KINDS = new Set<HouseholdCharge["kind"]>(["security_deposit", "holding_deposit"]);
const OPEN_STATUSES = new Set<HouseholdCharge["status"]>(["pending", "processing", "partially_paid"]);

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const fmt = (n: number) => usd.format(Math.round(n));

function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** `[from, to]` as YYYY-MM-DD for a period ending today, plus the same-length period before it. */
export function financesPeriodBounds(kind: FinancesPeriodKind, nowMs: number): {
  from: string;
  /** Money that has moved counts up to today. */
  to: string;
  /** Rent that is DUE counts to the end of the period: "of $11,700 due" for the whole month or year. */
  dueTo: string;
  prevFrom: string;
  prevTo: string;
} {
  const now = new Date(nowMs);
  const to = pacificCalendarDateYmd();
  if (kind === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const prevStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevEnd = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: ymd(start), to, dueTo: ymd(end), prevFrom: ymd(prevStart), prevTo: ymd(prevEnd) };
  }
  if (kind === "year") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear(), 11, 31);
    const prevStart = new Date(now.getFullYear() - 1, 0, 1);
    const prevEnd = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
    return { from: ymd(start), to, dueTo: ymd(end), prevFrom: ymd(prevStart), prevTo: ymd(prevEnd) };
  }
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const prevStart = new Date(now.getFullYear(), now.getMonth() - 23, 1);
  const prevEnd = new Date(now.getFullYear(), now.getMonth() - 11, 0);
  return { from: ymd(start), to, dueTo: to, prevFrom: ymd(prevStart), prevTo: ymd(prevEnd) };
}

function dateYmd(iso: string | undefined | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return ymd(d);
}

function within(day: string | null, from: string, to: string): boolean {
  return Boolean(day && day >= from && day <= to);
}

function chargeAmount(charge: HouseholdCharge): number {
  return parseMoneyLabel(charge.amountLabel || charge.balanceLabel);
}

function chargePaidAmount(charge: HouseholdCharge): number {
  if (typeof charge.paidAmountCents === "number") return charge.paidAmountCents / 100;
  return charge.status === "paid" ? chargeAmount(charge) : 0;
}

type PeriodTotals = {
  income: number;
  expenses: number;
  rentDue: number;
  rentCollected: number;
};

function totalsFor(
  charges: HouseholdCharge[],
  expenses: ManagerExpenseSnapshot[],
  from: string,
  to: string,
  dueTo: string = to,
): PeriodTotals {
  let income = 0;
  let rentDue = 0;
  let rentCollected = 0;
  for (const charge of charges) {
    if (charge.status === "cancelled" || charge.status === "refunded" || charge.status === "failed") continue;
    const paidDay = dateYmd(charge.paidAt ?? (charge.status === "paid" ? charge.createdAt : null));
    if (!LIABILITY_KINDS.has(charge.kind) && charge.status === "paid" && within(paidDay, from, to)) {
      income += chargePaidAmount(charge);
    }
    if (RENT_KINDS.has(charge.kind)) {
      // A stay total or first month raised "before move-in" has no calendar
      // due date; the day it was raised is the closest thing to one.
      const due = householdChargeDueDate(charge);
      if (within(due ? ymd(due) : dateYmd(charge.createdAt), from, dueTo)) {
        rentDue += chargeAmount(charge);
        rentCollected += chargePaidAmount(charge);
      }
    }
  }
  const expenseTotal = expenses
    .filter((e) => within(dateYmd(e.expenseDate), from, to))
    .reduce((sum, e) => sum + e.amountCents / 100, 0);
  return { income, expenses: expenseTotal, rentDue, rentCollected };
}

function Delta({ current, previous, label }: { current: number; previous: number; label: string }) {
  const diff = current - previous;
  const Arrow = diff > 0 ? ArrowUpRight : diff < 0 ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[11.5px] font-semibold",
        diff > 0 ? "text-[var(--status-confirmed-fg)]" : diff < 0 ? "text-[var(--status-overdue-fg)]" : "text-muted",
      )}
    >
      <Arrow className="size-3" aria-hidden />
      {diff === 0 ? "No change" : `${diff > 0 ? "+" : "–"}${fmt(Math.abs(diff))}`} {label}
    </span>
  );
}

function StatTile({
  label,
  value,
  detail,
  foot,
  href,
  dataAttr,
}: {
  label: string;
  value: string;
  detail?: string;
  foot?: React.ReactNode;
  href?: string;
  dataAttr: string;
}) {
  const body = (
    <>
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      <span className="block truncate text-[1.45rem] font-semibold leading-none tracking-[-0.02em] text-foreground sm:text-[1.65rem]">
        {value}
      </span>
      <span className="truncate text-[12px] font-medium text-muted">{detail ?? ""}</span>
      {foot ? <span className="-mt-0.5 block">{foot}</span> : null}
    </>
  );
  const className =
    "flex min-w-0 flex-col gap-1.5 rounded-2xl border border-border bg-card px-4 py-3.5 shadow-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30";
  return href ? (
    <Link href={href} className={cn(className, "hover:border-primary/35")} data-attr={dataAttr}>
      {body}
    </Link>
  ) : (
    <div className={className} data-attr={dataAttr}>
      {body}
    </div>
  );
}

function Card({
  title,
  action,
  children,
  dataAttr,
  className,
}: {
  title: string;
  action?: { label: string; href: string };
  children: React.ReactNode;
  dataAttr: string;
  className?: string;
}) {
  return (
    <section className={cn("flex min-w-0 flex-col rounded-2xl border border-border bg-card shadow-sm", className)} data-attr={dataAttr}>
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {action ? (
          <Link href={action.href} className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary hover:underline">
            {action.label}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function BarRows({ rows, empty, dataAttr }: { rows: Array<{ id: string; label: string; value: number; detail?: string }>; empty: string; dataAttr: string }) {
  if (rows.length === 0) return <p className="px-4 py-6 text-center text-[13px] text-muted">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="divide-y divide-border/70" data-attr={dataAttr}>
      {rows.map((row) => (
        <li key={row.id} className="px-4 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">{row.label}</span>
            <span className={cn("shrink-0 text-[13.5px] font-semibold tabular-nums", row.value < 0 ? "text-[var(--status-overdue-fg)]" : "text-foreground")}>
              {row.value < 0 ? `–${fmt(Math.abs(row.value))}` : fmt(row.value)}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--secondary)]" aria-hidden>
              <span
                className={cn("block h-full rounded-full", row.value < 0 ? "bg-[var(--status-overdue-fg)]/70" : "bg-primary")}
                style={{ width: `${Math.max(3, Math.round((Math.abs(row.value) / max) * 100))}%` }}
              />
            </span>
            {row.detail ? <span className="shrink-0 text-[11.5px] tabular-nums text-muted">{row.detail}</span> : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function FinancesPeriodSelect({
  value,
  onChange,
}: {
  value: FinancesPeriodKind;
  onChange: (next: FinancesPeriodKind) => void;
}) {
  return (
    <label className="relative inline-flex h-9 shrink-0 items-center rounded-full border border-border bg-card pl-3 pr-8 text-[12.5px] font-semibold text-foreground">
      <span className="sr-only">Period</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as FinancesPeriodKind)}
        data-attr="finances-period"
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Period"
      >
        {(Object.keys(FINANCES_PERIOD_LABELS) as FinancesPeriodKind[]).map((k) => (
          <option key={k} value={k}>
            {FINANCES_PERIOD_LABELS[k]}
          </option>
        ))}
      </select>
      <span aria-hidden>{FINANCES_PERIOD_LABELS[value]}</span>
      <ChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-muted" aria-hidden />
    </label>
  );
}

export function FinancesPropertySelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ManagerPropertyFilterOption[];
  onChange: (next: string) => void;
}) {
  if (options.length === 0) return null;
  const label = options.find((o) => o.id === value)?.label ?? "All properties";
  return (
    <label className="relative hidden h-9 max-w-[14rem] shrink-0 items-center rounded-full border border-border bg-card pl-3 pr-8 text-[12.5px] font-semibold text-foreground md:inline-flex">
      <span className="sr-only">Property</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-attr="finances-property"
        className="absolute inset-0 cursor-pointer opacity-0"
        aria-label="Property"
      >
        <option value="">All properties</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden className="truncate">
        {label}
      </span>
      <ChevronDown className="pointer-events-none absolute right-2.5 size-3.5 text-muted" aria-hidden />
    </label>
  );
}

export function ManagerFinancesOverview({
  userId,
  ready,
  propertyId,
  period,
  basePath,
  propertyOptions,
}: {
  userId: string | null;
  ready: boolean;
  propertyId: string;
  period: FinancesPeriodKind;
  basePath: string;
  propertyOptions: ManagerPropertyFilterOption[];
}) {
  const [tick, setTick] = useState(0);
  // Stamp the clock once per mount (and per refresh) so a render never reads
  // Date.now() and two renders in one tick agree on the window.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the clock is read once per mount/refresh, never in render
    setNowMs(Date.now());
  }, [tick]);

  useEffect(() => {
    if (!ready) return;
    void Promise.all([syncHouseholdChargesFromServer(true), syncManagerOutgoingExpensesFromServer()]).then(() =>
      setTick((n) => n + 1),
    );
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
    window.addEventListener(MANAGER_OUTGOING_PAYMENTS_EVENT, bump);
    return () => {
      window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, bump);
      window.removeEventListener(MANAGER_OUTGOING_PAYMENTS_EVENT, bump);
    };
  }, [ready, userId]);

  const model = useMemo(() => {
    void tick;
    if (!userId || !nowMs) return null;
    const bounds = financesPeriodBounds(period, nowMs);
    const linked = collectLinkedPropertyIdsForModule(userId, "payments");
    const charges = readChargesForManager(userId, { linkedPropertyIds: linked }).filter((c) =>
      propertyId ? c.propertyId === propertyId : true,
    );
    const expenses = readManagerOutgoingExpenses().filter((e) => (propertyId ? e.propertyId === propertyId : true));

    const current = totalsFor(charges, expenses, bounds.from, bounds.to, bounds.dueTo);
    const previous = totalsFor(charges, expenses, bounds.prevFrom, bounds.prevTo);

    const periodExpenses = expenses.filter((e) => within(dateYmd(e.expenseDate), bounds.from, bounds.to));
    const byCategory = new Map<string, number>();
    for (const e of periodExpenses) {
      byCategory.set(e.categoryLabel || e.categoryCode, (byCategory.get(e.categoryLabel || e.categoryCode) ?? 0) + e.amountCents / 100);
    }
    const categories = [...byCategory.entries()]
      .map(([label, value]) => ({ id: label, label, value, detail: current.expenses > 0 ? `${Math.round((value / current.expenses) * 100)}%` : undefined }))
      .sort((a, b) => b.value - a.value);
    const topCategory = categories[0];

    const labelById = new Map(propertyOptions.map((o) => [o.id, o.label]));
    const byProperty = new Map<string, { label: string; income: number; expenses: number }>();
    const bucket = (id: string, label: string) => {
      const key = id || "unassigned";
      const row = byProperty.get(key) ?? { label: labelById.get(id) ?? label ?? "Unassigned", income: 0, expenses: 0 };
      byProperty.set(key, row);
      return row;
    };
    for (const charge of charges) {
      if (LIABILITY_KINDS.has(charge.kind) || charge.status !== "paid") continue;
      const paidDay = dateYmd(charge.paidAt ?? charge.createdAt);
      if (!within(paidDay, bounds.from, bounds.to)) continue;
      bucket(charge.propertyId, charge.propertyLabel).income += chargePaidAmount(charge);
    }
    for (const e of periodExpenses) {
      bucket(e.propertyId ?? "", e.propertyName ?? "Unassigned").expenses += e.amountCents / 100;
    }
    const properties = [...byProperty.entries()]
      .map(([id, row]) => ({
        id,
        label: row.label,
        value: row.income - row.expenses,
        detail: `${fmt(row.income)} in · ${fmt(row.expenses)} out`,
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);

    const depositCharges = charges.filter((c) => c.kind === "security_deposit" && c.status === "paid");
    const depositsHeld = depositCharges.reduce((sum, c) => sum + chargePaidAmount(c), 0);
    const depositResidents = new Set(depositCharges.map((c) => c.residentEmail.trim().toLowerCase())).size;

    const months = lastNMonths(nowMs, 24);
    const paidCharges = charges.filter((c) => c.status === "paid" && !LIABILITY_KINDS.has(c.kind));
    const cashflow = mergeMonthlyCashflow(
      bucketByMonth(paidCharges, months, (c) => c.paidAt ?? c.createdAt, chargePaidAmount),
      bucketByMonth(expenses, months, (e) => e.expenseDate, (e) => e.amountCents / 100),
    );

    const today = ymd(new Date(nowMs));
    const horizon = ymd(new Date(nowMs + 14 * 24 * 60 * 60 * 1000));
    const upcomingByKey = new Map<string, { day: string; title: string; count: number; amount: number; residents: Set<string> }>();
    for (const charge of charges) {
      if (!OPEN_STATUSES.has(charge.status)) continue;
      const due = householdChargeDueDate(charge);
      const day = due ? ymd(due) : null;
      if (!within(day, today, horizon)) continue;
      // One row per day and kind of charge — "Rent due · 8 residents", not
      // eight rows of rent.
      const isRent = RENT_KINDS.has(charge.kind);
      const title = isRent ? "Rent due" : charge.title;
      const key = `${day}-${title}`;
      const row = upcomingByKey.get(key) ?? {
        day: day!,
        title,
        count: 0,
        amount: 0,
        residents: new Set<string>(),
      };
      row.count += 1;
      row.amount += parseMoneyLabel(charge.balanceLabel || charge.amountLabel);
      row.residents.add(charge.residentName || charge.residentEmail);
      upcomingByKey.set(key, row);
    }
    const upcoming = [...upcomingByKey.values()]
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(0, 8)
      .map((row, index) => ({
        id: `${index}-${row.day}-${row.title}`,
        day: row.day,
        title: row.title,
        detail:
          row.residents.size === 1
            ? [...row.residents][0]!
            : `${row.residents.size} residents`,
        amount: row.amount,
      }));

    return {
      bounds,
      current,
      previous,
      categories,
      topCategory,
      properties,
      depositsHeld,
      depositResidents,
      cashflow,
      upcoming,
    };
  }, [nowMs, period, propertyId, propertyOptions, tick, userId]);

  if (!model) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true" data-attr="finances-overview-loading">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-2xl border border-border bg-card" />
        ))}
      </div>
    );
  }

  const { current, previous } = model;
  const noi = current.income - current.expenses;
  const prevNoi = previous.income - previous.expenses;
  const rentPct = current.rentDue > 0 ? Math.round((current.rentCollected / current.rentDue) * 100) : null;
  const deltaLabel = period === "month" ? "vs last month" : period === "year" ? "vs last year" : "vs prior year";
  const dayLabel = (day: string) =>
    new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="flex flex-col gap-4 pb-6" data-attr="finances-overview">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Net operating income"
          value={noi < 0 ? `–${fmt(Math.abs(noi))}` : fmt(noi)}
          foot={<Delta current={noi} previous={prevNoi} label={deltaLabel} />}
          dataAttr="finances-kpi-noi"
        />
        <StatTile
          label="Rent collected"
          value={fmt(current.rentCollected)}
          detail={current.rentDue > 0 ? `of ${fmt(current.rentDue)} due · ${rentPct}%` : "Nothing due this period"}
          href={`${basePath}/financials/income`}
          dataAttr="finances-kpi-rent"
        />
        <StatTile
          label="Expenses"
          value={fmt(current.expenses)}
          detail={
            model.topCategory
              ? `${model.topCategory.label.toLowerCase()} ${model.topCategory.detail ?? ""}`.trim()
              : "No expenses yet"
          }
          href={`${basePath}/financials/expenses`}
          dataAttr="finances-kpi-expenses"
        />
        <StatTile
          label="Deposits held"
          value={fmt(model.depositsHeld)}
          detail={`liability · ${model.depositResidents} ${model.depositResidents === 1 ? "resident" : "residents"}`}
          href={`${basePath}/financials/security-deposits`}
          dataAttr="finances-kpi-deposits"
        />
      </div>

      <MonthlyProfitChart
        points={model.cashflow}
        title="Cash flow"
        subtitle="Income, expenses and net by month"
        defaultMetric="profit"
        defaultRangeMonths={12}
        aspect="wide"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Expenses by category" action={{ label: "All expenses", href: `${basePath}/financials/expenses` }} dataAttr="finances-overview-categories">
          <BarRows rows={model.categories.slice(0, 6)} empty="No expenses in this period." dataAttr="finances-overview-category-rows" />
        </Card>
        <Card title="By property" action={{ label: "Full table", href: `${basePath}/financials/income` }} dataAttr="finances-overview-properties">
          <BarRows rows={model.properties} empty="No activity in this period." dataAttr="finances-overview-property-rows" />
        </Card>
      </div>

      <Card title="Coming up · next 14 days" action={{ label: "Payments", href: `${basePath}/payments/incoming/pending` }} dataAttr="finances-overview-upcoming">
        {model.upcoming.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-muted">Nothing falls due in the next two weeks.</p>
        ) : (
          <ul className="divide-y divide-border/70">
            {model.upcoming.map((row) => (
              <li key={row.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-14 shrink-0 text-[12.5px] font-semibold tabular-nums text-foreground">{dayLabel(row.day)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium text-foreground">{row.title}</span>
                  <span className="block truncate text-[12px] text-muted">{row.detail}</span>
                </span>
                <span className="shrink-0 text-[13.5px] font-semibold tabular-nums text-foreground">{fmt(row.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
