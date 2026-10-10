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
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
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

/**
 * What a resident-backed stay (an approved application's hold, an executed lease) carries so
 * Bookings can draw its row and open its record from the occupancy snapshot alone, without
 * waiting on the applications or lease-pipeline reads. Financial fields are already redacted
 * server-side for a viewer without Residents access.
 */
export type OccupancyStayResident = {
  source: "hold" | "proplane";
  applicationId?: string;
  leaseId?: string;
  residentName?: string;
  residentEmail?: string;
  residentPhone?: string;
  monthlyRent?: number;
  securityDeposit?: number;
  leaseTerm?: string;
  statusLabel?: string;
  openEnded?: boolean;
};

/** The resident facts of a booking entry, for the snapshot's stay payload. Undefined for non-resident stays. */
export function occupancyStayResident(entry: PropertyBookingEntry): OccupancyStayResident | undefined {
  if (entry.source !== "hold" && entry.source !== "proplane") return undefined;
  return {
    source: entry.source,
    ...(entry.applicationId ? { applicationId: entry.applicationId } : {}),
    ...(entry.leaseId ? { leaseId: entry.leaseId } : {}),
    ...(entry.residentName ? { residentName: entry.residentName } : {}),
    ...(entry.residentEmail ? { residentEmail: entry.residentEmail } : {}),
    ...(entry.residentPhone ? { residentPhone: entry.residentPhone } : {}),
    ...(typeof entry.monthlyRent === "number" ? { monthlyRent: entry.monthlyRent } : {}),
    ...(typeof entry.securityDeposit === "number" ? { securityDeposit: entry.securityDeposit } : {}),
    ...(entry.leaseTerm ? { leaseTerm: entry.leaseTerm } : {}),
    ...(entry.statusLabel ? { statusLabel: entry.statusLabel } : {}),
    ...(entry.openEnded ? { openEnded: true } : {}),
  };
}

/**
 * The resident facts a viewer without Residents access may see: who, where, when and the status
 * label. The contact email and the record ids (application / lease) open the resident's records,
 * so they stay with the owner and with a teammate who holds Residents view on the house.
 */
export function occupancyStayResidentWithoutIdentifiers(
  resident: OccupancyStayResident | undefined,
): OccupancyStayResident | undefined {
  if (!resident) return resident;
  const rest: OccupancyStayResident = { ...resident };
  delete rest.applicationId;
  delete rest.leaseId;
  delete rest.residentEmail;
  return rest;
}

type SnapshotStayLike = {
  propertyId?: unknown;
  roomId?: unknown;
  roomLabel?: unknown;
  start?: unknown;
  end?: unknown;
  name?: unknown;
  resident?: OccupancyStayResident;
};

/** Resident booking entries (holds + executed leases) rebuilt from the snapshot's stays. */
export function residentEntriesFromStays(
  stays: readonly unknown[] | undefined,
  propertyLabelForId: (propertyId: string) => string,
): PropertyBookingEntry[] {
  const out: PropertyBookingEntry[] = [];
  for (const raw of stays ?? []) {
    const stay = raw as SnapshotStayLike;
    const resident = stay?.resident;
    if (!resident || (resident.source !== "hold" && resident.source !== "proplane")) continue;
    const propertyId = String(stay.propertyId ?? "").trim();
    const start = String(stay.start ?? "").trim();
    const end = String(stay.end ?? "").trim();
    if (!propertyId || !start || !end) continue;
    out.push({
      source: resident.source,
      propertyId,
      propertyLabel: propertyLabelForId(propertyId),
      roomId: String(stay.roomId ?? ""),
      roomLabel: String(stay.roomLabel ?? ""),
      summary: String(stay.name ?? "") || resident.residentName || "Resident",
      start,
      end,
      ...(resident.applicationId ? { applicationId: resident.applicationId } : {}),
      ...(resident.leaseId ? { leaseId: resident.leaseId } : {}),
      ...(resident.residentName ? { residentName: resident.residentName } : {}),
      ...(resident.residentEmail ? { residentEmail: resident.residentEmail } : {}),
      ...(resident.residentPhone ? { residentPhone: resident.residentPhone } : {}),
      ...(typeof resident.monthlyRent === "number" ? { monthlyRent: resident.monthlyRent } : {}),
      ...(typeof resident.securityDeposit === "number" ? { securityDeposit: resident.securityDeposit } : {}),
      ...(resident.leaseTerm ? { leaseTerm: resident.leaseTerm } : {}),
      ...(resident.statusLabel ? { statusLabel: resident.statusLabel } : {}),
      ...(resident.openEnded ? { openEnded: true } : {}),
    });
  }
  return out;
}

/** The identity two copies of one resident stay share: source + applicationId (hold) or leaseId (lease). */
export function residentEntryKey(entry: Pick<PropertyBookingEntry, "source" | "applicationId" | "leaseId">): string | null {
  const id = entry.source === "proplane" ? entry.leaseId || entry.applicationId : entry.applicationId;
  return id ? `${entry.source}\0${id}` : null;
}

/**
 * Occupancy-sourced resident entries are the base; entries built from the (slower) applications /
 * leases reads only enrich or override the same stay, and anything they carry that the base lacks is added.
 * Never two rows for one stay.
 */
export function mergeResidentEntries(
  primary: readonly PropertyBookingEntry[],
  enrichment: readonly PropertyBookingEntry[],
): PropertyBookingEntry[] {
  const out: PropertyBookingEntry[] = [];
  const index = new Map<string, number>();
  // A stay the snapshot sent without record ids (viewer lacks Residents access) has no key; the
  // same stay arriving from the applications / leases reads is matched by where and when instead.
  const shapeKey = (entry: PropertyBookingEntry) =>
    `${entry.source}\0${entry.propertyId}\0${entry.roomId}\0${entry.start}\0${entry.end}`;
  const keylessIndex = new Map<string, number>();
  const push = (entry: PropertyBookingEntry) => {
    const key = residentEntryKey(entry);
    let at = key ? index.get(key) : undefined;
    if (key && at === undefined) {
      const keyless = keylessIndex.get(shapeKey(entry));
      if (keyless !== undefined) {
        at = keyless;
        keylessIndex.delete(shapeKey(entry));
      }
    }
    if (key && at !== undefined) {
      out[at] = { ...out[at], ...entry };
      index.set(key, at);
      return;
    }
    if (key) index.set(key, out.length);
    else if (!keylessIndex.has(shapeKey(entry))) keylessIndex.set(shapeKey(entry), out.length);
    out.push(entry);
  };
  primary.forEach(push);
  enrichment.forEach(push);
  return out;
}

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

/**
 * Airbnb / Booking.com availability holds — occupy a bed, never a person.
 *
 * Every host block (`isHostBlockSummary`) is one of these, so the two predicates can never
 * disagree about a summary; this one is deliberately WIDER — "Reserved" and a privacy-stripped
 * "CLOSED - Not available" are real bookings that take a bed but name nobody.
 */
export function isIcalAvailabilityBlock(summary: string | null | undefined): boolean {
  const raw = String(summary ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (isHostBlockSummary(raw)) return true;
  if (raw === "reserved") return true;
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
  const propertyEntries = entries.filter((entry) => entry.propertyId === propertyId && entry.bookingStatus !== "cancelled");
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
  if (!raw) return entry.source === "booking_com" ? "Booked (Booking.com)" : entry.source === "vrbo" ? "Booked (Vrbo)" : "Booked (Airbnb)";
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

/** PropLane export: leases, holds, manual blocks, and imported channel stays. */
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
