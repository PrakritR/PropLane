"use client";

import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { ManagerBookingsListPanel } from "@/components/portal/bookings-list-panel";
import { BookingsPortfolioTimeline } from "@/components/portal/bookings-portfolio-timeline";
import { PORTAL_CALENDAR_FRAME, PortalSegmentedControl } from "@/components/portal/portal-metrics";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import {
  bookedDayKeyCountInMonth,
  bookingEntriesForDayKey,
  bookingVisualSource,
  filterBookingEntriesByRoom,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import {
  bookingSourceDotClass,
  filterBookingsBySearch,
  formatBookingStayRange,
  type BookingsHubMode,
} from "@/lib/channel-calendar/bookings-ui";
import {
  dayOccupancy,
  dayOccupancyFromLookup,
  monthOccupancyPercent,
  occupancyHeatBucket,
  occupancyHeatBucketClass,
  occupancyPercent,
  OCCUPANCY_HEAT_BUCKETS,
  type OccupancyDayLookup,
} from "@/lib/channel-calendar/bookings-occupancy";
import { bookingOccupancyCapacities } from "@/lib/channel-calendar/bookings-room-counts";
import { managerBookingDayHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
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

function padDateSegment(n: number): string {
  return String(n).padStart(2, "0");
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

/** A signed stay outranks a channel import, which outranks a hold, which outranks a manual block. */
function dominantSourceForDay(
  dayBookings: PropertyBookingEntry[],
): PropertyBookingEntry["source"] | null {
  if (dayBookings.length === 0) return null;
  for (const source of ["proplane", "airbnb", "booking_com", "hold", "block"] as const) {
    if (dayBookings.some((b) => bookingVisualSource(b) === source)) return source;
  }
  return null;
}

const DAY_CELL_BASE =
  "flex min-h-0 flex-1 flex-col items-stretch gap-1 rounded-lg border border-border/80 bg-card/90 p-1.5 text-left text-xs transition hover:border-primary/25 hover:bg-accent/25 hover:shadow-[var(--shadow-sm)]";
const DAY_CELL_SELECTED = "border-primary bg-primary/[0.08] hover:border-primary hover:bg-primary/[0.10]";

/**
 * A cell answers "how full is this day" (PLAN-0920-1058, area 1e) — an
 * occupancy bar, `occupied / rooms`, and check-ins/check-outs, never a name
 * and a "+N": names belong on the day popup, and a 9-room house is not a
 * binary booked/not-booked flag. The small dot is the dominant source, kept
 * for a quick read of what filled the day.
 */
function DayBookingCell({
  cell,
  entries,
  today,
  onOpenDay,
  propertyIds,
  occupancyDays,
  selected,
}: {
  cell: Date;
  entries: PropertyBookingEntry[];
  today: Date;
  onOpenDay: (key: string) => void;
  propertyIds: readonly string[];
  occupancyDays?: OccupancyDayLookup;
  selected?: boolean;
}) {
  const key = dateKey(cell);
  const dayBookings = bookingEntriesForDayKey(entries, key);
  const isToday = key === dateKey(today);
  const source = dominantSourceForDay(dayBookings);
  const stats = dayOccupancyFromLookup(occupancyDays, key, propertyIds, () =>
    dayOccupancy(entries, key, propertyIds, bookingOccupancyCapacities),
  );
  const percent = occupancyPercent(stats);
  const inOut = [
    stats.checkIns > 0 ? `${stats.checkIns} in` : "",
    stats.checkOuts > 0 ? `${stats.checkOuts} out` : "",
  ].filter(Boolean);

  return (
    <button
      type="button"
      data-attr={`portfolio-booking-day-${key}`}
      aria-pressed={selected || undefined}
      className={`${DAY_CELL_BASE} ${selected ? DAY_CELL_SELECTED : ""}`}
      onClick={() => onOpenDay(key)}
    >
      <div className="flex items-start justify-between gap-0.5">
        <span className={`text-[11px] font-bold tabular-nums ${isToday ? "text-primary" : ""}`}>
          {cell.getDate()}
        </span>
        {stats.occupied > 0 && source ? (
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${bookingSourceDotClass(source)}`} aria-hidden />
        ) : null}
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-border/50" aria-hidden>
        <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
      </div>
      {/*
        No bookable rooms that day (an empty workspace, or one with nothing
        bookable) means nothing to count — a "0/0" repeated under every day
        of an empty month reads as broken, not empty (AXI night sweep area
        2j).
      */}
      {stats.rooms > 0 ? (
        <p className="truncate text-[10px] font-semibold tabular-nums leading-tight">
          {stats.occupied}/{stats.rooms}
        </p>
      ) : null}
      {inOut.length > 0 ? <p className="truncate text-[9px] opacity-80">{inOut.join(" · ")}</p> : null}
    </button>
  );
}

/**
 * Year is a heat map of occupancy (PLAN-0920-1058, area 1e) — a percent tile
 * per month, coloured by {@link occupancyHeatBucket}. "Available/Booked" as
 * two colours could not describe a 9-room house, and the old legend called
 * the booked squares available; this reads as one scale with one legend.
 */
function YearMonthMiniGrid({
  year,
  month,
  entries,
  isCurrentMonth,
  onSelect,
  propertyIds,
  occupancyDays,
}: {
  year: number;
  month: number;
  entries: PropertyBookingEntry[];
  isCurrentMonth: boolean;
  onSelect: () => void;
  propertyIds: readonly string[];
  occupancyDays?: OccupancyDayLookup;
}) {
  const monthStart = new Date(year, month, 1);
  const label = monthStart.toLocaleDateString("en-US", { month: "long" });
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const monthKeys = Array.from(
    { length: daysInMonth },
    (_, index) => `${year}-${String(month + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
  );
  const fromSnapshot = occupancyDays
    ? monthKeys.reduce(
        (sum, key) => {
          const cell = dayOccupancyFromLookup(occupancyDays, key, propertyIds, () => ({
            occupied: 0,
            rooms: 0,
            checkIns: 0,
            checkOuts: 0,
          }));
          return { occupied: sum.occupied + cell.occupied, rooms: sum.rooms + cell.rooms };
        },
        { occupied: 0, rooms: 0 },
      )
    : null;
  const percent = fromSnapshot
    ? fromSnapshot.rooms > 0
      ? Math.round((fromSnapshot.occupied / fromSnapshot.rooms) * 100)
      : 0
    : monthOccupancyPercent(entries, year, month, propertyIds, bookingOccupancyCapacities);
  const bucket = occupancyHeatBucket(percent);
  const lightText = bucket === "empty" || bucket === "under-half";

  return (
    <button
      type="button"
      data-attr={`bookings-calendar-year-month-${month + 1}`}
      className={`flex min-h-0 flex-col justify-between gap-2 rounded-xl border p-3 text-left transition hover:shadow-[var(--shadow-sm)] ${occupancyHeatBucketClass(bucket)} ${
        isCurrentMonth ? "ring-1 ring-primary/40" : ""
      }`}
      onClick={onSelect}
    >
      <span className={`text-sm font-semibold ${lightText ? "text-foreground" : "text-white"}`}>{label}</span>
      <span className={`text-xl font-bold tabular-nums ${lightText ? "text-foreground" : "text-white"}`}>
        {percent}%
      </span>
    </button>
  );
}

function DayViewStayCard({ booking }: { booking: PropertyBookingEntry }) {
  const name =
    booking.source === "airbnb" || booking.source === "booking_com"
      ? bookingGuestLabel(booking.summary, booking.source)
      : booking.summary;
  return (
    <li
      className="rounded-xl border border-border bg-card/95 p-3 shadow-[var(--shadow-sm)]"
      data-attr="bookings-day-stay-card"
    >
      <p className="font-semibold text-foreground">{name}</p>
      <p className="mt-0.5 text-xs text-muted">
        {[booking.propertyLabel, booking.roomLabel].filter(Boolean).join(" · ")}
      </p>
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
  occupancyDays,
  entriesLoading = false,
  roomFilterId = "",
  emptyMessage,
  variant = "embedded",
  calendarOnly = false,
  onDayClick,
  selectedDayKey,
  searchQuery = "",
}: {
  propertyIds: string[];
  showToast: (message: string) => void;
  refreshSignal?: number;
  extraEntries?: PropertyBookingEntry[];
  occupancyDays?: OccupancyDayLookup;
  entriesLoading?: boolean;
  roomFilterId?: string;
  emptyMessage?: string;
  variant?: "embedded" | "standalone";
  calendarOnly?: boolean;
  /** Open the day popup. Defaults to `/portal/bookings/<date>` when absent (an embedded, unrouted caller). */
  onDayClick?: (dayKey: string) => void;
  selectedDayKey?: string;
  searchQuery?: string;
}) {
  return (
    <ManagerBookingsHub
      propertyIds={propertyIds}
      showToast={showToast}
      refreshSignal={refreshSignal}
      extraEntries={extraEntries}
      occupancyDays={occupancyDays}
      entriesLoading={entriesLoading}
      roomFilterId={roomFilterId}
      emptyMessage={emptyMessage}
      variant={variant}
      calendarOnly={calendarOnly}
      onDayClick={onDayClick}
      selectedDayKey={selectedDayKey}
      searchQuery={searchQuery}
    />
  );
}

export function ManagerBookingsHub({
  propertyIds,
  showToast,
  extraEntries,
  occupancyDays,
  entriesLoading = false,
  roomFilterId = "",
  emptyMessage,
  variant = "embedded",
  calendarOnly = false,
  onDayClick,
  selectedDayKey,
  searchQuery = "",
}: {
  propertyIds: string[];
  showToast: (message: string) => void;
  refreshSignal?: number;
  extraEntries?: PropertyBookingEntry[];
  occupancyDays?: OccupancyDayLookup;
  entriesLoading?: boolean;
  roomFilterId?: string;
  emptyMessage?: string;
  variant?: "embedded" | "standalone";
  /** When true, skip the List|Calendar hub toggle — calendar grid only (portfolio Calendar tab). */
  calendarOnly?: boolean;
  /** Open the day popup. Defaults to `/portal/bookings/<date>` when absent. */
  onDayClick?: (dayKey: string) => void;
  selectedDayKey?: string;
  searchQuery?: string;
}) {
  const navigate = usePortalNavigate();
  const loading = entriesLoading;
  const [hubMode, setHubMode] = useState<BookingsHubMode>("calendar");
  const [view, setView] = useState<BookingsCalendarView>("month");
  const [anchorDate, setAnchorDate] = useState(() => startOfLocalDay(new Date()));

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

  void showToast;

  const entries = useMemo(
    () =>
      filterBookingsBySearch(
        filterBookingEntriesByRoom(extraEntries ?? [], roomFilterId),
        searchQuery,
      ),
    [extraEntries, roomFilterId, searchQuery],
  );

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

  // The day list is a popup again (PLAN-0922-1013). `onDayClick` is the
  // routed caller's navigate-to-day-href; an unrouted embed still lands on
  // the one real day route — there is no property-scoped day dialog.
  const openDay = (key: string) => (onDayClick ?? ((dayKey: string) => navigate(managerBookingDayHref("/portal", dayKey))))(key);

  const goToMonth = (year: number, month: number) => {
    setAnchorDate(new Date(year, month, 1));
    setView("month");
    if (!calendarOnly) setHubMode("calendar");
  };

  const showListHub = !calendarOnly && hubMode === "list";

  const emptyPortfolio = propertyIds.length === 0;

  if (loading && !emptyPortfolio) {
    return (
      <div className="flex min-h-[12rem] flex-1 items-center justify-center rounded-2xl border border-border bg-card/60">
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
        {!calendarOnly ? (
          <PortalSegmentedControl
            options={HUB_OPTIONS}
            value={hubMode}
            onChange={setHubMode}
            ariaLabel="Bookings layout"
          />
        ) : null}

        {showListHub ? (
          <ManagerBookingsListPanel entries={entries} />
        ) : (
          <div className={PORTAL_CALENDAR_FRAME}>
            <div className="flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-4">
              {emptyPortfolio && !calendarOnly ? (
                <div
                  className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5"
                  data-attr="bookings-empty-houses-banner"
                >
                  <p className="text-sm font-semibold text-foreground">
                    {emptyMessage ?? "No houses yet"}
                  </p>
                  <Link
                    href="/portal/properties"
                    className="inline-flex h-9 shrink-0 items-center rounded-full border border-border bg-card px-3 text-sm font-semibold"
                    data-attr="bookings-empty-add-property"
                  >
                    Add property
                  </Link>
                </div>
              ) : null}

              {calendarOnly ? (
                // All-properties Timeline replaces the Day/Week/Month/Year grid for
                // the portfolio Calendar tab (BUILD-WAVE2 C257). The old grid below
                // stays intact for `calendarOnly === false`, which nothing in the
                // shipped product uses today but a unit test still exercises.
                <BookingsPortfolioTimeline
                  propertyIds={propertyIds}
                  entries={entries}
                  today={today}
                  onOpenDay={openDay}
                  occupancyDays={occupancyDays}
                  emptyMessage={emptyMessage}
                />
              ) : (
                <>
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
                            propertyIds={propertyIds}
                            occupancyDays={occupancyDays}
                            selected={selectedDayKey === dateKey(cell)}
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
                              propertyIds={propertyIds}
                              occupancyDays={occupancyDays}
                              selected={selectedDayKey === dateKey(cell)}
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
                            propertyIds={propertyIds}
                            occupancyDays={occupancyDays}
                          />
                        );
                      })}
                    </div>
                  ) : null}

                  {view === "year" ? (
                    <div
                      className="flex shrink-0 flex-wrap items-center gap-3 border-t border-border/60 pt-2 text-[10px] text-muted"
                      aria-label="Calendar key"
                    >
                      {OCCUPANCY_HEAT_BUCKETS.map((step) => (
                        <span key={step.id} className="inline-flex items-center gap-1.5">
                          <span className={`h-2 w-2 rounded-sm border ${occupancyHeatBucketClass(step.id)}`} aria-hidden />
                          {step.label}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
