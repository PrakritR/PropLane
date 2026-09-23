/**
 * One occupancy decision: beds taken vs beds total for a house and a day.
 *
 * Bookings KPI, month cells, the day card, apply first-choice, listing
 * Available, and the export ICS all read this shape. Client math that used
 * `rooms.length` or stay-length sums is a formatter over these numbers.
 *
 * Checkout is exclusive: a stay whose last night is the 5th is gone on the 6th
 * (`lastNightBeforeCheckout`). A "Not available" / "Blocked" iCal summary still
 * occupies a bed; it is never a Current resident.
 */

import { addDaysToDateKey } from "@/lib/channel-calendar/bookings-ui";
import { bookingEntriesForDayKey, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

export type OccupancyDayCell = {
  occupied: number;
  total: number;
  checkIns: number;
  checkOuts: number;
};

export type OccupancyCapacities = {
  bedsTotal: (propertyId: string) => number;
  roomCapacity: (propertyId: string, roomId: string) => number;
};

export type OccupancyStayKind = "lease" | "hold" | "guest" | "block";

export type OccupancyStayInput = {
  id: string;
  propertyId: string;
  roomId: string;
  start: string;
  end: string;
  openEnded?: boolean;
  kind: OccupancyStayKind;
  summary?: string;
};

/** Airbnb / Booking.com availability holds — occupy a bed, never a person. */
export function isIcalAvailabilityBlock(summary: string | null | undefined): boolean {
  const raw = String(summary ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (raw === "not available" || raw === "blocked" || raw === "reserved") return true;
  return raw.includes("not available") || /\bblocked\b/.test(raw);
}

export function occupancyStayKind(entry: Pick<PropertyBookingEntry, "source" | "summary" | "residentName">): OccupancyStayKind {
  if (entry.source === "proplane") return "lease";
  if (entry.source === "hold") return "hold";
  if (entry.source === "block") return entry.residentName?.trim() ? "hold" : "block";
  if (isIcalAvailabilityBlock(entry.summary)) return "block";
  return "guest";
}

function propertyDayOccupiedBeds(
  entries: readonly PropertyBookingEntry[],
  dayKey: string,
  propertyId: string,
  capacities: OccupancyCapacities,
): OccupancyDayCell {
  const propertyEntries = entries.filter((entry) => entry.propertyId === propertyId);
  const dayBookings = bookingEntriesForDayKey(propertyEntries, dayKey);
  const total = Math.max(1, capacities.bedsTotal(propertyId));
  const countable = dayBookings.filter((entry) => {
    if (!isIcalAvailabilityBlock(entry.summary)) return true;
    const roomKey = entry.roomId || "__whole__";
    return !dayBookings.some(
      (other) =>
        other !== entry &&
        (other.roomId || "__whole__") === roomKey &&
        !isIcalAvailabilityBlock(other.summary),
    );
  });
  let wholeHome = false;
  const bedsByRoom = new Map<string, number>();
  let checkIns = 0;
  for (const entry of countable) {
    if (!entry.roomId) {
      wholeHome = true;
    } else {
      bedsByRoom.set(entry.roomId, (bedsByRoom.get(entry.roomId) ?? 0) + 1);
    }
    if (entry.start === dayKey && !isIcalAvailabilityBlock(entry.summary)) checkIns += 1;
  }
  let checkOuts = 0;
  for (const entry of propertyEntries) {
    if (entry.openEnded || isIcalAvailabilityBlock(entry.summary)) continue;
    if (addDaysToDateKey(entry.end, 1) === dayKey) checkOuts += 1;
  }
  if (wholeHome) {
    return { occupied: total, total, checkIns, checkOuts };
  }
  let occupied = 0;
  for (const [roomId, stayCount] of bedsByRoom) {
    const capacity = Math.max(1, capacities.roomCapacity(propertyId, roomId));
    occupied += Math.min(stayCount, capacity);
  }
  return { occupied: Math.min(occupied, total), total, checkIns, checkOuts };
}

/** Beds occupied across the houses in scope for one day. */
export function occupancyForDay(
  entries: readonly PropertyBookingEntry[],
  dayKey: string,
  propertyIds: readonly string[],
  capacities: OccupancyCapacities,
): OccupancyDayCell {
  let occupied = 0;
  let total = 0;
  let checkIns = 0;
  let checkOuts = 0;
  for (const propertyId of propertyIds) {
    const cell = propertyDayOccupiedBeds(entries, dayKey, propertyId, capacities);
    occupied += cell.occupied;
    total += cell.total;
    checkIns += cell.checkIns;
    checkOuts += cell.checkOuts;
  }
  return { occupied, total, checkIns, checkOuts };
}

/** Drop duplicate stay rows from two sources (iCal + imported block) so a 2-bed room is not counted twice. */
export function combineOccupancyEntries(
  ...parts: readonly (readonly PropertyBookingEntry[])[]
): PropertyBookingEntry[] {
  const seen = new Set<string>();
  const out: PropertyBookingEntry[] = [];
  for (const part of parts) {
    for (const entry of part) {
      const key = `${entry.propertyId}\0${entry.roomId}\0${entry.start}\0${entry.end}\0${entry.summary}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
  }
  return out;
}

/** Occupied bed-nights in the visible days — the Bookings "Booked nights" KPI. */
export function bookedBedNights(
  entries: readonly PropertyBookingEntry[],
  dayKeys: readonly string[],
  propertyIds: readonly string[],
  capacities: OccupancyCapacities,
): number {
  return dayKeys.reduce(
    (sum, key) => sum + occupancyForDay(entries, key, propertyIds, capacities).occupied,
    0,
  );
}

export function occupancyPercent(cell: Pick<OccupancyDayCell, "occupied" | "total">): number {
  return cell.total > 0 ? Math.min(100, Math.round((cell.occupied / cell.total) * 100)) : 0;
}

export function rangeOccupancyPercentFromSnapshot(
  entries: readonly PropertyBookingEntry[],
  dayKeys: readonly string[],
  propertyIds: readonly string[],
  capacities: OccupancyCapacities,
): number {
  let occupiedNights = 0;
  let totalNights = 0;
  for (const key of dayKeys) {
    const cell = occupancyForDay(entries, key, propertyIds, capacities);
    occupiedNights += cell.occupied;
    totalNights += cell.total;
  }
  return totalNights > 0 ? Math.round((occupiedNights / totalNights) * 100) : 0;
}

export type OccupancyRoomGroup<T> = {
  roomId: string;
  roomLabel: string;
  stays: T[];
};

function roomSortKey(label: string, roomId: string): { n: number; label: string } {
  const fromLabel = /(?:room\s*)(\d+)/i.exec(label);
  const fromId = /(?:room\s*)?(\d+)/i.exec(roomId);
  const n = fromLabel ? Number(fromLabel[1]) : fromId ? Number(fromId[1]) : Number.MAX_SAFE_INTEGER;
  return { n: Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER, label: label || roomId };
}

/** Same-room stays collapse under one Room N, rooms in number order. */
export function groupStaysByRoom<T extends { roomId: string; roomLabel: string }>(
  stays: readonly T[],
): OccupancyRoomGroup<T>[] {
  const byRoom = new Map<string, OccupancyRoomGroup<T>>();
  for (const stay of stays) {
    const roomId = stay.roomId || "__whole__";
    const existing = byRoom.get(roomId);
    if (existing) existing.stays.push(stay);
    else byRoom.set(roomId, { roomId, roomLabel: stay.roomLabel || (stay.roomId ? stay.roomId : "Whole home"), stays: [stay] });
  }
  return [...byRoom.values()].sort((a, b) => {
    const aa = roomSortKey(a.roomLabel, a.roomId);
    const bb = roomSortKey(b.roomLabel, b.roomId);
    if (aa.n !== bb.n) return aa.n - bb.n;
    return aa.label.localeCompare(bb.label);
  });
}

export function dayStayDisplayName(entry: Pick<PropertyBookingEntry, "source" | "summary" | "residentName">): string {
  if (occupancyStayKind(entry) === "block") return "Blocked";
  const named = entry.residentName?.trim();
  if (named) return named;
  const raw = entry.summary?.trim() ?? "";
  if (!raw) return entry.source === "booking_com" ? "Booked (Booking.com)" : "Booked (Airbnb)";
  return raw;
}

/** Merge contiguous occupied nights so the ICS is one event per run. */
export function mergeContiguousOccupiedNights(
  ranges: readonly { start: string; end: string }[],
): { start: string; end: string }[] {
  const normalized = ranges
    .map((r) => ({ start: r.start.trim(), end: (r.end || r.start).trim() }))
    .filter((r) => r.start && r.end >= r.start)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const out: { start: string; end: string }[] = [];
  for (const range of normalized) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push({ ...range });
      continue;
    }
    const nextOfPrev = addDaysToDateKey(prev.end, 1);
    if (range.start <= nextOfPrev) {
      if (range.end > prev.end) prev.end = range.end;
      continue;
    }
    out.push({ ...range });
  }
  return out;
}

/** PropLane → Airbnb: leases, holds, typed blocks. Never re-export an imported iCal row. */
export function exportBlockedRanges(input: {
  leases?: readonly { start: string; end: string }[];
  holds?: readonly { start: string; end: string }[];
  typedBlocks?: readonly { start: string; end: string }[];
}): { start: string; end: string }[] {
  return mergeContiguousOccupiedNights([
    ...(input.leases ?? []),
    ...(input.holds ?? []),
    ...(input.typedBlocks ?? []),
  ]);
}
