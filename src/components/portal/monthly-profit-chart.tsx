"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  CASHFLOW_CHART_RANGE_MONTHS,
  cashflowChartShowMonthLabel,
  cashflowMetricValue,
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

function strokeForMetric(metric: CashflowChartMetric, value: number): string {
  if (metric === "expense") return "var(--status-pending-fg)";
  return value >= 0 ? "var(--status-confirmed-fg)" : "var(--status-overdue-fg)";
}

function heroClassForMetric(metric: CashflowChartMetric, value: number): string {
  if (metric === "expense") return "text-foreground";
  return value >= 0 ? "text-[var(--status-confirmed-fg)]" : "text-[var(--status-overdue-fg)]";
}

/**
 * Robinhood-style cash flow chart: metric + range toggles, hero number, smooth area line.
 */
export function MonthlyProfitChart({
  points: rawPoints,
  title = "Cash flow",
  subtitle,
  className = "",
  defaultMetric = "revenue",
  defaultRangeMonths = 6,
}: {
  points: MonthlyCashflowPoint[] | MonthlyProfitPoint[];
  title?: string;
  subtitle?: string;
  className?: string;
  defaultMetric?: CashflowChartMetric;
  defaultRangeMonths?: CashflowChartRangeMonths;
}) {
  const fillId = useId().replace(/:/g, "");
  const allPoints = useMemo(() => normalizePoints(rawPoints), [rawPoints]);
  const [metric, setMetric] = useState<CashflowChartMetric>(defaultMetric);
  const [rangeMonths, setRangeMonths] = useState<CashflowChartRangeMonths>(defaultRangeMonths);

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

  const hasAny = useMemo(
    () => allPoints.some((p) => p.revenue !== 0 || p.expense !== 0 || p.profit !== 0),
    [allPoints],
  );

  const chart = useMemo(() => {
    const w = 360;
    const h = 140;
    const padX = 4;
    const padY = 12;
    const values = points.map((p) => cashflowMetricValue(p, metric));
    const minV = Math.min(0, ...values);
    const maxV = Math.max(0, ...values);
    const range = Math.max(maxV - minV, 1);
    const innerW = w - padX * 2;
    const innerH = h - padY * 2;
    const yFor = (v: number) => padY + ((maxV - v) / range) * innerH;
    const xFor = (i: number) => padX + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);

    const coords = values.map((v, i) => ({ x: xFor(i), y: yFor(v), value: v }));
    const zeroY = yFor(0);
    const stroke = strokeForMetric(metric, activeValue);

    const lineD = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(" ");
    const areaD =
      coords.length > 0
        ? `${lineD} L ${coords[coords.length - 1]!.x.toFixed(2)} ${zeroY.toFixed(2)} L ${coords[0]!.x.toFixed(2)} ${zeroY.toFixed(2)} Z`
        : "";

    return { w, h, coords, zeroY, lineD, areaD, stroke, padX };
  }, [points, metric, activeValue]);

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

      {active ? (
        <div className="mt-2 min-w-0" data-attr="cashflow-hero">
          <p
            className={cn(
              "text-[2rem] font-light tabular-nums tracking-[-0.04em] transition-[color,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none sm:text-[2.35rem]",
              heroClassForMetric(metric, activeValue),
            )}
          >
            {formatUsd(activeValue)}
          </p>
          <p className="mt-1 text-sm text-muted transition-opacity duration-300 motion-reduce:transition-none">
            {active.label}
            <span className="hidden sm:inline">
              {" "}
              · {METRIC_OPTIONS.find((m) => m.id === metric)?.subtitle}
            </span>
          </p>
        </div>
      ) : null}

      {hasAny ? (
        <div className="mt-3 lg:mt-4 -mx-1 sm:mx-0">
          <svg
            viewBox={`0 0 ${chart.w} ${chart.h}`}
            className="w-full touch-pan-y min-h-[9.5rem] sm:min-h-[10.5rem] lg:min-h-[12rem]"
            role="img"
            aria-label={`Monthly ${metric} trend`}
          >
            <defs>
              <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={chart.stroke} stopOpacity="0.38" />
                <stop offset="100%" stopColor={chart.stroke} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <line
              x1={chart.padX}
              x2={chart.w - chart.padX}
              y1={chart.zeroY}
              y2={chart.zeroY}
              stroke="var(--border)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {chart.areaD ? <path d={chart.areaD} fill={`url(#${fillId})`} /> : null}
            {chart.lineD ? (
              <path
                d={chart.lineD}
                fill="none"
                stroke={chart.stroke}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            {chart.coords.map((c, i) => (
              <circle
                key={points[i]!.key}
                cx={c.x}
                cy={c.y}
                r={activeIndex === i ? 5 : 3}
                fill={chart.stroke}
                className="transition-[r] duration-150"
              />
            ))}
            {chart.coords.map((c, i) => (
              <rect
                key={`hit-${points[i]!.key}`}
                x={i === 0 ? chart.padX : (chart.coords[i - 1]!.x + c.x) / 2}
                y={0}
                width={
                  i === 0
                    ? (chart.coords[1]?.x ?? c.x) - chart.padX
                    : i === chart.coords.length - 1
                      ? chart.w - chart.padX - (chart.coords[i - 1]!.x + c.x) / 2
                      : (chart.coords[i + 1]!.x - chart.coords[i - 1]!.x) / 2
                }
                height={chart.h}
                fill="transparent"
                className="cursor-pointer"
                onClick={() => setActiveIndex(i)}
              />
            ))}
          </svg>

          <div
            className="mt-2 flex justify-center gap-1 px-1"
            role="tablist"
            aria-label="Chart time range"
            onClick={(e) => e.stopPropagation()}
          >
            {CASHFLOW_CHART_RANGE_MONTHS.map((months) => (
              <button
                key={months}
                type="button"
                role="tab"
                aria-selected={rangeMonths === months}
                data-attr={`cashflow-range-${months}`}
                className={cn(
                  "portal-pressable min-h-11 rounded-full px-3 py-2 text-[11px] font-semibold tabular-nums transition-colors sm:px-3.5 sm:text-xs",
                  rangeMonths === months
                    ? "bg-foreground text-background"
                    : "text-muted hover:bg-accent/40 hover:text-foreground",
                )}
                onClick={() => setRangeMonths(months)}
              >
                {rangeLabel(months)}
              </button>
            ))}
          </div>

          <div className="mt-2 flex justify-between gap-0.5 px-0.5">
            {points.map((p, i) => {
              const showLabel = cashflowChartShowMonthLabel(i, points.length, rangeMonths);
              return (
              <button
                key={p.key}
                type="button"
                onClick={() => setActiveIndex(i)}
                aria-label={showLabel ? undefined : `${p.label} ${metric}`}
                className={cn(
                  "min-w-0 flex-1 rounded-md py-1 text-center text-[10px] font-medium transition-colors sm:text-[11px]",
                  activeIndex === i ? "bg-primary/10 text-foreground" : "text-muted hover:text-foreground",
                  !showLabel && "text-transparent [html[data-native]_&]:min-h-[1.25rem]",
                )}
                data-attr={`monthly-profit-month-${p.key}`}
              >
                {showLabel ? p.label : "\u00a0"}
              </button>
            );
            })}
          </div>
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted [html[data-native]_&]:text-xs">
          No cash flow data yet. Collected rent and logged expenses will chart here by month.
        </p>
      )}
    </div>
  );
}
