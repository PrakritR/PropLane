"use client";

/**
 * The one-range calendar of the short-stay booking application (`resident-stay-request.tsx`): taken nights
 * crossed out, a first tap sets check-in and a second sets check-out, and once check-in is chosen every day
 * past the first taken night (or past the longest stay) closes. The calendar only picks; the server's dry
 * run is what decides whether the dates can be requested.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { addRangeDays, rangeDaysBetween } from "@/lib/room-availability-range";
import { SHORT_STAY_MAX_NIGHTS, shortStayDayLabel } from "@/lib/short-stay-request";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

export function monthStart(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

export function shiftMonth(month: string, delta: number): string {
  const date = new Date(`${month}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta, 1);
  return date.toISOString().slice(0, 10);
}

function monthLabel(month: string): string {
  return new Date(`${month}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** The nights of a calendar month as a Sunday-first grid; leading blanks are null. */
export function monthCells(month: string): Array<string | null> {
  const first = new Date(`${month}T12:00:00Z`);
  const lead = first.getUTCDay();
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return [...Array.from({ length: lead }, () => null), ...Array.from({ length: days }, (_, i) => addRangeDays(month, i))];
}

export function StayRequestCalendar({
  month,
  onMonth,
  today,
  lastBookableDay,
  checkIn,
  checkOut,
  nightTaken,
  rangeFree,
  onPickDay,
  disabled,
}: {
  month: string;
  onMonth: (next: string) => void;
  today: string;
  lastBookableDay: string;
  checkIn: string;
  checkOut: string;
  /** True when one more guest-night would overfill the room on this night. */
  nightTaken: (night: string) => boolean;
  rangeFree: (range: { checkIn: string; checkOut: string }) => boolean;
  onPickDay: (day: string) => void;
  disabled?: boolean;
}) {
  const selecting = Boolean(checkIn && !checkOut);
  const dayState = (day: string): { disabled: boolean; taken: boolean } => {
    const taken = nightTaken(day);
    if (day < today || day > lastBookableDay) return { disabled: true, taken: false };
    if (!selecting) return { disabled: taken, taken };
    if (day <= checkIn) return { disabled: taken, taken };
    return { disabled: !rangeFree({ checkIn, checkOut: day }) || rangeDaysBetween(checkIn, day) > SHORT_STAY_MAX_NIGHTS, taken };
  };
  return (
    <div data-attr="stay-request-calendar">
      <div className="mb-2 flex items-center justify-between">
        <PortalIconAction icon={ChevronLeft} label="Previous month" disabled={month <= monthStart(today)} onClick={() => onMonth(shiftMonth(month, -1))} />
        <span className="text-[14px] font-semibold">{monthLabel(month)}</span>
        <PortalIconAction icon={ChevronRight} label="Next month" disabled={month >= monthStart(lastBookableDay)} onClick={() => onMonth(shiftMonth(month, 1))} />
      </div>
      <div className="grid grid-cols-7 gap-1 text-center text-[12px] text-muted">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {monthCells(month).map((day, index) => {
          if (!day) return <span key={`blank-${index}`} />;
          const state = dayState(day);
          const picked = Boolean(checkIn && (day === checkIn || (checkOut && day === checkOut)));
          const between = Boolean(checkIn && checkOut && day > checkIn && day < checkOut);
          return (
            <button
              key={day}
              type="button"
              disabled={state.disabled || disabled}
              onClick={() => onPickDay(day)}
              data-day={day}
              data-taken={state.taken ? "" : undefined}
              aria-label={`${shortStayDayLabel(day)}${state.taken ? ", taken" : ""}`}
              aria-pressed={picked || between}
              className={[
                "grid h-10 place-items-center rounded-lg text-[14px] tabular-nums transition-colors",
                picked ? "bg-primary text-white" : between ? "bg-primary/15 text-foreground" : "hover:bg-accent",
                state.taken ? "text-muted line-through" : "",
                state.disabled && !state.taken ? "text-muted/50" : "",
                "disabled:cursor-not-allowed",
              ].join(" ")}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
