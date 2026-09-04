"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  BookingsDayDetailModal,
  type BookingsDayEntry,
} from "@/components/portal/bookings-day-detail-modal";
import {
  PORTAL_TOOLBAR_PILL_BUTTON,
  PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE,
} from "@/components/portal/portal-metrics";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import { bookingGuestShortLabel } from "@/lib/channel-calendar/booking-guest-label";
import {
  airbnbBookingEntries,
  bookedDayKeyCountInMonth,
  bookingEntriesForDayKey,
  filterBookingEntriesByRoom,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import {
  addDays,
  addMonths,
  buildMonthDayCells,
  dateKey,
  startOfLocalDay,
  startOfWeekSunday,
} from "@/lib/room-availability-calendar";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type BookingsCalendarView = "day" | "week" | "month" | "year";

const VIEW_OPTIONS: { id: BookingsCalendarView; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

function shiftAnchor(anchor: Date, view: BookingsCalendarView, direction: -1 | 1): Date {
  if (view === "day") return addDays(anchor, direction);
  if (view === "week") return addDays(anchor, direction * 7);
  if (view === "month") return addMonths(anchor, direction);
  return new Date(anchor.getFullYear() + direction, 0, 1);
}

function formatNavTitle(anchor: Date, view: BookingsCalendarView): string {
  if (view === "day") {
    return anchor.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
  }
  if (view === "week") {
    const start = startOfWeekSunday(anchor);
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    const startFmt = start.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      ...(sameMonth ? {} : { year: "numeric" }),
    });
    const endFmt = end.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${startFmt} – ${endFmt}`;
  }
  if (view === "month") {
    return anchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }
  return String(anchor.getFullYear());
}

function bookedDayKeyCountInRange(
  entries: PropertyBookingEntry[],
  start: Date,
  dayCount: number,
): number {
  let count = 0;
  for (let i = 0; i < dayCount; i++) {
    const key = dateKey(addDays(start, i));
    if (bookingEntriesForDayKey(entries, key).length > 0) count++;
  }
  return count;
}

function bookedDaysInYear(entries: PropertyBookingEntry[], year: number): number {
  let count = 0;
  for (let month = 0; month < 12; month++) {
    count += bookedDayKeyCountInMonth(entries, year, month);
  }
  return count;
}

function dayCellClassName(booked: boolean, isToday: boolean): string {
  return `flex min-h-0 flex-1 flex-col items-stretch rounded-md border p-1.5 text-left text-xs transition ${
    booked
      ? "border-amber-300 bg-amber-50 text-amber-950 hover:border-amber-400 [html[data-theme=dark]_&]:border-amber-700 [html[data-theme=dark]_&]:bg-amber-950/40 [html[data-theme=dark]_&]:text-amber-100"
      : "border-border bg-card text-foreground hover:border-primary/30 hover:bg-accent/30"
  } ${isToday ? "ring-1 ring-primary/40" : ""}`;
}

function DayBookingCell({
  cell,
  entries,
  today,
  onOpenDay,
}: {
  cell: Date;
  entries: PropertyBookingEntry[];
  today: Date;
  onOpenDay: (key: string) => void;
}) {
  const key = dateKey(cell);
  const dayBookings = bookingEntriesForDayKey(entries, key);
  const booked = dayBookings.length > 0;
  const isToday = key === dateKey(today);
  const preview = dayBookings[0];

  return (
    <button
      type="button"
      data-attr={`portfolio-booking-day-${key}`}
      className={dayCellClassName(booked, isToday)}
      onClick={() => onOpenDay(key)}
    >
      <span className={`text-[11px] font-semibold ${isToday ? "text-primary" : ""}`}>
        {cell.getDate()}
      </span>
      {booked ? (
        <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-hidden">
          <p className="truncate text-[10px] font-medium leading-tight">
            {preview?.source === "airbnb"
              ? bookingGuestShortLabel(preview?.summary, 14)
              : preview?.summary}
          </p>
          <p className="truncate text-[9px] opacity-80">
            {preview?.roomLabel}
            {dayBookings.length > 1 ? ` +${dayBookings.length - 1}` : ""}
          </p>
        </div>
      ) : null}
    </button>
  );
}

export function ManagerPortfolioBookingsCalendar({
  propertyIds,
  showToast,
  refreshSignal = 0,
  extraEntries,
  roomFilterId = "",
  emptyMessage,
  variant = "embedded",
}: {
  propertyIds: string[];
  showToast: (message: string) => void;
  refreshSignal?: number;
  /**
   * PropLane's own stays, supplied by the caller (it owns the lease store and
   * the property/room labels). Merged with the Airbnb ranges this component
   * fetches so a day cell reflects the house's real occupancy, not just one
   * channel.
   */
  extraEntries?: PropertyBookingEntry[];
  /** "" / "all" = every room. Only offered for rent-by-room listings. */
  roomFilterId?: string;
  emptyMessage?: string;
  /** Standalone Bookings nav page — no nested card chrome. */
  variant?: "embedded" | "standalone";
}) {
  const [airbnbEntries, setAirbnbEntries] = useState<PropertyBookingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<BookingsCalendarView>("month");
  const [anchorDate, setAnchorDate] = useState(() => startOfLocalDay(new Date()));
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  const today = useMemo(() => startOfLocalDay(new Date()), []);

  const monthStart = useMemo(
    () => new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1),
    [anchorDate],
  );
  const monthCells = useMemo(() => buildMonthDayCells(monthStart), [monthStart]);
  const weekStart = useMemo(() => startOfWeekSunday(anchorDate), [anchorDate]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart],
  );

  const propertyIdsKey = propertyIds.join(",");
  const fetchPropertyIds = useMemo(
    () => propertyIdsKey.split(",").filter(Boolean),
    [propertyIdsKey],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchManagerChannelBookings(fetchPropertyIds);
      setAirbnbEntries(airbnbBookingEntries(rows));
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load bookings.");
      setAirbnbEntries([]);
    } finally {
      setLoading(false);
    }
  }, [fetchPropertyIds, showToast]);

  useEffect(() => {
    void reload();
  }, [reload, refreshSignal]);

  const entries = useMemo(
    () => filterBookingEntriesByRoom([...airbnbEntries, ...(extraEntries ?? [])], roomFilterId),
    [airbnbEntries, extraEntries, roomFilterId],
  );

  const selectedDayBookings = useMemo<BookingsDayEntry[]>(
    () => (selectedDayKey ? bookingEntriesForDayKey(entries, selectedDayKey) : []),
    [entries, selectedDayKey],
  );

  const selectedDayLabel = useMemo(() => {
    if (!selectedDayKey) return "";
    const [y, m, d] = selectedDayKey.split("-").map(Number);
    if (!y || !m || !d) return selectedDayKey;
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }, [selectedDayKey]);

  const navSubtitle = useMemo(() => {
    if (view === "day") {
      const count = bookingEntriesForDayKey(entries, dateKey(anchorDate)).length;
      return `${count} booking${count === 1 ? "" : "s"} this day`;
    }
    if (view === "week") {
      const count = bookedDayKeyCountInRange(entries, weekStart, 7);
      return `${count} booked day${count === 1 ? "" : "s"} this week`;
    }
    if (view === "month") {
      const count = bookedDayKeyCountInMonth(entries, monthStart.getFullYear(), monthStart.getMonth());
      return `${count} booked day${count === 1 ? "" : "s"} this month`;
    }
    const count = bookedDaysInYear(entries, anchorDate.getFullYear());
    return `${count} booked day${count === 1 ? "" : "s"} this year`;
  }, [anchorDate, entries, monthStart, view, weekStart]);

  const openDay = (key: string) => {
    setSelectedDayKey(key);
    setDayModalOpen(true);
  };

  const goToMonth = (year: number, month: number) => {
    setAnchorDate(new Date(year, month, 1));
    setView("month");
  };

  if (propertyIds.length === 0) {
    return (
      <p className="text-sm text-muted">
        {emptyMessage ??
          "No houses in your portfolio yet. List a property, then link rooms with Link Airbnb."}
      </p>
    );
  }

  if (loading) {
    return <p className="text-sm text-muted">Loading bookings…</p>;
  }

  const shellClass =
    variant === "standalone"
      ? "flex min-h-0 flex-1 flex-col overflow-hidden"
      : "flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card p-3 sm:p-4";

  const prevLabel =
    view === "day"
      ? "Previous day"
      : view === "week"
        ? "Previous week"
        : view === "month"
          ? "Previous month"
          : "Previous year";
  const nextLabel =
    view === "day"
      ? "Next day"
      : view === "week"
        ? "Next week"
        : view === "month"
          ? "Next month"
          : "Next year";

  const dayViewBookings = bookingEntriesForDayKey(entries, dateKey(anchorDate));

  return (
    <>
      <div className={shellClass}>
        <div className="mb-2 flex shrink-0 flex-wrap items-center justify-center gap-1">
          {VIEW_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              data-attr={`bookings-calendar-view-${option.id}`}
              className={view === option.id ? PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE : PORTAL_TOOLBAR_PILL_BUTTON}
              onClick={() => setView(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="mb-2 flex shrink-0 items-center justify-between gap-2">
          <button
            type="button"
            aria-label={prevLabel}
            data-attr="bookings-calendar-prev"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted transition hover:border-primary/45 hover:bg-accent/35 hover:text-foreground"
            onClick={() => setAnchorDate((current) => shiftAnchor(current, view, -1))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate text-sm font-semibold text-foreground">
              {formatNavTitle(anchorDate, view)}
            </p>
            <p className="mt-0.5 text-[11px] font-medium text-muted">{navSubtitle}</p>
          </div>
          <button
            type="button"
            aria-label={nextLabel}
            data-attr="bookings-calendar-next"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted transition hover:border-primary/45 hover:bg-accent/35 hover:text-foreground"
            onClick={() => setAnchorDate((current) => shiftAnchor(current, view, 1))}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>

        {view === "day" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card p-3">
            <p className="shrink-0 text-3xl font-semibold tabular-nums text-foreground">
              {anchorDate.getDate()}
            </p>
            {dayViewBookings.length === 0 ? (
              <p className="mt-2 text-sm text-muted">No bookings on this day.</p>
            ) : (
              <ul className="mt-2 min-h-0 flex-1 space-y-2 overflow-hidden">
                {dayViewBookings.map((booking, index) => (
                  <li
                    key={`${booking.start}-${booking.roomId}-${index}`}
                    className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 [html[data-theme=dark]_&]:border-amber-700 [html[data-theme=dark]_&]:bg-amber-950/40 [html[data-theme=dark]_&]:text-amber-100"
                  >
                    <p className="font-medium">
                      {booking.source === "airbnb"
                        ? bookingGuestShortLabel(booking.summary, 40)
                        : booking.summary}
                    </p>
                    <p className="text-xs opacity-80">
                      {booking.roomLabel}
                      {booking.statusLabel ? ` · ${booking.statusLabel}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}

        {view === "week" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="mb-1 grid shrink-0 grid-cols-7 gap-1">
              {WEEKDAY_LABELS.map((label) => (
                <div
                  key={label}
                  className="py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted"
                >
                  {label}
                </div>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-7 gap-1">
              {weekDays.map((cell) => (
                <DayBookingCell
                  key={dateKey(cell)}
                  cell={cell}
                  entries={entries}
                  today={today}
                  onOpenDay={openDay}
                />
              ))}
            </div>
          </div>
        ) : null}

        {view === "month" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="mb-1 grid shrink-0 grid-cols-7 gap-1">
              {WEEKDAY_LABELS.map((label) => (
                <div
                  key={label}
                  className="py-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted"
                >
                  {label}
                </div>
              ))}
            </div>
            <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 gap-1">
              {monthCells.map((cell, index) => {
                if (!cell) {
                  return <div key={`pad-${index}`} className="min-h-0" aria-hidden />;
                }
                return (
                  <DayBookingCell
                    key={dateKey(cell)}
                    cell={cell}
                    entries={entries}
                    today={today}
                    onOpenDay={openDay}
                  />
                );
              })}
            </div>
          </div>
        ) : null}

        {view === "year" ? (
          <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-3 gap-2 sm:grid-cols-4">
            {Array.from({ length: 12 }, (_, month) => {
              const year = anchorDate.getFullYear();
              const booked = bookedDayKeyCountInMonth(entries, year, month);
              const label = new Date(year, month, 1).toLocaleDateString("en-US", { month: "long" });
              const isCurrentMonth =
                year === today.getFullYear() && month === today.getMonth();
              return (
                <button
                  key={month}
                  type="button"
                  data-attr={`bookings-calendar-year-month-${month + 1}`}
                  className={`flex min-h-0 flex-col items-start justify-center rounded-lg border p-2 text-left transition hover:border-primary/30 hover:bg-accent/30 ${
                    isCurrentMonth ? "border-primary/40 ring-1 ring-primary/30" : "border-border bg-card"
                  }`}
                  onClick={() => goToMonth(year, month)}
                >
                  <span className="text-sm font-semibold text-foreground">{label}</span>
                  <span className="mt-0.5 text-[11px] text-muted">
                    {booked} booked day{booked === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <BookingsDayDetailModal
        open={dayModalOpen}
        onClose={() => setDayModalOpen(false)}
        dayLabel={selectedDayLabel}
        entries={selectedDayBookings}
      />
    </>
  );
}
