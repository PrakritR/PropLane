"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  BookingsDayDetailModal,
  type BookingsDayEntry,
} from "@/components/portal/bookings-day-detail-modal";
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
  addMonths,
  buildMonthDayCells,
  dateKey,
  startOfLocalDay,
} from "@/lib/room-availability-calendar";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function ManagerPortfolioBookingsCalendar({
  propertyIds,
  showToast,
  refreshSignal = 0,
  extraEntries,
  roomFilterId = "",
  emptyMessage,
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
}) {
  const [airbnbEntries, setAirbnbEntries] = useState<PropertyBookingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [monthOffset, setMonthOffset] = useState(0);
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  const today = useMemo(() => startOfLocalDay(new Date()), []);
  const startMonth = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1), [today]);
  const monthStart = useMemo(() => addMonths(startMonth, monthOffset), [startMonth, monthOffset]);
  const monthCells = useMemo(() => buildMonthDayCells(monthStart), [monthStart]);

  // Joined only to give the fetch a stable dependency: a caller re-creating the
  // same array on every render would otherwise refetch on every render.
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

  const bookedDaysThisMonth = useMemo(
    () => bookedDayKeyCountInMonth(entries, monthStart.getFullYear(), monthStart.getMonth()),
    [entries, monthStart],
  );

  const openDay = (key: string) => {
    setSelectedDayKey(key);
    setDayModalOpen(true);
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

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-border bg-card p-3 sm:p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <button
            type="button"
            aria-label="Previous month"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted transition hover:border-primary/45 hover:bg-accent/35 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
            disabled={monthOffset <= 0}
            onClick={() => setMonthOffset((value) => Math.max(value - 1, 0))}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <p className="text-sm font-semibold text-foreground">
              {monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric" })}
            </p>
            <p className="mt-0.5 text-[11px] font-medium text-muted">
              {bookedDaysThisMonth} booked day{bookedDaysThisMonth === 1 ? "" : "s"} this month
            </p>
          </div>
          <button
            type="button"
            aria-label="Next month"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted transition hover:border-primary/45 hover:bg-accent/35 hover:text-foreground"
            onClick={() => setMonthOffset((value) => value + 1)}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="mb-1 grid grid-cols-7 gap-1">
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
              return <div key={`pad-${index}`} className="min-h-[4.5rem]" aria-hidden />;
            }
            const key = dateKey(cell);
            const dayBookings = bookingEntriesForDayKey(entries, key);
            const booked = dayBookings.length > 0;
            const isToday = key === dateKey(today);
            const preview = dayBookings[0];
            return (
              <button
                key={key}
                type="button"
                data-attr={`portfolio-booking-day-${key}`}
                className={`flex min-h-[4.5rem] flex-col items-stretch rounded-md border p-1.5 text-left text-xs transition sm:min-h-[5.25rem] ${
                  booked
                    ? "border-amber-300 bg-amber-50 text-amber-950 hover:border-amber-400 [html[data-theme=dark]_&]:border-amber-700 [html[data-theme=dark]_&]:bg-amber-950/40 [html[data-theme=dark]_&]:text-amber-100"
                    : "border-border bg-card text-foreground hover:border-primary/30 hover:bg-accent/30"
                } ${isToday ? "ring-1 ring-primary/40" : ""}`}
                onClick={() => openDay(key)}
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
          })}
        </div>
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
