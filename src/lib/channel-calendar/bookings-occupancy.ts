/**
 * Occupancy math shared by the Bookings day page and the month/year calendar.
 *
 * This file is a formatter over {@link occupancyForDay}: `occupied` is beds
 * taken, `rooms` is beds total. A function resolver is the legacy contract
 * (beds total only, one bed per room) so existing unit tests stay green.
 * Bookings UI injects {@link OccupancyCapacities} from `bookings-room-counts`.
 */

import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  occupancyForDay,
  type OccupancyCapacities,
  type OccupancyDayCell,
} from "@/lib/occupancy/snapshot";

export type OccupancyDayLookup = {
  overall: Record<string, OccupancyDayCell>;
  houses: Record<string, OccupancyDayCell>;
};

export function dayOccupancyFromLookup(
  lookup: OccupancyDayLookup | undefined,
  dayKey: string,
  propertyIds: readonly string[],
  fallback: () => DayOccupancy,
): DayOccupancy {
  if (!lookup) return fallback();
  if (propertyIds.length === 1) {
    const house = lookup.houses[`${propertyIds[0]}:${dayKey}`];
    if (house) return { occupied: house.occupied, rooms: house.total, checkIns: house.checkIns, checkOuts: house.checkOuts };
  }
  const cell = lookup.overall[dayKey];
  if (!cell) return fallback();
  return { occupied: cell.occupied, rooms: cell.total, checkIns: cell.checkIns, checkOuts: cell.checkOuts };
}

export type DayOccupancy = {
  /** Beds occupied, capped at the property/properties' bed total. */
  occupied: number;
  rooms: number;
  checkIns: number;
  checkOuts: number;
};

export type RoomCountResolver = (propertyId: string) => number;

export type OccupancyResolver = RoomCountResolver | OccupancyCapacities;

function asCapacities(resolver: OccupancyResolver): OccupancyCapacities {
  if (typeof resolver === "function") {
    return { bedsTotal: resolver, roomCapacity: () => 1 };
  }
  return resolver;
}

/** Occupancy across every property in scope for one day — what a day-page header and a month/year cell both read. */
export function dayOccupancy(
  entries: readonly PropertyBookingEntry[],
  dayKey: string,
  propertyIds: readonly string[],
  roomCountForProperty: OccupancyResolver,
): DayOccupancy {
  const cell = occupancyForDay(entries, dayKey, propertyIds, asCapacities(roomCountForProperty));
  return { occupied: cell.occupied, rooms: cell.total, checkIns: cell.checkIns, checkOuts: cell.checkOuts };
}

export function occupancyPercent(stats: Pick<DayOccupancy, "occupied" | "rooms">): number {
  return stats.rooms > 0 ? Math.min(100, Math.round((stats.occupied / stats.rooms) * 100)) : 0;
}

/** Occupied room-nights over total room-nights across an arbitrary set of days — a day, a week, a month, a year, all the same math. */
export function rangeOccupancyPercent(
  entries: readonly PropertyBookingEntry[],
  dayKeys: readonly string[],
  propertyIds: readonly string[],
  roomCountForProperty: OccupancyResolver,
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
  roomCountForProperty: OccupancyResolver,
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
