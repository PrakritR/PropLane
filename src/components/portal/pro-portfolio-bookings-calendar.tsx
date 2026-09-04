"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  BookingsDayDetailModal,
  type BookingsDayEntry,
} from "@/components/portal/bookings-day-detail-modal";
import { BookingsKpiStrip } from "@/components/portal/bookings-kpi-strip";
import { ManagerBookingsListPanel } from "@/components/portal/bookings-list-panel";
import { PORTAL_CALENDAR_FRAME, PortalSegmentedControl } from "@/components/portal/portal-metrics";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import { bookingGuestShortLabel, bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import {
  airbnbBookingEntries,
  bookedDayKeyCountInMonth,
  bookingEntriesForDayKey,
  filterBookingEntriesByRoom,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import {
  bookingOccupancyStats,
  bookingSourceLabel,
  bookingStatusTone,
  formatBookingStayRange,
  type BookingsHubMode,
} from "@/lib/channel-calendar/bookings-ui";
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

const CALENDAR_VIEW_OPTIONS: { id: BookingsCalendarView; label: string }[] = [
  { id: "day", label: "Day" },
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" },
];

const HUB_OPTIONS: { id: BookingsHubMode; label: string }[] = [
  { id: "calendar", label: "Calendar" },
  { id: "list", label: "List" },
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

function kpiPeriodLabel(view: BookingsCalendarView): string {
  if (view === "day") return "Today";
  if (view === "week") return "This week";
  if (view === "month") return "This month";
  return "This year";
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

function dominantSourceForDay(
  dayBookings: PropertyBookingEntry[],
): PropertyBookingEntry["source"] | null {
  if (dayBookings.length === 0) return null;
  if (dayBookings.some((b) => b.source === "proplane")) return "proplane";
  return "airbnb";
}

function dayCellClassName(
  booked: boolean,
  isToday: boolean,
  source: PropertyBookingEntry["source"] | null,
): string {
  const base =
    "flex min-h-0 flex-1 flex-col items-stretch rounded-lg border p-1.5 text-left text-xs transition hover:shadow-[var(--shadow-sm)]";
  if (!booked) {
    return `${base} border-border/80 bg-card/90 text-foreground hover:border-primary/25 hover:bg-accent/25`;
  }
  if (source === "proplane") {
    return `${base} border-[color-mix(in_srgb,var(--status-approved-fg)_35%,transparent)] bg-[var(--status-approved-bg)] text-[var(--status-approved-fg)]`;
  }
  return `${base} border-[color-mix(in_srgb,var(--status-pending-fg)_35%,transparent)] bg-[var(--status-pending-bg)] text-[var(--status-pending-fg)]`;
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
  const source = dominantSourceForDay(dayBookings);

  return (
    <button
      type="button"
      data-attr={`portfolio-booking-day-${key}`}
      className={dayCellClassName(booked, isToday, source)}
      onClick={() => onOpenDay(key)}
    >
      <div className="flex items-start justify-between gap-0.5">
        <span
          className={`text-[11px] font-bold tabular-nums ${isToday ? "text-primary" : ""}`}
        >
          {cell.getDate()}
        </span>
        {booked && source ? (
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              source === "proplane" ? "bg-primary" : "bg-[var(--status-pending-fg)]"
            }`}
            aria-hidden
          />
        ) : null}
      </div>
      {booked && preview ? (
        <div className="mt-1 min-h-0 flex-1 space-y-0.5 overflow-hidden">
          <p className="truncate text-[10px] font-semibold leading-tight">
            {preview.source === "airbnb"
              ? bookingGuestShortLabel(preview.summary, 14)
              : preview.summary}
          </p>
          <p className="truncate text-[9px] opacity-80">
            {preview.roomLabel}
            {dayBookings.length > 1 ? ` +${dayBookings.length - 1}` : ""}
          </p>
        </div>
      ) : null}
    </button>
  );
}

function YearMonthMiniGrid({
  year,
  month,
  entries,
  isCurrentMonth,
  onSelect,
}: {
  year: number;
  month: number;
  entries: PropertyBookingEntry[];
  isCurrentMonth: boolean;
  onSelect: () => void;
}) {
  const monthStart = new Date(year, month, 1);
  const cells = buildMonthDayCells(monthStart);
  const booked = bookedDayKeyCountInMonth(entries, year, month);
  const label = monthStart.toLocaleDateString("en-US", { month: "long" });

  return (
    <button
      type="button"
      data-attr={`bookings-calendar-year-month-${month + 1}`}
      className={`flex min-h-0 flex-col rounded-xl border p-2 text-left transition hover:border-primary/35 hover:shadow-[var(--shadow-sm)] ${
        isCurrentMonth
          ? "border-primary/40 bg-card ring-1 ring-primary/25"
          : "border-border bg-card/90"
      }`}
      onClick={onSelect}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-sm font-semibold text-foreground">{label}</span>
        <span className="text-[10px] font-medium text-muted">{booked}d</span>
      </div>
      <div className="mt-1.5 grid grid-cols-7 gap-px">
        {cells.map((cell, index) => {
          if (!cell) {
            return <span key={`pad-${index}`} className="aspect-square" aria-hidden />;
          }
          const key = dateKey(cell);
          const filled = bookingEntriesForDayKey(entries, key).length > 0;
          const src = dominantSourceForDay(bookingEntriesForDayKey(entries, key));
          return (
            <span
              key={key}
              className={`aspect-square rounded-[2px] ${
                filled
                  ? src === "proplane"
                    ? "bg-primary/70"
                    : "bg-[var(--status-pending-fg)]/55"
                  : "bg-border/40"
              }`}
              aria-hidden
            />
          );
        })}
      </div>
    </button>
  );
}

function DayViewStayCard({ booking }: { booking: PropertyBookingEntry }) {
  const name =
    booking.source === "airbnb" ? bookingGuestLabel(booking.summary) : booking.summary;
  return (
    <li
      className="rounded-xl border border-border bg-card/95 p-3 shadow-[var(--shadow-sm)]"
      data-attr="bookings-day-stay-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-foreground">{name}</p>
          <p className="mt-0.5 text-xs text-muted">
            {[booking.propertyLabel, booking.roomLabel].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1">
          <Badge tone={booking.source === "airbnb" ? "pending" : "info"}>
            {bookingSourceLabel(booking.source)}
          </Badge>
          {booking.statusLabel ? (
            <Badge tone={bookingStatusTone(booking)}>{booking.statusLabel}</Badge>
          ) : null}
        </div>
      </div>
      <p className="mt-2 text-sm text-foreground">
        {formatBookingStayRange(booking.start, booking.end, booking.openEnded)}
      </p>
    </li>
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
  extraEntries?: PropertyBookingEntry[];
  roomFilterId?: string;
  emptyMessage?: string;
  variant?: "embedded" | "standalone";
}) {
  return (
    <ManagerBookingsHub
      propertyIds={propertyIds}
      showToast={showToast}
      refreshSignal={refreshSignal}
      extraEntries={extraEntries}
      roomFilterId={roomFilterId}
      emptyMessage={emptyMessage}
      variant={variant}
    />
  );
}

export function ManagerBookingsHub({
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
  extraEntries?: PropertyBookingEntry[];
  roomFilterId?: string;
  emptyMessage?: string;
  variant?: "embedded" | "standalone";
}) {
  const [airbnbEntries, setAirbnbEntries] = useState<PropertyBookingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [hubMode, setHubMode] = useState<BookingsHubMode>("calendar");
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

  const stats = useMemo(
    () => bookingOccupancyStats(entries, anchorDate, view),
    [entries, anchorDate, view],
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
    setHubMode("calendar");
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
    return (
      <div className="flex min-h-[12rem] items-center justify-center rounded-2xl border border-border bg-card/60">
        <p className="text-sm text-muted">Loading bookings…</p>
      </div>
    );
  }

  const shellClass =
    variant === "standalone"
      ? "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
      : "flex min-h-0 flex-1 flex-col gap-3 overflow-hidden";

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
      <div className={shellClass} data-attr="bookings-hub">
        <PortalSegmentedControl
          options={HUB_OPTIONS}
          value={hubMode}
          onChange={setHubMode}
          ariaLabel="Bookings layout"
        />

        {hubMode === "list" ? (
          <ManagerBookingsListPanel entries={entries} onOpenDay={openDay} />
        ) : (
          <div className={PORTAL_CALENDAR_FRAME}>
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
              <BookingsKpiStrip stats={stats} periodLabel={kpiPeriodLabel(view)} />

              <PortalSegmentedControl
                options={CALENDAR_VIEW_OPTIONS}
                value={view}
                onChange={setView}
                size="sm"
                ariaLabel="Calendar period"
              />

              <div className="flex shrink-0 items-center justify-between gap-2">
                <button
                  type="button"
                  aria-label={prevLabel}
                  data-attr="bookings-calendar-prev"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted shadow-[var(--shadow-sm)] transition hover:border-primary/45 hover:text-foreground"
                  onClick={() => setAnchorDate((current) => shiftAnchor(current, view, -1))}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                </button>
                <div className="min-w-0 flex-1 text-center">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {formatNavTitle(anchorDate, view)}
                  </p>
                  <p className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted">
                    {navSubtitle}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label={nextLabel}
                  data-attr="bookings-calendar-next"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted shadow-[var(--shadow-sm)] transition hover:border-primary/45 hover:text-foreground"
                  onClick={() => setAnchorDate((current) => shiftAnchor(current, view, 1))}
                >
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </button>
              </div>

              {view === "day" ? (
                <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card/80 p-4">
                  {dayViewBookings.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-8 text-center">
                      <CalendarDays className="h-10 w-10 text-muted" aria-hidden />
                      <p className="text-sm font-medium text-foreground">No bookings on this day</p>
                      <p className="max-w-xs text-xs text-muted">
                        Stays from PropLane leases and linked Airbnb calendars appear here when a
                        room is occupied.
                      </p>
                    </div>
                  ) : (
                    <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                      {dayViewBookings.map((booking, index) => (
                        <DayViewStayCard
                          key={`${booking.start}-${booking.roomId}-${index}`}
                          booking={booking}
                        />
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
                        className="py-1 text-center text-[10px] font-bold uppercase tracking-wide text-muted"
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
                        className="py-1 text-center text-[10px] font-bold uppercase tracking-wide text-muted"
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
                <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3 lg:grid-cols-4">
                  {Array.from({ length: 12 }, (_, month) => {
                    const year = anchorDate.getFullYear();
                    const isCurrentMonth =
                      year === today.getFullYear() && month === today.getMonth();
                    return (
                      <YearMonthMiniGrid
                        key={month}
                        year={year}
                        month={month}
                        entries={entries}
                        isCurrentMonth={isCurrentMonth}
                        onSelect={() => goToMonth(year, month)}
                      />
                    );
                  })}
                </div>
              ) : null}

              <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border/60 pt-2 text-[10px] text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-primary" aria-hidden />
                  PropLane stay
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="h-2 w-2 rounded-full bg-[var(--status-pending-fg)]"
                    aria-hidden
                  />
                  Airbnb
                </span>
              </div>
            </div>
          </div>
        )}
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
