"use client";

/**
 * One room's availability as a month grid.
 *
 * Shared by the public listing page (every span red) and the listing editor's
 * Rooms step (the manager's own occupied dates red, residents' stays, Bookings
 * blocks and Airbnb imports grey). Open days are green, past days fade, today is
 * ringed. The month range runs from the current month to twelve months out or
 * to the last span, whichever is later, and the prev arrow is disabled on the
 * first month. Read-only: nothing here writes a span.
 */

import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  addMonths,
  buildMonthDayCells,
  dateKey,
  dayIsUnavailable,
  monthAvailabilityTone,
  monthToneLabel,
  resolveAvailabilityMonthRange,
  startOfLocalDay,
  type AvailabilityDayWindow,
  type MonthAvailabilityTone,
} from "@/lib/room-availability-calendar";

export type RoomCalendarSpanTone = "occupied" | "booked";

export type RoomCalendarSpan = AvailabilityDayWindow & {
  /** Red for the manager's own occupied dates; grey for a stay, block or import someone else owns. */
  tone: RoomCalendarSpanTone;
};

function monthTonePillClasses(tone: MonthAvailabilityTone): string {
  switch (tone) {
    case "available":
      return "portal-badge-success ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
    case "unavailable":
      return "portal-badge-danger ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
    case "mixed":
      return "portal-badge-pending ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  }
}

const DAY_OPEN = "bg-emerald-100 text-emerald-950 ring-1 ring-inset ring-emerald-300 [html[data-theme=dark]_&]:portal-calendar-open-slot";
const DAY_OCCUPIED =
  "bg-rose-100 text-rose-950 ring-1 ring-inset ring-rose-300 [html[data-theme=dark]_&]:bg-rose-950/40 [html[data-theme=dark]_&]:text-rose-100 [html[data-theme=dark]_&]:ring-rose-700/60";
const DAY_BOOKED =
  "bg-slate-200 text-slate-800 ring-1 ring-inset ring-slate-300 [html[data-theme=dark]_&]:bg-slate-800/60 [html[data-theme=dark]_&]:text-slate-100 [html[data-theme=dark]_&]:ring-slate-600/60";

/** Which colour a day takes: a booked span wins over a typed one, as in the timeline's derivation. */
export function roomCalendarDayTone(day: Date, spans: readonly RoomCalendarSpan[]): RoomCalendarSpanTone | "open" {
  const booked = spans.filter((s) => s.tone === "booked");
  if (dayIsUnavailable(day, booked)) return "booked";
  const occupied = spans.filter((s) => s.tone === "occupied");
  if (dayIsUnavailable(day, occupied)) return "occupied";
  return "open";
}

function dayClasses(tone: RoomCalendarSpanTone | "open", isPast: boolean, isToday: boolean): string {
  const base = tone === "booked" ? DAY_BOOKED : tone === "occupied" ? DAY_OCCUPIED : DAY_OPEN;
  return `${base} ${isPast ? "opacity-45" : ""} ${isToday ? "ring-2 ring-primary/50" : ""}`;
}

function MonthGrid({ monthStart, spans, today }: { monthStart: Date; spans: readonly RoomCalendarSpan[]; today: Date }) {
  const cells = buildMonthDayCells(monthStart);
  return (
    <>
      <div className="grid grid-cols-7 gap-0.5 text-center text-[9px] font-semibold uppercase tracking-wide text-muted sm:text-[10px]">
        {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-0.5">
        {cells.map((cell, idx) => {
          if (!cell) return <span key={`empty-${idx}`} className="h-7 sm:h-8" />;
          const tone = roomCalendarDayTone(cell, spans);
          const key = dateKey(cell);
          const isToday = key === dateKey(today);
          const isPast = cell.getTime() < today.getTime();
          return (
            <span
              key={key}
              data-day={key}
              data-tone={tone}
              className={`flex h-7 items-center justify-center rounded-md text-[11px] font-medium sm:h-8 sm:text-xs ${dayClasses(tone, isPast, isToday)}`}
            >
              {cell.getDate()}
            </span>
          );
        })}
      </div>
    </>
  );
}

const NAV_BUTTON =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted transition hover:border-primary/45 hover:bg-accent/35 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45";

export function RoomAvailabilityMonthCalendar({
  spans,
  legend = false,
  dataAttr,
}: {
  spans: readonly RoomCalendarSpan[];
  /** Print the three-colour key under the grid (the editor); the public page explains it in its own words. */
  legend?: boolean;
  dataAttr?: string;
}) {
  const today = startOfLocalDay(new Date());
  const { startMonth, monthCount } = resolveAvailabilityMonthRange(spans);
  const spansKey = spans.map((s) => `${s.start?.toISOString() ?? ""}|${s.end?.toISOString() ?? ""}|${s.tone}`).join(",");
  const [monthOffset, setMonthOffset] = useState(0);
  const [prevSpansKey, setPrevSpansKey] = useState(spansKey);
  if (spansKey !== prevSpansKey) {
    setPrevSpansKey(spansKey);
    setMonthOffset(0);
  }

  const clampedOffset = Math.min(Math.max(monthOffset, 0), Math.max(monthCount - 1, 0));
  const monthStart = addMonths(startMonth, clampedOffset);
  const tone = monthAvailabilityTone(monthStart, spans, today);

  return (
    <div className="rounded-xl border border-border bg-card p-3 sm:p-4" data-attr={dataAttr}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <button
          type="button"
          aria-label="Previous month"
          className={NAV_BUTTON}
          disabled={clampedOffset <= 0}
          onClick={() => setMonthOffset((value) => Math.max(value - 1, 0))}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        <div className="min-w-0 flex flex-1 flex-col items-center gap-1 text-center">
          <p className="text-sm font-semibold text-foreground">
            {monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
          </p>
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${monthTonePillClasses(tone)}`}>{monthToneLabel(tone)}</span>
        </div>
        <button
          type="button"
          aria-label="Next month"
          className={NAV_BUTTON}
          disabled={clampedOffset >= monthCount - 1}
          onClick={() => setMonthOffset((value) => Math.min(value + 1, monthCount - 1))}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <MonthGrid monthStart={monthStart} spans={spans} today={today} />
      {legend ? (
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] font-medium text-muted" aria-label="Calendar key">
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${DAY_OPEN}`} />Open</li>
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${DAY_OCCUPIED}`} />Occupied</li>
          <li className="inline-flex items-center gap-1.5"><span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${DAY_BOOKED}`} />Booked · resident, block, Airbnb</li>
        </ul>
      ) : null}
    </div>
  );
}
