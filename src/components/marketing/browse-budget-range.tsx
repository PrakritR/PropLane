"use client";

import { useId, useMemo } from "react";
import {
  RESIDENT_HOUSING_BUDGET_MAX,
  RESIDENT_HOUSING_BUDGET_MIN,
  RESIDENT_HOUSING_BUDGET_STEP,
} from "@/components/marketing/resident-listing-search";

const BAND = 500;

export function formatBudgetBound(n: number): string {
  return `$${n.toLocaleString()}`;
}

/** The range's own label: "$500 – $1,500", with a "+" when the right thumb is at the ceiling. */
export function formatBudgetRangeLabel(min: number, max: number): string {
  const top = max >= RESIDENT_HOUSING_BUDGET_MAX ? `${formatBudgetBound(RESIDENT_HOUSING_BUDGET_MAX)}+` : formatBudgetBound(max);
  return `${formatBudgetBound(min)} – ${top}`;
}

/**
 * The chip's short wording for an active budget: "Under $1,500" when only the
 * ceiling moved, "$800+" when only the floor did, else the full range.
 */
export function formatBudgetChipLabel(min: number, max: number): string | null {
  const minActive = min > RESIDENT_HOUSING_BUDGET_MIN;
  const maxActive = max < RESIDENT_HOUSING_BUDGET_MAX;
  if (!minActive && !maxActive) return null;
  if (!minActive) return `Under ${formatBudgetBound(max)}`;
  if (!maxActive) return `${formatBudgetBound(min)}+`;
  return `${formatBudgetBound(min)} – ${formatBudgetBound(max)}`;
}

/**
 * Dual-thumb monthly budget with a histogram of the homes currently loaded
 * (one bar per $500 band). The bars are the catalog's own rents, so the
 * picture is honest and costs no request. Two native range inputs sit on one
 * track: the min thumb never crosses the max, and each carries its own label.
 */
export function BrowseBudgetRange({
  min,
  max,
  onChange,
  rents,
  hideLabel = false,
}: {
  min: number;
  max: number;
  onChange: (next: { min: number; max: number }) => void;
  /** Monthly-equivalent rents of every home before the budget filter is applied. */
  rents: number[];
  /** The parent already renders "Monthly budget" and the live readout on its own label row. */
  hideLabel?: boolean;
}) {
  const id = useId();
  const floor = RESIDENT_HOUSING_BUDGET_MIN;
  const ceiling = RESIDENT_HOUSING_BUDGET_MAX;
  const step = RESIDENT_HOUSING_BUDGET_STEP;
  const span = ceiling - floor;

  const bands = useMemo(() => {
    const count = Math.ceil(span / BAND);
    const out = Array.from({ length: count }, () => 0);
    for (const rent of rents) {
      if (!Number.isFinite(rent)) continue;
      const idx = Math.min(count - 1, Math.max(0, Math.floor((rent - floor) / BAND)));
      out[idx] = (out[idx] ?? 0) + 1;
    }
    const peak = Math.max(1, ...out);
    return out.map((n, i) => ({
      start: floor + i * BAND,
      end: floor + (i + 1) * BAND,
      count: n,
      pct: n === 0 ? 8 : Math.max(14, Math.round((n / peak) * 100)),
    }));
  }, [rents, floor, span]);

  const lo = ((min - floor) / span) * 100;
  const hi = ((max - floor) / span) * 100;

  function setMin(next: number) {
    const clamped = Math.min(next, max - step);
    onChange({ min: Math.max(floor, clamped), max });
  }
  function setMax(next: number) {
    const clamped = Math.max(next, min + step);
    onChange({ min, max: Math.min(ceiling, clamped) });
  }

  return (
    <div className="min-w-0 pb-1" data-attr="resident-browse-budget-range">
      {hideLabel ? null : (
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <span className="text-sm font-semibold text-foreground">Monthly budget</span>
          <span className="text-sm font-bold tabular-nums text-foreground" aria-live="polite">
            {formatBudgetRangeLabel(min, max)}
          </span>
        </div>
      )}

      <div className="flex h-11 items-end gap-[3px] px-1" aria-hidden>
        {bands.map((b) => {
          const inRange = b.end > min && b.start < max;
          return (
            <span
              key={b.start}
              className={`flex-1 rounded-t-[3px] transition-colors ${inRange ? "bg-primary/70" : "bg-border"}`}
              style={{ height: `${b.pct}%` }}
              title={`${b.count} ${b.count === 1 ? "home" : "homes"} ${formatBudgetBound(b.start)}–${formatBudgetBound(b.end)}`}
            />
          );
        })}
      </div>

      <div className="browse-budget-range relative mx-1 h-6">
        <div className="absolute inset-x-0 top-[10.5px] h-[3px] rounded-full bg-border" />
        <div
          className="absolute top-[10.5px] h-[3px] rounded-full bg-foreground"
          style={{ left: `${lo}%`, right: `${100 - hi}%` }}
        />
        <input
          id={`${id}-min`}
          type="range"
          min={floor}
          max={ceiling}
          step={step}
          value={min}
          onChange={(e) => setMin(Number(e.target.value))}
          aria-label="Minimum monthly budget"
          data-attr="resident-browse-budget-min"
        />
        <input
          id={`${id}-max`}
          type="range"
          min={floor}
          max={ceiling}
          step={step}
          value={max}
          onChange={(e) => setMax(Number(e.target.value))}
          aria-label="Maximum monthly budget"
          data-attr="resident-browse-budget-max"
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label htmlFor={`${id}-min`} className="flex min-w-0 flex-col gap-1 text-[11.5px] font-semibold text-muted">
          Minimum
          <output className="flex h-10 items-center rounded-xl border border-border bg-card px-3 text-sm font-semibold tabular-nums text-foreground">
            {formatBudgetBound(min)}
          </output>
        </label>
        <label htmlFor={`${id}-max`} className="flex min-w-0 flex-col gap-1 text-[11.5px] font-semibold text-muted">
          Maximum
          <output className="flex h-10 items-center rounded-xl border border-border bg-card px-3 text-sm font-semibold tabular-nums text-foreground">
            {max >= ceiling ? `${formatBudgetBound(ceiling)}+` : formatBudgetBound(max)}
          </output>
        </label>
      </div>
    </div>
  );
}
