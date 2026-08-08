"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  BookingsDayDetailModal,
  type BookingsDayEntry,
} from "@/components/portal/bookings-day-detail-modal";
import { fetchManagerChannelBookings } from "@/lib/channel-calendar/client";
import { bookingGuestShortLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { ManagerChannelBookingProperty } from "@/lib/channel-calendar/types";
import {
  addMonths,
  buildMonthDayCells,
  dateKey,
  startOfLocalDay,
} from "@/lib/room-availability-calendar";
import { dateKeyInBookingRange } from "@/lib/channel-calendar/bookings-dates";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function bookingsForDay(properties: ManagerChannelBookingProperty[], day: Date): BookingsDayEntry[] {
  const key = dateKey(day);
  const out: BookingsDayEntry[] = [];
  for (const property of properties) {
    for (const room of property.rooms) {
      for (const range of room.ranges) {
        if (!dateKeyInBookingRange(key, range.start, range.end)) continue;
        out.push({
          propertyId: property.propertyId,
          propertyLabel: property.propertyLabel,
          roomId: room.roomId,
          roomLabel: room.roomLabel,
          summary: range.summary,
          start: range.start,
          end: range.end,
        });
      }
    }
  }
  return out;
}

function bookedDayCountInMonth(
  properties: ManagerChannelBookingProperty[],
  monthStart: Date,
): number {
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  let count = 0;
  for (let d = 1; d <= monthEnd.getDate(); d += 1) {
    const day = new Date(monthStart.getFullYear(), monthStart.getMonth(), d);
    if (bookingsForDay(properties, day).length > 0) count += 1;
  }
  return count;
}

export function ManagerPortfolioBookingsCalendar({
  propertyIds,
  showToast,
  refreshSignal = 0,
}: {
  propertyIds: string[];
  showToast: (message: string) => void;
  refreshSignal?: number;
}) {
  const [properties, setProperties] = useState<ManagerChannelBookingProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [monthOffset, setMonthOffset] = useState(0);
  const [dayModalOpen, setDayModalOpen] = useState(false);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(null);

  const today = useMemo(() => startOfLocalDay(new Date()), []);
  const startMonth = useMemo(() => new Date(today.getFullYear(), today.getMonth(), 1), [today]);
  const monthStart = useMemo(() => addMonths(startMonth, monthOffset), [startMonth, monthOffset]);
  const monthCells = useMemo(() => buildMonthDayCells(monthStart), [monthStart]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await fetchManagerChannelBookings(propertyIds);
      setProperties(rows);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not load bookings.");
      setProperties([]);
    } finally {
      setLoading(false);
    }
  }, [propertyIds, showToast]);

  useEffect(() => {
    void reload();
  }, [reload, refreshSignal]);

  const selectedDayBookings = useMemo(() => {
    if (!selectedDayKey) return [];
    const [y, m, d] = selectedDayKey.split("-").map(Number);
    if (!y || !m || !d) return [];
    return bookingsForDay(properties, new Date(y, m - 1, d));
  }, [properties, selectedDayKey]);

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
    () => bookedDayCountInMonth(properties, monthStart),
    [properties, monthStart],
  );

  const openDay = (key: string) => {
    setSelectedDayKey(key);
    setDayModalOpen(true);
  };

  if (propertyIds.length === 0) {
    return (
      <p className="text-sm text-muted">
        No houses in your portfolio yet. List a property, then link rooms with Link Airbnb.
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
            const dayBookings = bookingsForDay(properties, cell);
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
                      {bookingGuestShortLabel(preview?.summary, 14)}
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
