"use client";
import { loadFinancialActivity, invalidateFinancialActivity } from "@/lib/financial-activity-cache";
import { WORKSPACE_SELECTION_EVENT } from "@/lib/workspaces/selection";
import { MANAGER_OUTGOING_PAYMENTS_EVENT } from "@/lib/manager-outgoing-payments";
import { HOUSEHOLD_CHARGES_EVENT } from "@/lib/household-charges";
import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS } from "@/components/ui/field-select-styles";
import { MonthlyProfitChart } from "@/components/portal/monthly-profit-chart";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { summarizeFinancialActivityByProperty, type summarizeFinancialActivity } from "@/lib/reports/financial-activity-totals";
import { PortalStatStrip, type PortalStat } from "@/components/portal/portal-stat-strip";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalPropertyRecordRow, PortalRowIconTile } from "@/components/portal/portal-record-row";
import type { ReportRow } from "@/lib/reports/types";
import { lastNMonths } from "@/lib/portal-monthly-profit";
/** Overview figures read as whole dollars, like the studio ("$7,700"); exact cents stay in Reports. */
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
  const [activityRows, setActivityRows] = useState<ReportRow[]>([]);
  const [balance, setBalance] = useState<{ availableCents: number; pendingCents: number } | null>(null);
  const [owed, setOwed] = useState<number>();
  const [billCount, setBillCount] = useState<number>();
  const [error, setError] = useState("");
  const [month, setMonth] = useState("");
  const [clock, setClock] = useState(0);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = (event: Event) => { if (!invalidateFinancialActivity(event)) return; setSummary(null); setActivityRows([]); setBalance(null); setOwed(undefined); setBillCount(undefined); setError(""); setRevision(n => n + 1); };
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
      setActivityRows(Array.isArray(activity.rows) ? activity.rows : []);
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
  const stat = (id: string, label: string, value: number | undefined, href?: string, note?: string, tone?: "ok"): PortalStat => ({
    id, label, value: wholeMoney(value), href, note, tone: tone === "ok" && (value ?? 0) > 0 ? "ok" : undefined,
  });
  const byProperty = summarizeFinancialActivityByProperty(activityRows, month);
  return <div className="space-y-4 pb-6" data-attr="finances-overview">
    <PortalStatStrip size="lg" dataAttr="finances-balance-strip" items={[
      stat("available", "Available", balance?.availableCents), stat("pending", "Pending", balance?.pendingCents),
      stat("held", "Held deposits", summary.heldDepositsCents, `${basePath}/financials/security-deposits`),
      stat("to-pay", "To pay", owed, `${basePath}/outgoing/to-pay`, billCount === undefined ? undefined : `${billCount} ${billCount === 1 ? "bill" : "bills"}`),
    ]} />
    <div className="flex items-center gap-2">
      <FieldSingleSelect hideLabel label="Month" value={month} onChange={setMonth} triggerClassName={FIELD_SELECT_TRIGGER_TOOLBAR_PILL_CLASS} dataAttr="finances-month"
        options={[...months].reverse().map(m => ({ value: m.key, label: new Date(`${m.key}-15T12:00:00`).toLocaleString("en-US", { month: "long", year: "numeric" }) }))} />
    </div>
    <PortalStatStrip size="lg" dataAttr="finances-month-strip" className="[grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))]" items={[
      stat("revenue", "Revenue", totals.revenueCents, undefined, undefined, "ok"), stat("expenses", "Expenses", totals.expenseCents),
      stat("profit", "Profit", totals.profitCents, undefined, undefined, "ok"),
    ]} />
    {byProperty.length > 0 ? <section className="overflow-hidden rounded-[10px] border border-border bg-card" data-attr="finances-by-property">
      <h3 className="border-b border-border px-4 py-2.5 text-[14px] font-semibold text-foreground">By property</h3>
      <PortalListGroupRowContext.Provider value>
        {byProperty.map(row => <PortalPropertyRecordRow key={row.key || "portfolio"} title={row.label} leading={<PortalRowIconTile icon={Building2} />} leadingShape="square"
          facts={<><span className="font-medium text-[var(--status-confirmed-fg)]">In {wholeMoney(row.inCents)}</span><span>Out {wholeMoney(row.outCents)}</span></>} dataAttr="finances-by-property-row" />)}
      </PortalListGroupRowContext.Provider>
    </section> : null}
    <MonthlyProfitChart onMonthSelect={setMonth} points={months.map(m => {
      const t = summary.months[m.key] ?? { revenueCents: 0, expenseCents: 0, profitCents: 0, rentCollectedCents: 0 };
      return { ...m, revenue: t.revenueCents / 100, expense: t.expenseCents / 100, profit: t.profitCents / 100 };
    })} />
  </div>;
}
