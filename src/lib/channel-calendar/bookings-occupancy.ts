/**
 * Occupancy math shared by the Bookings day page and the month/year calendar
 * (PLAN-0920-1058, area 1e).
 *
 * "How full is this day" is a room-count question, not a booked/not-booked
 * flag — a 9-room house with one stay is not "Booked". Every surface that
 * answers it (the day-page header line, a month cell, a year heat tile, the
 * KPI strip) calls THESE functions so they can never disagree, the exact
 * failure the mobile QA sweep caught ("Tours 0" above six tour blocks).
 *
 * Pure and framework-free on purpose — `roomCountForProperty` is injected so
 * this file has no dependency on the client-only listing/property reads
 * (`bookings-room-counts.ts` supplies the real one), and it can be unit
 * tested in a plain node environment.
 */

import { bookingEntriesForDayKey, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey } from "@/lib/channel-calendar/bookings-ui";

export type DayOccupancy = {
  /** Distinct rooms occupied, capped at the property/properties' total. */
  occupied: number;
  rooms: number;
  checkIns: number;
  checkOuts: number;
};

export type RoomCountResolver = (propertyId: string) => number;

/** One property's occupancy for one day. A whole-home entry (no `roomId`) fills every room. */
function propertyDayOccupancy(
  entries: readonly PropertyBookingEntry[],
  dayKey: string,
  propertyId: string,
  totalRooms: number,
): DayOccupancy {
  const propertyEntries = entries.filter((entry) => entry.propertyId === propertyId);
  const dayBookings = bookingEntriesForDayKey(propertyEntries, dayKey);
  let wholeHome = false;
  const roomIds = new Set<string>();
  let checkIns = 0;
  for (const entry of dayBookings) {
    if (entry.roomId) roomIds.add(entry.roomId);
    else wholeHome = true;
    if (entry.start === dayKey) checkIns += 1;
  }
  // A checkout on `dayKey` is NOT active that day (checkout is exclusive), so
  // it never appears in `dayBookings` — scan every entry for the property
  // instead of just the ones occupying this day.
  let checkOuts = 0;
  for (const entry of propertyEntries) {
    if (!entry.openEnded && addDaysToDateKey(entry.end, 1) === dayKey) checkOuts += 1;
  }
  const occupied = wholeHome ? totalRooms : Math.min(roomIds.size, totalRooms);
  return { occupied, rooms: totalRooms, checkIns, checkOuts };
}

/** Occupancy across every property in scope for one day — what a day-page header and a month/year cell both read. */
export function dayOccupancy(
  entries: readonly PropertyBookingEntry[],
  dayKey: string,
  propertyIds: readonly string[],
  roomCountForProperty: RoomCountResolver,
): DayOccupancy {
  let occupied = 0;
  let rooms = 0;
  let checkIns = 0;
  let checkOuts = 0;
  for (const propertyId of propertyIds) {
    const totalRooms = Math.max(1, roomCountForProperty(propertyId));
    const stats = propertyDayOccupancy(entries, dayKey, propertyId, totalRooms);
    occupied += stats.occupied;
    rooms += stats.rooms;
    checkIns += stats.checkIns;
    checkOuts += stats.checkOuts;
  }
  return { occupied, rooms, checkIns, checkOuts };
}

export function occupancyPercent(stats: Pick<DayOccupancy, "occupied" | "rooms">): number {
  return stats.rooms > 0 ? Math.min(100, Math.round((stats.occupied / stats.rooms) * 100)) : 0;
}

/** Occupied room-nights over total room-nights across an arbitrary set of days — a day, a week, a month, a year, all the same math. */
export function rangeOccupancyPercent(
  entries: readonly PropertyBookingEntry[],
  dayKeys: readonly string[],
  propertyIds: readonly string[],
  roomCountForProperty: RoomCountResolver,
): number {
  let occupiedRoomNights = 0;
  let totalRoomNights = 0;
  for (const key of dayKeys) {
    const stats = dayOccupancy(entries, key, propertyIds, roomCountForProperty);
    occupiedRoomNights += stats.occupied;
    totalRoomNights += stats.rooms;
  }
  return totalRoomNights > 0 ? Math.round((occupiedRoomNights / totalRoomNights) * 100) : 0;
}

/** A month's occupancy: occupied room-nights over total room-nights across every day in it. */
export function monthOccupancyPercent(
  entries: readonly PropertyBookingEntry[],
  year: number,
  monthIndex: number,
  propertyIds: readonly string[],
  roomCountForProperty: RoomCountResolver,
): number {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const dayKeys = Array.from(
    { length: daysInMonth },
    (_, index) => `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
  );
  return rangeOccupancyPercent(entries, dayKeys, propertyIds, roomCountForProperty);
}

/**
 * Four steps, one legend (PLAN-0920-1058) — "Available/Booked" cannot describe
 * a 9-room house, and the old legend called the booked squares available.
 */
export type OccupancyHeatBucket = "empty" | "under-half" | "mostly-full" | "full";

export const OCCUPANCY_HEAT_BUCKETS: readonly { id: OccupancyHeatBucket; label: string }[] = [
  { id: "empty", label: "Empty" },
  { id: "under-half", label: "Under half" },
  { id: "mostly-full", label: "Mostly full" },
  { id: "full", label: "Full" },
];

export function occupancyHeatBucket(percent: number): OccupancyHeatBucket {
  if (percent <= 0) return "empty";
  if (percent < 50) return "under-half";
  if (percent < 100) return "mostly-full";
  return "full";
}

/** Tailwind classes for a heat tile — one scale, reused by the month cell bar and the year tile. */
export function occupancyHeatBucketClass(bucket: OccupancyHeatBucket): string {
  switch (bucket) {
    case "empty":
      return "bg-card border-border/80";
    case "under-half":
      return "bg-primary/20 border-primary/25";
    case "mostly-full":
      return "bg-primary/55 border-primary/60";
    case "full":
      return "bg-primary border-primary";
  }
}
