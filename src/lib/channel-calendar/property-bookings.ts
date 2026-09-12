import { dateKeyInBookingRange } from "@/lib/channel-calendar/bookings-dates";
import type { ManagerChannelBookingProperty } from "@/lib/channel-calendar/types";
import { leaseIsFullyExecuted, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
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
/**
 * `hold` — an approved application with dates but no executed lease yet: the
 * room is spoken for, not let. `block` — a manager's explicit "not available"
 * range with a reason, reversible from the day detail.
 */
export type BookingSource = "airbnb" | "proplane" | "hold" | "block";

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
  /** Blocks only — the stored record id, so the block can be removed. */
  blockId?: string;
  /** Blocks only — why the dates are closed. */
  reason?: string;
};

/** A manager's explicit closed range. `checkOut` is exclusive: the day is free again. */
export type RoomDateBlock = {
  id: string;
  propertyId: string;
  /** "" = every room / the whole home. */
  roomId: string;
  checkIn: string;
  checkOut: string;
  reason: string;
  createdAt: string;
};

/** Exclusive check-out → inclusive last night, so a block joins the same day math as a stay. */
export function lastNightBeforeCheckout(checkOut: string): string {
  const [y, m, d] = checkOut.split("-").map(Number);
  if (!y || !m || !d) return checkOut;
  const night = new Date(y, m - 1, d - 1);
  return `${night.getFullYear()}-${String(night.getMonth() + 1).padStart(2, "0")}-${String(night.getDate()).padStart(2, "0")}`;
}

export function roomBlockEntries(
  blocks: readonly RoomDateBlock[],
  opts: { propertyLabelForId: (propertyId: string) => string; roomLabelForId: (propertyId: string, roomId: string) => string },
): PropertyBookingEntry[] {
  const out: PropertyBookingEntry[] = [];
  for (const block of blocks) {
    const start = normalizeBookingDateKey(block.checkIn);
    const end = normalizeBookingDateKey(lastNightBeforeCheckout(block.checkOut));
    if (!start || !end || end < start) continue;
    out.push({
      source: "block",
      propertyId: block.propertyId,
      propertyLabel: opts.propertyLabelForId(block.propertyId),
      roomId: block.roomId,
      roomLabel: block.roomId ? opts.roomLabelForId(block.propertyId, block.roomId) : "Whole home",
      summary: block.reason.trim() || "Blocked",
      start,
      end,
      statusLabel: "Blocked",
      blockId: block.id,
      reason: block.reason,
    });
  }
  return out;
}

/**
 * Two ranges of nights collide when they share a night. Because `end` is the
 * last NIGHT (check-out is exclusive), a stay ending on the 5th and a stay
 * starting on the 5th do not collide — the room turns over that day.
 */
export function bookingRangesOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Entries a new range would collide with on the same room (or the whole home on either side). */
export function bookingConflictsFor(
  entries: readonly PropertyBookingEntry[],
  candidate: { propertyId: string; roomId: string; start: string; end: string },
): PropertyBookingEntry[] {
  return entries.filter(
    (entry) =>
      entry.propertyId === candidate.propertyId &&
      (!entry.roomId || !candidate.roomId || entry.roomId === candidate.roomId) &&
      // An open-ended stay has no last night: it takes every night from its start.
      (entry.openEnded ? candidate.end >= entry.start : bookingRangesOverlap(entry, candidate)),
  );
}

/**
 * Approved applications that hold a room for dates but have no executed lease
 * yet. Drawn so the calendar never reports a spoken-for room as free; the hold
 * disappears the moment the lease is signed (the lease entry replaces it).
 */
export type ApplicationHoldRow = {
  id: string;
  bucket: string;
  name?: string;
  email?: string;
  propertyId?: string;
  assignedPropertyId?: string;
  assignedRoomChoice?: string;
  application?: { leaseStart?: string; leaseEnd?: string; roomChoice1?: string } | null;
};

export function applicationHoldEntries(
  rows: readonly ApplicationHoldRow[],
  opts: {
    properties: readonly { id: string; label: string; entireHomeListing?: boolean }[];
    roomLabelForId: (propertyId: string, roomId: string) => string;
    /** True when the application already has an executed lease — that is a stay, not a hold. */
    isLeased: (row: ApplicationHoldRow) => boolean;
    openEndedHorizonKey: string;
  },
): PropertyBookingEntry[] {
  const properties = new Map(opts.properties.map((p) => [p.id, p]));
  const out: PropertyBookingEntry[] = [];
  for (const row of rows) {
    if (row.bucket !== "approved") continue;
    if (opts.isLeased(row)) continue;
    const propertyId = (row.assignedPropertyId ?? row.propertyId ?? "").trim();
    const property = properties.get(propertyId);
    if (!property) continue;
    const start = normalizeBookingDateKey(row.application?.leaseStart);
    if (!start) continue;
    const parsedEnd = normalizeBookingDateKey(row.application?.leaseEnd);
    const end = parsedEnd || opts.openEndedHorizonKey;
    const roomId = parseRoomChoiceValue(row.assignedRoomChoice ?? row.application?.roomChoice1 ?? "").listingRoomId ?? "";
    // Same rule as a lease: without a room, only a whole-home listing is held.
    if (!roomId && !property.entireHomeListing) continue;
    out.push({
      source: "hold",
      propertyId,
      propertyLabel: property.label,
      roomId,
      roomLabel: roomId ? opts.roomLabelForId(propertyId, roomId) : "Whole home",
      summary: row.name?.trim() || "Approved applicant",
      start,
      end: end >= start ? end : start,
      statusLabel: "Approved · lease pending",
      ...(parsedEnd ? {} : { openEnded: true }),
    });
  }
  return out;
}

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
  leaseKind?: string;
  bundleGroupKey?: string | null;
  voidedAt?: string | null;
  fullySignedAt?: string | null;
  externallySignedLease?: boolean;
  managerSignature?: { name?: string; signedAtIso?: string } | null;
  residentSignature?: { name?: string; signedAtIso?: string } | null;
  signatureName?: string | null;
  signedAtIso?: string | null;
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
 * A voided lease is not a booking. Only a **fully executed** lease counts — an
 * offer still out for signature does not hold the room on Bookings or the public
 * listing. `statusLabel` still carries the stage for day-detail copy.
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
    /** When false, a lease with no room choice is omitted rather than blocking every room. */
    entireHomeListing?: boolean;
  },
): PropertyBookingEntry[] {
  const propertyId = opts.propertyId.trim();
  if (!propertyId) return [];
  const out: PropertyBookingEntry[] = [];
  for (const row of rows) {
    if (!leaseIsFullyExecuted(row as LeasePipelineRow)) continue;
    if ((row.propertyId ?? "").trim() !== propertyId) continue;
    const start = normalizeBookingDateKey(row.application?.leaseStart);
    if (!start) continue;
    const parsedEnd = normalizeBookingDateKey(row.application?.leaseEnd);
    const openEnded = !parsedEnd;
    const end = parsedEnd || opts.openEndedHorizonKey;
    const roomId = parseRoomChoiceValue(row.roomChoice ?? "").listingRoomId ?? "";
    const bundleOccupancy =
      row.leaseKind === "joint_bundle" || Boolean(row.bundleGroupKey?.trim());
    if (!roomId && !opts.entireHomeListing && !bundleOccupancy) continue;
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
    properties: readonly { id: string; label: string; entireHomeListing?: boolean }[];
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
        entireHomeListing: property.entireHomeListing,
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
