"use client";

import {
  useMemo,
  useState,
} from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { cn } from "@/lib/utils";
import {
  CASHFLOW_CHART_RANGE_MONTHS,
  type CashflowChartMetric,
  type CashflowChartRangeMonths,
  type MonthlyCashflowPoint,
  type MonthlyProfitPoint,
} from "@/lib/portal-monthly-profit";

function formatUsd(amount: number): string {
  const abs = Math.abs(amount);
  const formatted = abs.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: abs >= 1000 ? 0 : 2,
  });
  return amount < 0 ? `−${formatted}` : formatted;
}

const axisUsd = (amount: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(amount);

function rangeLabel(months: CashflowChartRangeMonths): string {
  if (months === 12) return "1Y";
  if (months === 24) return "2Y";
  return `${months}M`;
}

/**
 * The 3M / 6M / 1Y / 2Y range control. Shared by the cash-flow chart and the
 * Profitability card so the two month selectors on Finances cannot drift apart.
 */
export function CashflowRangeToggle({
  value,
  onChange,
  ariaLabel = "Chart time range",
  dataAttrPrefix = "cashflow-range",
  className,
  appearance = "pills",
  accent,
}: {
  value: CashflowChartRangeMonths;
  onChange: (months: CashflowChartRangeMonths) => void;
  ariaLabel?: string;
  dataAttrPrefix?: string;
  className?: string;
  appearance?: "pills" | "underline";
  accent?: string;
}) {
  if (appearance === "underline") {
    return (
      <div
        className={cn("flex justify-between gap-1 border-t border-border pt-1", className)}
        role="tablist"
        aria-label={ariaLabel}
        onClick={(e) => e.stopPropagation()}
      >
        {CASHFLOW_CHART_RANGE_MONTHS.map((months) => {
          const selected = value === months;
          return (
            <button
              key={months}
              type="button"
              role="tab"
              aria-selected={selected}
              data-attr={`${dataAttrPrefix}-${months}`}
              className={cn(
                "portal-pressable min-h-11 min-w-11 flex-1 border-b-2 px-1 text-[12px] font-bold tabular-nums transition-colors",
                selected ? "text-foreground" : "border-transparent text-muted hover:text-foreground",
              )}
              style={selected ? { color: accent, borderBottomColor: accent } : undefined}
              onClick={() => onChange(months)}
            >
              {rangeLabel(months)}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      className={cn("flex gap-0.5 rounded-full border border-border bg-[var(--pl-surface-muted)] p-0.5 [html[data-theme=dark]_&]:bg-white/[0.04]", className)}
      role="tablist"
      aria-label={ariaLabel}
      onClick={(e) => e.stopPropagation()}
    >
      {CASHFLOW_CHART_RANGE_MONTHS.map((months) => (
        <button
          key={months}
          type="button"
          role="tab"
          aria-selected={value === months}
          data-attr={`${dataAttrPrefix}-${months}`}
          className={cn(
            "portal-pressable min-h-11 min-w-11 rounded-full px-3 py-2 text-[11px] font-bold tabular-nums transition-colors sm:px-3.5 sm:text-xs",
            value === months
              ? "bg-card text-foreground shadow-[var(--shadow-sm)]"
              : "text-muted hover:text-foreground",
          )}
          onClick={() => onChange(months)}
        >
          {rangeLabel(months)}
        </button>
      ))}
    </div>
  );
}

/** Revenue and expenses share one scale; profit has a separate zero-centred panel. */
export function MonthlyProfitChart({ points: rawPoints, title = "Cash flow", className = "", defaultRangeMonths = 6, hideSummary = false, onMonthSelect }: {
  points: MonthlyCashflowPoint[] | MonthlyProfitPoint[];
  title?: string; subtitle?: string; className?: string;
  defaultMetric?: CashflowChartMetric; defaultRangeMonths?: CashflowChartRangeMonths;
  aspect?: "hero" | "wide";
  hideSummary?: boolean;
  onMonthSelect?: (month: string) => void;
}) {
  const [range, setRange] = useState<string>(String(defaultRangeMonths));
  const [selected, setSelected] = useState<string | null>(null);
  const [table, setTable] = useState(false);
  const all = useMemo(() => rawPoints.map(p => "revenue" in p ? p : { ...p, revenue: 0, expense: 0 }), [rawPoints]);
  const latestYear = all.at(-1)?.key.slice(0, 4);
  const points = range === "ytd" ? all.filter(p => p.key.startsWith(latestYear ?? "")) : all.slice(-Number(range));
  const active = points.find(p => p.key === selected) ?? points.at(-1);
  const prior = active ? all[all.findIndex(p => p.key === active.key) - 1] : undefined;
  const max = Math.max(1, ...points.flatMap(p => [p.revenue, p.expense]));
  const profitMax = Math.max(1, ...points.map(p => Math.abs(p.profit)));
  const pick = (key: string) => {
    setSelected(key);
    if (onMonthSelect) onMonthSelect(key);
    else window.location.assign(`/portal/financials/activity?month=${encodeURIComponent(key)}`);
  };
  const metrics = active ? [
    { label: "Revenue", value: active.revenue, previous: prior?.revenue },
    { label: "Expenses", value: active.expense, previous: prior?.expense },
    { label: "Net profit", value: active.profit, previous: prior?.profit },
    { label: "Margin", value: active.revenue ? active.profit / active.revenue * 100 : null, previous: prior?.revenue ? prior.profit / prior.revenue * 100 : undefined },
  ] : [];
  return <section className={cn("rounded-xl border border-border bg-card p-4", className)} data-attr="monthly-profit-chart">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="flex items-center gap-3">
        <FieldSingleSelect
          label="Chart time range"
          hideLabel
          value={range}
          onChange={setRange}
          options={[
            { value: "6", label: "6M" },
            { value: "12", label: "12M" },
            { value: "ytd", label: "YTD" },
          ]}
          triggerClassName="rounded-lg border border-border bg-card p-2 text-sm"
        />
        <button type="button" aria-label={table ? "Show chart" : "Show table"} title={table ? "Show chart" : "Show table"} onClick={() => setTable(!table)} className="p-2">{table ? "▥" : "☷"}</button>
      </div>
    </header>
    {!hideSummary && active ? <div className="my-4 grid grid-cols-2 gap-4 sm:grid-cols-4" data-attr="cashflow-hero">{metrics.map(m => <div key={m.label}>
      <div className="text-xs text-muted">{m.label}</div>
      <div className="text-xl font-semibold tabular-nums">{m.value === null ? "—" : m.label === "Margin" ? `${m.value.toFixed(1)}%` : formatUsd(m.value)}</div>
      <div className="text-xs tabular-nums">{m.previous === undefined || m.value === null ? "—" : `${m.value - m.previous >= 0 ? "+" : ""}${m.label === "Margin" ? `${(m.value - m.previous).toFixed(1)} pp` : formatUsd(m.value - m.previous)}`} · {active.label}</div>
    </div>)}</div> : null}
    {points.length === 0 ? <p className="py-6 text-sm text-muted">No cash flow data yet.</p> : table ? <div className="overflow-auto"><table className="w-full text-sm"><thead><tr>{["Month", "Revenue", "Expenses", "Net profit", "Margin"].map(x => <th className="p-2 text-left" key={x}>{x}</th>)}</tr></thead><tbody>{points.map(p => <tr key={p.key} className="border-t border-border"><td className="p-2"><button onClick={() => pick(p.key)}>{p.key}</button></td><td>{formatUsd(p.revenue)}</td><td>{formatUsd(p.expense)}</td><td>{formatUsd(p.profit)}</td><td>{p.revenue ? `${(p.profit / p.revenue * 100).toFixed(1)}%` : "—"}</td></tr>)}</tbody></table></div> : <>
      <div className="mt-4 flex gap-4 text-xs"><span className="text-primary">● Revenue</span><span className="text-muted">● Expenses</span></div>
      <div className="relative pl-14"><div aria-hidden="true" className="absolute bottom-0 left-0 top-0 flex w-12 flex-col justify-between text-right text-[10px] text-muted"><span>{axisUsd(max)}</span><span>{axisUsd(max / 2)}</span><span>$0</span></div><div className="mt-3 flex h-44 gap-2 border-b border-border" aria-label="Monthly revenue and expenses">{points.map((p, i) => <button key={p.key} type="button" title={`${p.key}: Revenue ${formatUsd(p.revenue)}, Expenses ${formatUsd(p.expense)}, Net profit ${formatUsd(p.profit)}`} aria-label={`${p.key}, open activity`} onMouseEnter={() => setSelected(p.key)} onFocus={() => setSelected(p.key)} onClick={() => pick(p.key)} className={cn("flex min-w-0 flex-1 items-end justify-center gap-1", i < points.length - 6 && "hidden sm:flex")}>
        <span className="w-1/3 rounded-t bg-primary" style={{ height: `${Math.max(0, p.revenue) / max * 100}%` }} /><span className="w-1/3 rounded-t bg-muted/40" style={{ height: `${Math.max(0, p.expense) / max * 100}%` }} />
      </button>)}</div></div>
      <div className="flex gap-2 pl-14 pt-2 text-center text-xs text-muted">{points.map((p, i) => <span key={p.key} className={cn("min-w-0 flex-1", i < points.length - 6 && "hidden sm:block")}>{p.label}</span>)}</div>
      <div className="mt-4 text-xs font-semibold">Net profit</div><div className="relative pl-14"><div aria-hidden="true" className="absolute bottom-0 left-0 top-0 flex w-12 flex-col justify-between text-right text-[10px] text-muted"><span>{axisUsd(profitMax)}</span><span>$0</span><span>{axisUsd(-profitMax)}</span></div><div className="relative mt-2 flex h-20 gap-2"><div className="absolute inset-x-0 top-1/2 border-t border-border" />{points.map((p, i) => <div key={p.key} className={cn("relative flex-1", i < points.length - 6 && "hidden sm:block")}><span className={cn("absolute left-1/3 w-1/3", p.profit < 0 ? "top-1/2 bg-red-500" : "bottom-1/2 bg-emerald-600")} style={{ height: `${Math.abs(p.profit) / profitMax * 50}%` }} /></div>)}</div></div>
    </>}
  </section>;
}
