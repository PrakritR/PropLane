"use client";

import type { BookingsOccupancyStats } from "@/lib/channel-calendar/bookings-ui";

const KPI_TILE =
  "flex min-w-0 flex-col rounded-xl border border-border bg-card/80 px-3 py-2.5 shadow-[var(--shadow-sm)] backdrop-blur-sm";

export function BookingsKpiStrip({
  stats,
  periodLabel,
}: {
  stats: BookingsOccupancyStats;
  periodLabel: string;
}) {
  return (
    <div
      className="grid shrink-0 grid-cols-3 gap-2 sm:gap-3"
      data-attr="bookings-kpi-strip"
    >
      <div className={KPI_TILE}>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
          Booked nights
        </span>
        <span className="mt-0.5 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
          {stats.bookedNights}
        </span>
        <span className="text-[11px] text-muted">{periodLabel}</span>
      </div>
      <div className={KPI_TILE}>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
          Check-ins
        </span>
        <span className="mt-0.5 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
          {stats.checkInsThisWeek}
        </span>
        <span className="text-[11px] text-muted">This week</span>
      </div>
      <div className={KPI_TILE}>
        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted">
          Occupancy
        </span>
        <span className="mt-0.5 text-xl font-bold tabular-nums text-foreground sm:text-2xl">
          {stats.occupancyPercent}%
        </span>
        <span className="text-[11px] text-muted">{periodLabel}</span>
      </div>
    </div>
  );
}
