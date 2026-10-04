"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { BarChart3, Table2 } from "lucide-react";
import { PortalSegmentedControl } from "@/components/portal/portal-metrics";
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

const CHART_H = 300;
const PAD = { l: 56, r: 12, t: 12, b: 30 };
const DEFAULT_WIDTH = 900;

/** One bar with 4px rounded tops, anchored to the baseline (grows down for a negative value). */
function barPath(x: number, w: number, y0: number, y1: number): string {
  const h = Math.abs(y0 - y1);
  if (h < 0.5) return "";
  const r = Math.min(4, h, w / 2);
  const d = y1 <= y0 ? 1 : -1;
  return `M${x},${y0} L${x},${y1 + d * r} Q${x},${y1} ${x + r},${y1} L${x + w - r},${y1} Q${x + w},${y1} ${x + w},${y1 + d * r} L${x + w},${y0} Z`;
}

/**
 * Cash flow: revenue and expense bars with net profit as a line, all on ONE dollar axis.
 * KPI tiles total the selected range (or the hovered month); a tile or the series
 * switch isolates one series and the axis refits to what is shown.
 */
export function MonthlyProfitChart({ points: rawPoints, title = "Cash flow", className = "", defaultRangeMonths = 6, hideSummary = false, onMonthSelect }: {
  points: MonthlyCashflowPoint[] | MonthlyProfitPoint[];
  title?: string; subtitle?: string; className?: string;
  defaultMetric?: CashflowChartMetric; defaultRangeMonths?: CashflowChartRangeMonths;
  aspect?: "hero" | "wide";
  hideSummary?: boolean;
  onMonthSelect?: (month: string) => void;
}) {
  const [range, setRangeState] = useState<string>(String(defaultRangeMonths));
  const [series, setSeries] = useState<CashflowSeries>("all");
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const all = useMemo<NormalizedPoint[]>(() => rawPoints.map(p => "revenue" in p ? p : { ...p, revenue: 0, expense: 0 }), [rawPoints]);
  const latestYear = all.at(-1)?.key.slice(0, 4);
  // The ONE month set: bars, axis, tooltip and KPI totals all read `points`.
  const startIdx = range === "ytd"
    ? Math.max(0, all.findIndex(p => p.key.startsWith(latestYear ?? "")))
    : Math.max(0, all.length - Number(range));
  const points = useMemo(() => all.slice(startIdx), [all, startIdx]);
  const priorPoints = points.length > 0 && startIdx - points.length >= 0 ? all.slice(startIdx - points.length, startIdx) : null;
  const hovered = hover !== null && hover < points.length ? hover : null;

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
    else window.location.assign(`/portal/financials/activity?month=${encodeURIComponent(key)}`);
  };

  const show = { rev: series === "all" || series === "rev", exp: series === "all" || series === "exp", net: series === "all" || series === "net" };
  const sum = (list: NormalizedPoint[]) => list.reduce((t, p) => ({ rev: t.rev + p.revenue, exp: t.exp + p.expense, net: t.net + p.profit }), { rev: 0, exp: 0, net: 0 });
  const totals = sum(hovered !== null ? [points[hovered]] : points);
  const priorTotals = priorPoints ? sum(priorPoints) : null;
  const rangeText = range === "ytd" ? "Year to date" : `Last ${range} months`;
  const margin = totals.rev ? totals.net / totals.rev * 100 : null;
  const hoveredLabel = hovered !== null ? monthLong(points[hovered].key, points[hovered].label) : null;
  const tiles: { id: SeriesKey | "margin"; label: string; value: string; delta: string }[] = [
    { id: "rev", label: "Revenue", value: formatUsd(totals.rev), delta: priorTotals ? `${signedUsd(totals.rev - priorTotals.rev)} vs prior period` : rangeText },
    { id: "exp", label: "Expenses", value: formatUsd(totals.exp), delta: priorTotals ? `${signedUsd(totals.exp - priorTotals.exp)} vs prior period` : rangeText },
    { id: "net", label: "Net profit", value: formatUsd(totals.net), delta: priorTotals ? `${signedUsd(totals.net - priorTotals.net)} vs prior period` : rangeText },
    { id: "margin", label: "Margin", value: margin === null ? "—" : `${margin.toFixed(1)}%`, delta: rangeText },
  ];

  // One dollar axis shared by every visible series; refits to what is shown.
  const values = [0];
  for (const p of points) {
    if (show.rev) values.push(p.revenue);
    if (show.exp) values.push(p.expense);
    if (show.net) values.push(p.profit);
  }
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
  const both = show.rev && show.exp;
  const barW = Math.min(18, colW * (both ? 0.28 : 0.4));
  const labelStep = colW < 30 ? 2 : 1;

  const indexFromPointer = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg || colW <= 0) return null;
    const rect = svg.getBoundingClientRect();
    const px = (clientX - rect.left) * (rect.width > 0 ? width / rect.width : 1);
    const i = Math.floor((px - PAD.l) / colW);
    return i < 0 || i >= points.length ? null : i;
  };

  const tipLeft = hovered === null ? 0 : (() => {
    const left = cx(hovered) + colW / 2 + 8;
    return left > width - 170 ? cx(hovered) - colW / 2 - 170 : left;
  })();
  const monthAria = (p: NormalizedPoint) => `${monthLong(p.key, p.label)}: Revenue ${formatUsd(p.revenue)}, Expenses ${formatUsd(p.expense)}, Net profit ${formatUsd(p.profit)}`;

  return <section className={cn("rounded-xl border border-border bg-card p-4", className)} data-attr="monthly-profit-chart">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="flex flex-wrap items-center gap-3">
        <PortalSegmentedControl<CashflowSeries>
          ariaLabel="Chart series"
          size="sm"
          value={series}
          onChange={setSeries}
          options={[
            { id: "all", label: "All" },
            { id: "rev", label: "Revenue" },
            { id: "exp", label: "Expenses" },
            { id: "net", label: "Net profit" },
          ]}
        />
        <PortalSegmentedControl<string>
          ariaLabel="Chart time range"
          size="sm"
          value={range}
          onChange={setRange}
          options={[
            { id: "6", label: "6M" },
            { id: "12", label: "12M" },
            { id: "ytd", label: "YTD" },
          ]}
        />
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
        aria-label="Monthly revenue, expenses and net profit"
        className="block select-none"
        onMouseMove={e => { const i = indexFromPointer(e.clientX); if (i !== hovered) setHover(i); }}
        onMouseLeave={() => setHover(null)}
      >
        {ticks.map((t, i) => <g key={i} aria-hidden="true">
          <line x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} stroke="var(--color-border)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : "2 4"} />
          <text x={PAD.l - 8} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)">{shortUsd(t)}</text>
        </g>)}
        {points.map((p, i) => <g key={p.key}>
          {hovered === i ? <rect x={cx(i) - colW / 2 + 2} y={PAD.t} width={Math.max(0, colW - 4)} height={plotH} rx={8} fill="var(--color-muted)" fillOpacity={0.1} /> : null}
          {show.rev ? <path d={barPath(both ? cx(i) - barW - 1 : cx(i) - barW / 2, barW, y(0), y(p.revenue))} fill={SERIES_COLOR.rev} data-series="rev" /> : null}
          {show.exp ? <path d={barPath(both ? cx(i) + 1 : cx(i) - barW / 2, barW, y(0), y(p.expense))} fill={SERIES_COLOR.exp} data-series="exp" /> : null}
          {(points.length - 1 - i) % labelStep === 0 ? <text x={cx(i)} y={CHART_H - 10} textAnchor="middle" fontSize={11.5} fill="var(--color-muted)">{p.label}</text> : null}
        </g>)}
        {show.net ? <g>
          <path d={points.map((p, i) => `${i ? "L" : "M"}${cx(i)},${y(p.profit)}`).join(" ")} fill="none" stroke={SERIES_COLOR.net} strokeWidth={2} data-series="net" />
          {points.map((p, i) => <circle key={p.key} cx={cx(i)} cy={y(p.profit)} r={4} fill={SERIES_COLOR.net} stroke="var(--color-card)" strokeWidth={2} data-series="net-dot" />)}
        </g> : null}
        {points.map((p, i) => <rect
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
      {hovered !== null ? <div className="pointer-events-none absolute top-5 z-10 w-40 rounded-lg border border-border bg-card p-2 text-xs shadow-[var(--shadow-sm)]" style={{ left: tipLeft }} data-attr="cashflow-tooltip">
        <div className="mb-1 font-semibold text-foreground">{hoveredLabel}</div>
        {([["rev", "Revenue", points[hovered].revenue], ["exp", "Expenses", points[hovered].expense], ["net", "Net profit", points[hovered].profit]] as const).filter(([k]) => show[k]).map(([k, label, value]) => <div key={k} className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm" style={{ background: SERIES_COLOR[k] }} aria-hidden /><span className="flex-1 text-muted">{label}</span><span className="tabular-nums text-foreground">{formatUsd(value)}</span>
        </div>)}
      </div> : null}
    </div>}
  </section>;
}
