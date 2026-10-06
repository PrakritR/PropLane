"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { BarChart3, Table2 } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { usePortalFilterDraft } from "@/lib/portal-filter-draft";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
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


type CashflowSeries = "all" | "rev" | "exp" | "net";
type SeriesKey = Exclude<CashflowSeries, "all">;

const SERIES_COLOR: Record<SeriesKey, string> = {
  rev: "var(--color-primary, #2863f0)",
  exp: "#ea6a0a",
  net: "#0f9d6e",
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `2026-09` → `Sep 2026`. */
function monthLong(key: string, fallback: string): string {
  const [year, month] = key.split("-");
  const name = MONTH_NAMES[Number(month) - 1];
  return name && year ? `${name} ${year}` : fallback;
}

function signedUsd(amount: number): string {
  return `${amount >= 0 ? "+" : ""}${formatUsd(amount)}`;
}

function shortUsd(amount: number): string {
  const abs = Math.abs(amount);
  const body = abs >= 1000 ? `${Math.round(abs / 1000)}K` : String(Math.round(abs));
  return `${amount < 0 ? "−" : ""}$${body}`;
}

type NormalizedPoint = { key: string; label: string; revenue: number; expense: number; profit: number };
/** A month with its running totals from the first month of the selected period. */
type RunningPoint = NormalizedPoint & { cumRev: number; cumExp: number; cumNet: number; netMonth: number };

const CHART_H = 300;
const PAD = { l: 56, r: 12, t: 12, b: 30 };
const DEFAULT_WIDTH = 900;

const PERIOD_OPTIONS: { value: string; label: string }[] = [
  { value: "6", label: "6 months" },
  { value: "12", label: "12 months" },
  { value: "ytd", label: "Year to date" },
];
const SHOW_OPTIONS: { value: CashflowSeries; label: string }[] = [
  { value: "all", label: "All" },
  { value: "rev", label: "Revenue" },
  { value: "exp", label: "Expenses" },
  { value: "net", label: "Profit" },
];

/** The Filter popover body: Period and Show, applied when the popover closes like every list filter. */
function CashflowFilterFields({ range, onRangeChange, series, onSeriesChange, defaultRange }: {
  range: string; onRangeChange: (next: string) => void;
  series: CashflowSeries; onSeriesChange: (next: CashflowSeries) => void;
  defaultRange: string;
}) {
  const [draftRange, setDraftRange] = usePortalFilterDraft<string>(range, onRangeChange, defaultRange);
  const [draftSeries, setDraftSeries] = usePortalFilterDraft<CashflowSeries>(series, onSeriesChange, "all");
  return <>
    <FieldSingleSelect label="Period" value={draftRange} options={PERIOD_OPTIONS} onChange={setDraftRange} dataAttr="cashflow-filter-period" />
    <FieldSingleSelect label="Show" value={draftSeries} options={SHOW_OPTIONS} onChange={(next) => setDraftSeries(next as CashflowSeries)} dataAttr="cashflow-filter-show" />
  </>;
}

function linePath(list: RunningPoint[], x: (i: number) => number, y: (v: number) => number, pick: (p: RunningPoint) => number): string {
  return list.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(pick(p))}`).join(" ");
}

const SERIES_PICK: Record<SeriesKey, (p: RunningPoint) => number> = {
  rev: p => p.cumRev,
  exp: p => p.cumExp,
  net: p => p.cumNet,
};

/**
 * Cash flow as a running total: revenue and expenses climb (or stay flat) from the first month of
 * the selected period, net profit is the gap between them, all on ONE dollar axis. KPI tiles total
 * the period (or the hovered month); a tile or the Filter popover isolates one series and the axis
 * refits to what is shown.
 */
export function MonthlyProfitChart({ points: rawPoints, title = "Cash flow", className = "", defaultRangeMonths = 6, hideSummary = false, onMonthSelect }: {
  points: MonthlyCashflowPoint[] | MonthlyProfitPoint[];
  title?: string; subtitle?: string; className?: string;
  defaultMetric?: CashflowChartMetric; defaultRangeMonths?: CashflowChartRangeMonths;
  aspect?: "hero" | "wide";
  hideSummary?: boolean;
  onMonthSelect?: (month: string) => void;
}) {
  const defaultRange = String(defaultRangeMonths);
  const [range, setRangeState] = useState<string>(defaultRange);
  const [series, setSeries] = useState<CashflowSeries>("all");
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const all = useMemo<NormalizedPoint[]>(() => rawPoints.map(p => "revenue" in p ? p : { ...p, revenue: 0, expense: 0 }), [rawPoints]);
  const latestYear = all.at(-1)?.key.slice(0, 4);
  // The ONE month set: lines, axis, tooltip and KPI totals all read `points`.
  const startIdx = range === "ytd"
    ? Math.max(0, all.findIndex(p => p.key.startsWith(latestYear ?? "")))
    : Math.max(0, all.length - Number(range));
  const points = useMemo(() => all.slice(startIdx), [all, startIdx]);
  const priorPoints = points.length > 0 && startIdx - points.length >= 0 ? all.slice(startIdx - points.length, startIdx) : null;
  const hovered = hover !== null && hover < points.length ? hover : null;

  // Running totals from the start of the selected period. Net = running revenue − running expenses
  // (a profit-only series, which carries no revenue or expense, falls back to its running profit).
  const running = useMemo<RunningPoint[]>(() => {
    const hasSplit = points.some(p => p.revenue !== 0 || p.expense !== 0);
    // Accumulated in a plain loop, not a `map` callback: a closure that reassigns
    // render-scope variables trips `react-hooks/immutability`.
    const rows: RunningPoint[] = [];
    let cumRev = 0;
    let cumExp = 0;
    let cumProfit = 0;
    for (const p of points) {
      cumRev += p.revenue;
      cumExp += p.expense;
      cumProfit += p.profit;
      rows.push({ ...p, cumRev, cumExp, cumNet: hasSplit ? cumRev - cumExp : cumProfit, netMonth: hasSplit ? p.revenue - p.expense : p.profit });
    }
    return rows;
  }, [points]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || table) return;
    const measure = () => { const w = el.clientWidth; if (w > 0) setWidth(w); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [table, points.length]);

  const setRange = (next: string) => { setRangeState(next); setHover(null); };
  const toggleSeries = (key: SeriesKey) => setSeries(prev => prev === key ? "all" : key);
  const pick = (key: string) => {
    if (onMonthSelect) onMonthSelect(key);
    else window.location.assign(`/portal/financials/overview`);
  };

  const show = { rev: series === "all" || series === "rev", exp: series === "all" || series === "exp", net: series === "all" || series === "net" };
  const visibleKeys = (["rev", "exp", "net"] as const).filter(k => show[k]);
  const sum = (list: NormalizedPoint[]) => list.reduce((t, p) => ({ rev: t.rev + p.revenue, exp: t.exp + p.expense, net: t.net + p.profit }), { rev: 0, exp: 0, net: 0 });
  const totals = sum(hovered !== null ? [points[hovered]] : points);
  // "vs prior period" only when there was an earlier, equal-length period with any activity.
  const priorHasActivity = priorPoints?.some(p => p.revenue !== 0 || p.expense !== 0) ?? false;
  const priorTotals = priorPoints && priorHasActivity ? sum(priorPoints) : null;
  const rangeText = range === "ytd" ? "Year to date" : `Last ${range} months`;
  const margin = totals.rev ? totals.net / totals.rev * 100 : null;
  const hoveredLabel = hovered !== null ? monthLong(points[hovered].key, points[hovered].label) : null;
  const tiles: { id: SeriesKey | "margin"; label: string; value: string; delta: string }[] = [
    { id: "rev", label: "Revenue", value: formatUsd(totals.rev), delta: priorTotals ? `${signedUsd(totals.rev - priorTotals.rev)} vs prior period` : rangeText },
    { id: "exp", label: "Expenses", value: formatUsd(totals.exp), delta: priorTotals ? `${signedUsd(totals.exp - priorTotals.exp)} vs prior period` : rangeText },
    { id: "net", label: "Net profit", value: formatUsd(totals.net), delta: priorTotals ? `${signedUsd(totals.net - priorTotals.net)} vs prior period` : rangeText },
    { id: "margin", label: "Margin", value: margin === null ? "—" : `${margin.toFixed(1)}%`, delta: rangeText },
  ];

  // One dollar axis shared by every visible series; refits to what is shown (net may dip below $0).
  const values = [0];
  for (const p of running) for (const k of visibleKeys) values.push(SERIES_PICK[k](p));
  let hi = Math.max(...values);
  let lo = Math.min(...values);
  if (hi <= 0) hi = 1;
  const span = hi - lo;
  hi += span * 0.06;
  if (lo < 0) lo -= span * 0.06;
  const plotH = CHART_H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + (hi - v) / (hi - lo) * plotH;
  const colW = points.length ? (width - PAD.l - PAD.r) / points.length : 0;
  const cx = (i: number) => PAD.l + colW * i + colW / 2;
  const ticks = [hi, (hi + Math.max(lo, 0)) / 2, 0, ...(lo < 0 ? [lo] : [])];
  const labelStep = colW < 30 ? 2 : 1;
  const last = running.length - 1;
  const areaKeys = visibleKeys.filter((k): k is "rev" | "exp" => k !== "net");

  const indexFromPointer = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg || colW <= 0) return null;
    const rect = svg.getBoundingClientRect();
    const px = (clientX - rect.left) * (rect.width > 0 ? width / rect.width : 1);
    const i = Math.floor((px - PAD.l) / colW);
    return i < 0 || i >= points.length ? null : i;
  };

  const TIP_W = 208;
  const tipLeft = hovered === null ? 0 : (() => {
    const left = cx(hovered) + colW / 2 + 8;
    return left > width - TIP_W - 8 ? cx(hovered) - colW / 2 - TIP_W : left;
  })();
  const monthAria = (p: RunningPoint) => `${monthLong(p.key, p.label)}: Running revenue ${formatUsd(p.cumRev)}, running expenses ${formatUsd(p.cumExp)}, running net profit ${formatUsd(p.cumNet)}`;
  const filterActive = portalFilterActiveCount([series !== "all", range !== defaultRange]);
  const tipRows = hovered === null ? [] : ([
    ["rev", "Revenue", running[hovered].cumRev, running[hovered].revenue],
    ["exp", "Expenses", running[hovered].cumExp, running[hovered].expense],
    ["net", "Net profit", running[hovered].cumNet, running[hovered].netMonth],
  ] as const).filter(([k]) => show[k]);

  return <section className={cn("rounded-xl border border-border bg-card p-4", className)} data-attr="monthly-profit-chart">
    <header className="flex items-center justify-between gap-3">
      <h2 className="min-w-0 truncate text-base font-semibold">{title}<span className="ml-2 text-sm font-medium text-muted" data-attr="cashflow-period">{rangeText}</span></h2>
      <div className="flex shrink-0 items-center gap-1">
        <PortalFilterSortSheet
          activeCount={filterActive}
          compactPanel
          commandStripTrigger
          dropdownAlign="end"
          filterFieldCount={2}
          mobileFlushBody
          onReset={() => { setRange(defaultRange); setSeries("all"); }}
          dataAttr="cashflow-filter-open"
        >
          <CashflowFilterFields range={range} onRangeChange={setRange} series={series} onSeriesChange={setSeries} defaultRange={defaultRange} />
        </PortalFilterSortSheet>
        <PortalIconAction icon={table ? BarChart3 : Table2} label={table ? "Show chart" : "Show table"} data-attr="cashflow-table-toggle" onClick={() => setTable(!table)} />
      </div>
    </header>
    {!hideSummary && points.length > 0 ? <div className="my-4 grid grid-cols-2 gap-2 sm:grid-cols-4" data-attr="cashflow-hero">{tiles.map(t => {
      const body = <>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          {t.id !== "margin" ? <span className="size-2 rounded-sm" style={{ background: SERIES_COLOR[t.id] }} aria-hidden /> : null}{t.label}
        </div>
        <div className="text-xl font-semibold tabular-nums text-foreground">{t.value}</div>
        <div className="text-xs tabular-nums text-muted">{hoveredLabel ?? t.delta}</div>
      </>;
      if (t.id === "margin") return <div key={t.id} className="rounded-lg p-2 text-left" data-attr="cashflow-kpi-margin">{body}</div>;
      const id = t.id;
      return <button key={id} type="button" aria-pressed={series === id} data-attr={`cashflow-kpi-${id}`} onClick={() => toggleSeries(id)}
        className={cn("portal-pressable rounded-lg p-2 text-left transition-opacity hover:bg-accent/30", series === id && "bg-accent/40", series !== "all" && series !== id && "opacity-50")}>{body}</button>;
    })}</div> : null}
    {points.length === 0 ? <p className="py-6 text-sm text-muted">No cash flow data yet.</p> : table ? <div className="overflow-auto"><table className="w-full text-sm"><thead><tr>{["Month", "Revenue", "Expenses", "Net profit", "Margin"].map(x => <th className="p-2 text-left" key={x}>{x}</th>)}</tr></thead><tbody>{points.map(p => <tr key={p.key} className="border-t border-border"><td className="p-2"><button type="button" onClick={() => pick(p.key)}>{monthLong(p.key, p.key)}</button></td><td>{formatUsd(p.revenue)}</td><td>{formatUsd(p.expense)}</td><td>{formatUsd(p.profit)}</td><td>{p.revenue ? `${(p.profit / p.revenue * 100).toFixed(1)}%` : "—"}</td></tr>)}</tbody></table></div> : <div className="relative mt-3" data-attr="cashflow-chart">
      <svg
        ref={svgRef}
        width="100%"
        height={CHART_H}
        viewBox={`0 0 ${width} ${CHART_H}`}
        role="group"
        aria-label="Running total of revenue, expenses and net profit"
        className="block select-none"
        onMouseMove={e => { const i = indexFromPointer(e.clientX); if (i !== hovered) setHover(i); }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => <g key={i} aria-hidden="true">
          <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--color-border)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 4"} />
          <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)">{shortUsd(t)}</text>
        </g>)}
        {running.map((p, i) => (points.length - 1 - i) % labelStep === 0 ? <text key={p.key} x={cx(i)} y={CHART_H - 10} textAnchor="middle" fontSize={11.5} fill="var(--color-muted)" aria-hidden="true">{p.label}</text> : null)}
        {hovered !== null ? <line x1={cx(hovered)} x2={cx(hovered)} y1={PAD.t} y2={PAD.t + plotH} stroke="var(--color-muted)" strokeWidth={1} strokeDasharray="3 3" data-attr="cashflow-guide" /> : null}
        {areaKeys.map(k => <path key={`area-${k}`} d={`${linePath(running, cx, y, SERIES_PICK[k])} L${cx(last)},${y(0)} L${cx(0)},${y(0)} Z`} fill={SERIES_COLOR[k]} fillOpacity={0.1} stroke="none" data-series={`${k}-area`} />)}
        {areaKeys.map(k => <path key={`line-${k}`} d={linePath(running, cx, y, SERIES_PICK[k])} fill="none" stroke={SERIES_COLOR[k]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" data-series={k} />)}
        {show.net ? <path d={linePath(running, cx, y, SERIES_PICK.net)} fill="none" stroke={SERIES_COLOR.net} strokeWidth={2.5} strokeDasharray="6 5" strokeLinejoin="round" data-series="net" /> : null}
        {visibleKeys.map(k => <circle key={`end-${k}`} cx={cx(last)} cy={y(SERIES_PICK[k](running[last]))} r={4.5} fill={SERIES_COLOR[k]} stroke="var(--color-card)" strokeWidth={2} data-series={`${k}-dot`} />)}
        {hovered !== null && hovered !== last ? visibleKeys.map(k => <circle key={`hover-${k}`} cx={cx(hovered)} cy={y(SERIES_PICK[k](running[hovered]))} r={4.5} fill={SERIES_COLOR[k]} stroke="var(--color-card)" strokeWidth={2} data-series={`${k}-hover-dot`} />) : null}
        {running.map((p, i) => <rect
          key={`hit-${p.key}`}
          x={cx(i) - colW / 2}
          y={PAD.t}
          width={colW}
          height={plotH}
          fill="transparent"
          role="button"
          tabIndex={0}
          aria-label={monthAria(p)}
          className="cursor-pointer outline-none"
          onFocus={() => setHover(i)}
          onBlur={() => setHover(null)}
          onClick={() => pick(p.key)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(p.key); } }}
        />)}
      </svg>
      {hovered !== null ? <div className="pointer-events-none absolute top-5 z-10 rounded-lg border border-border bg-card p-2 text-xs shadow-[var(--shadow-sm)]" style={{ left: tipLeft, width: TIP_W }} data-attr="cashflow-tooltip">
        <div className="mb-1 font-semibold text-foreground">{hoveredLabel} · running total</div>
        {tipRows.map(([k, label, total, month]) => <div key={k} className="mb-1 last:mb-0">
          <div className="flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ background: SERIES_COLOR[k] }} aria-hidden /><span className="flex-1 text-muted">{label}</span><span className="tabular-nums text-foreground">{formatUsd(total)}</span>
          </div>
          <div className="pl-3.5 tabular-nums text-muted" data-attr={`cashflow-tooltip-month-${k}`}>{signedUsd(month)} this month</div>
        </div>)}
      </div> : null}
    </div>}
  </section>;
}
