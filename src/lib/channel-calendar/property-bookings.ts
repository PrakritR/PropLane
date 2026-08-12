import { dateKeyInBookingRange } from "@/lib/channel-calendar/bookings-dates";
import type { ManagerChannelBookingProperty } from "@/lib/channel-calendar/types";
import { parseRoomChoiceValue } from "@/lib/rental-application/data";
import { normalizeIsoDateInput } from "@/lib/rental-application/lease-dates";

/**
 * What the Bookings calendar draws.
 *
 * The calendar used to show ONLY Airbnb-imported ranges, which made it read as
 * an Airbnb widget rather than the house's occupancy: a room let through
 * PropLane itself appeared free. Both sources now land in one shape so a day
 * cell can answer "is this room taken" regardless of which channel took it.
 */
export type BookingSource = "airbnb" | "proplane";

export type PropertyBookingEntry = {
  source: BookingSource;
  propertyId: string;
  propertyLabel: string;
  /** "" when the stay is the whole home rather than one room. */
  roomId: string;
  roomLabel: string;
  summary: string;
  /** Inclusive YYYY-MM-DD. */
  start: string;
  /** Inclusive YYYY-MM-DD. */
  end: string;
  /** PropLane stays only — where the lease sits in its workflow. */
  statusLabel?: string;
  /** PropLane stays only — the lease has no end date, so `end` is the horizon. */
  openEnded?: boolean;
};

/** How far out an open-ended (month-to-month) stay is drawn. */
export const OPEN_ENDED_BOOKING_HORIZON_DAYS = 365 * 2;

/** The `openEndedHorizonKey` every Bookings surface uses, so they agree. */
export function openEndedBookingHorizonKey(from: Date = new Date()): string {
  const d = new Date(from.getTime());
  d.setDate(d.getDate() + OPEN_ENDED_BOOKING_HORIZON_DAYS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Structural subset of `LeasePipelineRow` this module needs. */
export type LeaseBookingRow = {
  propertyId?: string;
  roomChoice?: string | null;
  residentName?: string;
  stageLabel?: string;
  status?: string;
  application?: { leaseStart?: string; leaseEnd?: string };
};

/**
 * Booking dates are compared as STRINGS (`dateKeyInBookingRange`), so anything
 * that is not already `YYYY-MM-DD` has to be converted before it is stored —
 * `"8/1/2026" >= "2026-08-01"` is false, and the stay would silently vanish
 * from the grid rather than fail.
 *
 * Parsed in LOCAL time on purpose: these are wall-clock calendar dates, and
 * `new Date("2026-08-01")` is UTC midnight, which is the previous day for every
 * negative-offset zone (PropLane's own).
 */
export function normalizeBookingDateKey(value: string | null | undefined): string {
  return normalizeIsoDateInput(value);
}

export function airbnbBookingEntries(
  properties: ManagerChannelBookingProperty[],
): PropertyBookingEntry[] {
  const out: PropertyBookingEntry[] = [];
  for (const property of properties) {
    for (const room of property.rooms) {
      for (const range of room.ranges) {
        const start = normalizeBookingDateKey(range.start);
        if (!start) continue;
        out.push({
          source: "airbnb",
          propertyId: property.propertyId,
          propertyLabel: property.propertyLabel,
          roomId: room.roomId,
          roomLabel: room.roomLabel,
          summary: range.summary,
          start,
          end: normalizeBookingDateKey(range.end) || start,
        });
      }
    }
  }
  return out;
}

/**
 * PropLane's own stays for one house.
 *
 * A voided lease is not a booking. Everything else that has a start date is —
 * including a lease still being signed, because it is holding the room, which
 * is exactly what a manager checking availability needs to see. `statusLabel`
 * carries the stage so a signed stay is still distinguishable from a pending
 * one in the day detail.
 *
 * `openEndedHorizonKey` is what a lease with no end date runs to. Without it an
 * open-ended (month-to-month) stay would collapse to a single booked day.
 */
export function leaseBookingEntries(
  rows: readonly LeaseBookingRow[],
  opts: {
    propertyId: string;
    propertyLabel: string;
    roomLabelForId: (roomId: string) => string;
    openEndedHorizonKey: string;
  },
): PropertyBookingEntry[] {
  const propertyId = opts.propertyId.trim();
  if (!propertyId) return [];
  const out: PropertyBookingEntry[] = [];
  for (const row of rows) {
    if ((row.propertyId ?? "").trim() !== propertyId) continue;
    if (row.status === "Voided") continue;
    // A lease still in the manager's draft tray never sent for signature does not
    // hold the room on the availability calendar — an abandoned open-ended draft
    // would otherwise paint two years of false occupancy.
    if (row.status === "Draft" || row.status === "Manager Review") continue;
    const start = normalizeBookingDateKey(row.application?.leaseStart);
    if (!start) continue;
    const parsedEnd = normalizeBookingDateKey(row.application?.leaseEnd);
    const openEnded = !parsedEnd;
    const end = parsedEnd || opts.openEndedHorizonKey;
    const roomId = parseRoomChoiceValue(row.roomChoice ?? "").listingRoomId ?? "";
    out.push({
      source: "proplane",
      propertyId,
      propertyLabel: opts.propertyLabel,
      roomId,
      roomLabel: roomId ? opts.roomLabelForId(roomId) : "Whole home",
      summary: row.residentName?.trim() || "Resident",
      start,
      // A horizon that has already passed would make the stay a zero-length
      // range; keep at least the start day rather than dropping it.
      end: end >= start ? end : start,
      statusLabel: row.stageLabel?.trim() || row.status?.trim() || undefined,
      ...(openEnded ? { openEnded: true } : {}),
    });
  }
  return out;
}

/**
 * PropLane's own stays across several houses at once — the portfolio-wide
 * Bookings view.
 *
 * It exists so that view cannot quietly drift back to Airbnb-only: showing one
 * channel there reports a room let through PropLane as free, which is the exact
 * question a manager opens the screen to answer.
 */
export function leaseBookingEntriesForProperties(
  rows: readonly LeaseBookingRow[],
  opts: {
    properties: readonly { id: string; label: string }[];
    roomLabelForId?: (propertyId: string, roomId: string) => string;
    openEndedHorizonKey: string;
  },
): PropertyBookingEntry[] {
  const out: PropertyBookingEntry[] = [];
  for (const property of opts.properties) {
    out.push(
      ...leaseBookingEntries(rows, {
        propertyId: property.id,
        propertyLabel: property.label,
        roomLabelForId: (roomId) => opts.roomLabelForId?.(property.id, roomId) ?? "Room",
        openEndedHorizonKey: opts.openEndedHorizonKey,
      }),
    );
  }
  return out;
}

export function bookingEntriesForDayKey(
  entries: readonly PropertyBookingEntry[],
  dayKey: string,
): PropertyBookingEntry[] {
  return entries.filter((entry) => dateKeyInBookingRange(dayKey, entry.start, entry.end));
}

/**
 * `roomId` of `""` (or "all") means every room — an entire-home listing has no
 * room axis to filter on, so the control is not offered there at all.
 * A whole-home PropLane stay always survives the filter: it occupies every
 * room, so hiding it while a room is selected would report that room free.
 */
export function filterBookingEntriesByRoom(
  entries: readonly PropertyBookingEntry[],
  roomId: string,
): PropertyBookingEntry[] {
  const target = roomId.trim();
  if (!target || target === "all") return [...entries];
  return entries.filter((entry) => entry.roomId === target || entry.roomId === "");
}

export function bookedDayKeyCountInMonth(
  entries: readonly PropertyBookingEntry[],
  year: number,
  monthIndex: number,
): number {
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  let count = 0;
  for (let day = 1; day <= daysInMonth; day += 1) {
    const key = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (entries.some((entry) => dateKeyInBookingRange(key, entry.start, entry.end))) count += 1;
  }
  return count;
}
