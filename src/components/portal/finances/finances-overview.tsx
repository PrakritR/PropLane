"use client";
import Link from "next/link";
import { loadFinancialActivity, invalidateFinancialActivity } from "@/lib/financial-activity-cache";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
import { HOUSEHOLD_CHARGES_EVENT } from "@/lib/household-charges";
import { useEffect, useState } from "react";
import { CalendarDays, Clock, Landmark, ReceiptText, ShieldCheck, type LucideIcon } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS } from "@/components/ui/field-select-styles";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import type { summarizeFinancialActivity } from "@/lib/reports/financial-activity-totals";
import { lastNMonths } from "@/lib/portal-monthly-profit";
/** Overview figures read as whole dollars, like the studio ("$7,700"); exact cents stay in Activity. */
const wholeMoney = (cents: number | undefined) => cents === undefined ? "—" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.round(cents / 100));
export type FinancesPeriodKind = "month" | "year" | "12m";

export const FINANCES_PERIOD_LABELS: Record<FinancesPeriodKind, string> = {
  month: "This month",
  year: "This year",
  "12m": "Last 12 months",
};

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

export function FinancesPeriodSelect({
  value,
  onChange,
}: {
  value: FinancesPeriodKind;
  onChange: (next: FinancesPeriodKind) => void;
}) {
  return (
    <FieldSingleSelect
      variant="pill"
      label="Period"
      value={value}
      onChange={(next) => onChange(next as FinancesPeriodKind)}
      options={(Object.keys(FINANCES_PERIOD_LABELS) as FinancesPeriodKind[]).map((k) => ({ value: k, label: FINANCES_PERIOD_LABELS[k] }))}
      dataAttr="finances-period"
      triggerClassName={`${FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} max-md:min-h-11`}
    />
  );
}

const ALL_PROPERTIES = "__all__";

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
  // "" (every property) rides as its own option so the pill never reads as an empty placeholder.
  return (
    <FieldSingleSelect
      variant="pill"
      label="Property"
      value={value || ALL_PROPERTIES}
      onChange={(next) => onChange(next === ALL_PROPERTIES ? "" : next)}
      options={[{ value: ALL_PROPERTIES, label: "All properties" }, ...options.map((o) => ({ value: o.id, label: o.label }))]}
      dataAttr="finances-property"
      wrapperClassName="hidden max-w-[14rem] md:block"
      triggerClassName={`${FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} max-w-[14rem]`}
    />
  );
}


export function ManagerFinancesOverview({ userId, ready, propertyId, basePath }: {
  userId: string | null; ready: boolean; propertyId: string; period: FinancesPeriodKind;
  basePath: string; propertyOptions: ManagerPropertyFilterOption[];
}) {
  const [summary, setSummary] = useState<ReturnType<typeof summarizeFinancialActivity> | null>(null);
  const [balance, setBalance] = useState<{ availableCents: number; pendingCents: number } | null>(null);
  const [owed, setOwed] = useState<number>();
  const [billCount, setBillCount] = useState<number>();
  const [error, setError] = useState("");
  const [month, setMonth] = useState("");
  const [clock, setClock] = useState(0);
  const [rentDue, setRentDue] = useState<{ dueCents: number; collectedCents: number; percent: number | null } | null>(null);
  useEffect(() => {
    if (!month) return; let cancelled = false;
    const query = new URLSearchParams({ period: month, ...(propertyId ? { propertyId } : {}) });
    fetch(`/api/reports/rent-due?${query}`).then(async res => { if (!res.ok) throw new Error("Could not load rent due"); return res.json(); }).then(data => { if (!cancelled) setRentDue(data); }).catch(() => { if (!cancelled) setRentDue(null); });
    return () => { cancelled = true; };
  }, [month, propertyId, userId]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (event: Event) => { if (!invalidateFinancialActivity(event)) return; setSummary(null); setBalance(null); setOwed(undefined); setBillCount(undefined); setError(""); setRevision(n => n + 1); };
    const events = [WORKSPACE_SELECTION_EVENT, MANAGER_OUTGOING_PAYMENTS_EVENT, HOUSEHOLD_CHARGES_EVENT];
    events.forEach(name => window.addEventListener(name, refresh));
    return () => events.forEach(name => window.removeEventListener(name, refresh));
  }, []);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const fetchJson = async (url: string) => { const res = await fetch(url); const data = await res.json(); if (!res.ok) throw new Error(data.error || "Could not load finances."); return data; };
    loadFinancialActivity(userId, propertyId).then(activity => {
      if (cancelled) return;
      setSummary(JSON.parse(String(activity.meta?.summary)));
      setMonth(pacificCalendarDateYmd().slice(0, 7)); setClock(Date.now());
    }).catch(err => { if (!cancelled) setError(err.message); });
    Promise.all([fetchJson("/api/portal/proplane-balance").catch(() => null), fetchJson("/api/stripe/payouts/balance").catch(() => null)]).then(([ledger, stripe]) => {
      if (cancelled) return;
      if (ledger && ledger.enabled) setBalance(ledger);
      else if (ledger && ledger.enabled === false) setBalance(null);
      else setBalance(stripe ?? null);
    });
    fetchJson("/api/manager/vendor-invoices?outgoing=1&status=approved,scheduled").then(invoices => { if (!cancelled) { setOwed(invoices.totals?.owedCents); setBillCount(invoices.totals?.billCount); } }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [ready, propertyId, userId, revision]);
  if (error) return <p role="alert">{error}</p>;
  if (!summary) return <div role="status" className="py-8">Loading finances…</div>;
  const totals = summary.months[month] ?? { revenueCents: 0, expenseCents: 0, profitCents: 0, rentCollectedCents: 0 };
  const months = lastNMonths(clock, 24);
  const activityHref = (direction?: string, category?: string) => `${basePath}/financials/activity?${new URLSearchParams(category ? { category } : { month, ...(direction ? { direction } : {}) })}`;
  const tile = (label: string, value: number | undefined, href?: string, fact?: string, icon?: LucideIcon, tone?: "positive") => {
    const Icon = icon;
    const body = <><span className="flex items-center gap-1.5 text-[11.5px] font-bold uppercase tracking-[0.06em] text-muted">{Icon ? <Icon className="size-3.5" aria-hidden /> : null}{label}</span><span className={`mt-2 block text-[22px] font-bold ${tone === "positive" && (value ?? 0) > 0 ? "text-emerald-600" : "text-foreground"}`}>{wholeMoney(value)}</span>{fact ? <span className="mt-1 block text-xs text-muted">{fact}</span> : null}</>;
    return href ? <Link key={label} href={href} className="min-w-0 p-4 hover:bg-accent/30">{body}</Link> : <div key={label} className="min-w-0 p-4">{body}</div>;
  };
  return <div className="space-y-4 pb-6" data-attr="finances-overview">
    <div className="grid grid-cols-2 divide-border rounded-xl border border-border bg-card md:grid-cols-4" data-attr="finances-balance-strip">
      {tile("Available", balance?.availableCents, undefined, undefined, Landmark)}{tile("Pending", balance?.pendingCents, undefined, undefined, Clock)}
      {tile("Held deposits", summary.heldDepositsCents, activityHref(undefined, "deposits"), undefined, ShieldCheck)}
      {tile("To pay", owed, `${basePath}/outgoing/to-pay`, billCount === undefined ? undefined : `${billCount} ${billCount === 1 ? "bill" : "bills"}`, ReceiptText)}
    </div>
    <div className="rounded-xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <CalendarDays className="size-4 text-muted" aria-hidden />
        <FieldSingleSelect hideLabel label="Month" value={month} onChange={setMonth} triggerClassName={FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} dataAttr="finances-month"
          options={[...months].reverse().map(m => ({ value: m.key, label: new Date(`${m.key}-15T12:00:00`).toLocaleString("en-US", { month: "long", year: "numeric" }) }))} />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4">
        {tile("Revenue", totals.revenueCents, activityHref("in"), undefined, undefined, "positive")}{tile("Expenses", totals.expenseCents, activityHref("out"))}
        {tile("Profit", totals.profitCents, undefined, undefined, undefined, "positive")}{tile("Rent collected", rentDue?.collectedCents, undefined, rentDue?.dueCents ? `of ${wholeMoney(rentDue.dueCents)} due · ${rentDue.percent}%` : undefined)}
      </div>
    </div>
    <MonthlyProfitChart hideSummary defaultRangeMonths={12} onMonthSelect={setMonth} points={months.map(m => {
      const t = summary.months[m.key] ?? { revenueCents: 0, expenseCents: 0, profitCents: 0, rentCollectedCents: 0 };
      return { ...m, revenue: t.revenueCents / 100, expense: t.expenseCents / 100, profit: t.profitCents / 100 };
    })} />
  </div>;
}
