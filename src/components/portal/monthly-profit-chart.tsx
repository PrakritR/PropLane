"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";
import {
  CASHFLOW_CHART_RANGE_MONTHS,
  cashflowMetricValue,
  cashflowWindowDirection,
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

const METRIC_OPTIONS: { id: CashflowChartMetric; label: string; subtitle: string }[] = [
  { id: "revenue", label: "Revenue", subtitle: "Revenue per month" },
  { id: "profit", label: "Profit", subtitle: "Profit per month" },
  { id: "expense", label: "Expense", subtitle: "Expense per month" },
];

function normalizePoints(
  points: MonthlyCashflowPoint[] | MonthlyProfitPoint[],
): MonthlyCashflowPoint[] {
  if (points.length === 0) return [];
  const first = points[0]!;
  if ("revenue" in first) return points as MonthlyCashflowPoint[];
  return (points as MonthlyProfitPoint[]).map((p) => ({
    key: p.key,
    label: p.label,
    revenue: 0,
    expense: 0,
    profit: p.profit,
  }));
}

function strokeForWindow(metric: CashflowChartMetric, direction: "up" | "down" | "flat"): string {
  if (metric === "expense") return "var(--foreground)";
  if (direction === "down") return "var(--status-overdue-fg)";
  return "var(--status-confirmed-fg)";
}

function heroClassForWindow(metric: CashflowChartMetric, direction: "up" | "down" | "flat"): string {
  if (metric === "expense") return "text-foreground";
  if (direction === "down") return "text-[var(--status-overdue-fg)]";
  return "text-[var(--status-confirmed-fg)]";
}

/**
 * Mobbin-referenced cash flow chart: thin scrubbable line, hero number, underline ranges.
 */
export function MonthlyProfitChart({
  points: rawPoints,
  title = "Cash flow",
  subtitle,
  className = "",
  defaultMetric = "revenue",
  defaultRangeMonths = 6,
  aspect = "hero",
}: {
  points: MonthlyCashflowPoint[] | MonthlyProfitPoint[];
  title?: string;
  subtitle?: string;
  className?: string;
  defaultMetric?: CashflowChartMetric;
  defaultRangeMonths?: CashflowChartRangeMonths;
  /**
   * `hero` is the 360×140 card the Cash flow tab draws; `wide` (900×170) is
   * for a full-width overview row, where the hero box would stand 450px tall.
   */
  aspect?: "hero" | "wide";
}) {
  const fillId = useId().replace(/:/g, "");
  const allPoints = useMemo(() => normalizePoints(rawPoints), [rawPoints]);
  const [metric, setMetric] = useState<CashflowChartMetric>(defaultMetric);
  const [rangeMonths, setRangeMonths] = useState<CashflowChartRangeMonths>(defaultRangeMonths);
  const chartRef = useRef<SVGSVGElement | null>(null);
  const dragging = useRef(false);

  const points = useMemo(
    () => allPoints.slice(-Math.min(rangeMonths, allPoints.length)),
    [allPoints, rangeMonths],
  );

  const [activeIndex, setActiveIndex] = useState(() => Math.max(0, points.length - 1));

  useEffect(() => {
    setActiveIndex(Math.max(0, points.length - 1));
  }, [points.length, metric, rangeMonths]);

  const active = points[activeIndex] ?? points[points.length - 1];
  const activeValue = active ? cashflowMetricValue(active, metric) : 0;
  const values = useMemo(() => points.map((p) => cashflowMetricValue(p, metric)), [points, metric]);
  const direction = cashflowWindowDirection(values);
  const stroke = strokeForWindow(metric, direction);

  const hasWindow = useMemo(() => values.some((v) => v !== 0), [values]);

  const chart = useMemo(() => {
    const w = aspect === "wide" ? 900 : 360;
    const h = aspect === "wide" ? 170 : 140;
    const padX = 8;
    const padY = 14;
    const minV = Math.min(...values, 0);
    const maxV = Math.max(...values, 1);
    const range = Math.max(maxV - minV, 1);
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    const yFor = (v: number) => padY + ((maxV - v) / range) * innerH;
    const xFor = (i: number) => padX + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);

    const coords = values.map((v, i) => ({ x: xFor(i), y: yFor(v), value: v }));
    const floorY = h - 4;
    const lineD = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(" ");
    const areaD =
      coords.length > 0
        ? `${lineD} L ${coords[coords.length - 1]!.x.toFixed(2)} ${floorY.toFixed(2)} L ${coords[0]!.x.toFixed(2)} ${floorY.toFixed(2)} Z`
        : "";

    return { w, h, coords, lineD, areaD, padX };
  }, [points.length, values, aspect]);

  const indexFromClientX = useCallback(
    (clientX: number) => {
      const el = chartRef.current;
      if (!el || chart.coords.length === 0) return 0;
      const rect = el.getBoundingClientRect();
      const t = (clientX - rect.left) / Math.max(rect.width, 1);
      return Math.max(0, Math.min(chart.coords.length - 1, Math.round(t * (chart.coords.length - 1))));
    },
    [chart.coords.length],
  );

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setActiveIndex(indexFromClientX(e.clientX));
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.pointerType === "mouse" || dragging.current) {
      setActiveIndex(indexFromClientX(e.clientX));
    }
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    dragging.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };
  const onPointerLeave = () => {
    if (!dragging.current) setActiveIndex(Math.max(0, points.length - 1));
  };

  const cursor = chart.coords[activeIndex] ?? chart.coords[chart.coords.length - 1];

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 sm:p-5 lg:p-6 [html[data-native]_&]:p-3.5 max-lg:p-3",
        className,
      )}
      data-attr="monthly-profit-chart"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground lg:text-lg">{title}</h2>
          {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
          <div
            className="flex rounded-full border border-border bg-accent/25 p-0.5"
            role="tablist"
            aria-label="Cash flow metric"
            onClick={(e) => e.stopPropagation()}
          >
            {METRIC_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={metric === opt.id}
                data-attr={`cashflow-metric-${opt.id}`}
                className={cn(
                  "portal-pressable min-h-11 min-w-0 rounded-full px-3 py-2 text-center text-[11px] font-semibold transition-colors sm:text-xs",
                  metric === opt.id
                    ? "bg-card text-foreground shadow-[var(--shadow-sm)]"
                    : "text-muted hover:text-foreground",
                )}
                onClick={() => setMetric(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {hasWindow && active ? (
        <>
          <div className="mt-2 min-w-0" data-attr="cashflow-hero">
          <p
            className={cn(
              "text-[2rem] font-light tabular-nums tracking-[-0.04em] transition-[color] duration-200 motion-reduce:transition-none sm:text-[2.35rem]",
              heroClassForWindow(metric, direction),
            )}
          >
            {formatUsd(activeValue)}
          </p>
          <p className="mt-1 text-sm text-muted">
            {active.label}
            <span className="hidden sm:inline">
              {" "}
              · {METRIC_OPTIONS.find((m) => m.id === metric)?.subtitle}
            </span>
          </p>
        </div>
        <div className="mt-3 lg:mt-4 -mx-1 sm:mx-0">
          <svg
            ref={chartRef}
            viewBox={`0 0 ${chart.w} ${chart.h}`}
            className="w-full touch-none min-h-[9.5rem] cursor-crosshair sm:min-h-[10.5rem] lg:min-h-[12rem]"
            role="img"
            aria-label={`Monthly ${metric} trend`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onPointerLeave={onPointerLeave}
          >
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity="0.18" />
                <stop offset="100%" stopColor={stroke} stopOpacity="0" />
              </linearGradient>
            </defs>
            {chart.areaD ? <path d={chart.areaD} fill={`url(#${fillId})`} /> : null}
            {chart.lineD ? (
              <path
                d={chart.lineD}
                fill="none"
                stroke={stroke}
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {cursor ? (
              <>
                <line
                  x1={cursor.x}
                  x2={cursor.x}
                  y1={8}
                  y2={chart.h - 4}
                  stroke="currentColor"
                  strokeOpacity="0.28"
                  strokeWidth="1"
                />
                <circle
                  cx={cursor.x}
                  cy={cursor.y}
                  r={4.5}
                  fill={stroke}
                  stroke="var(--card)"
                  strokeWidth="2"
                />
              </>
            ) : null}
          </svg>

          <CashflowRangeToggle
            appearance="underline"
            className="mt-1"
            value={rangeMonths}
            onChange={setRangeMonths}
            dataAttrPrefix="cashflow-range"
            accent={stroke}
          />
        </div>
        </>
      ) : (
        <p className="mt-6 text-sm text-muted [html[data-native]_&]:text-xs">
          No cash flow data yet. Collected rent and logged expenses will chart here by month.
        </p>
      )}
    </div>
  );
}
