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

import { addDaysToDateKey, bookingSourceLabel } from "@/lib/channel-calendar/bookings-ui";
import { isHostBlockSummary } from "@/lib/channel-calendar/host-block";
import { channelStayCoverKey, resolveChannelLinks } from "@/lib/channel-calendar/channel-link";
import { isShortStayRequestSource } from "@/lib/short-stay/guest-stays";
import { bookingEntriesForDayKey, isChannelBookingSource, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

export type OccupancyDayCell = {
  /** Beds unavailable on the day: a person in them OR closed with nobody in them (the calendar's busy beds). */
  occupied: number;
  total: number;
  checkIns: number;
  checkOuts: number;
  /**
   * Beds with a PERSON in them on the day: a resident or lease, an approved placement, a named PropLane stay,
   * a channel guest. A closed room (host block, manager closure, the listing's own blocked dates) takes a bed
   * out of `occupied` but is nobody's home, so it is not here. The dashboard KPI, the property cards and the
   * owner's "rooms occupied" read this; `occupied - inHouse` is the beds that are closed. Optional only so a
   * cell rebuilt from an older payload still types; the server always sets it.
   */
  inHouse?: number;
};

/** One saved room of a property, in saved order: what the Bookings calendar draws a row for. */
export type OccupancyRoomOption = { id: string; label: string };

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
  /** The feed connection + event UID of the Airbnb / iCal reservation this resident stands in for. */
  icalConnectionId?: string;
  icalSourceUid?: string;
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
    ...(entry.icalConnectionId ? { icalConnectionId: entry.icalConnectionId } : {}),
    ...(entry.icalSourceUid ? { icalSourceUid: entry.icalSourceUid } : {}),
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
      ...(resident.icalConnectionId ? { icalConnectionId: resident.icalConnectionId } : {}),
      ...(resident.icalSourceUid ? { icalSourceUid: resident.icalSourceUid } : {}),
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

/**
 * The calendar draws a reservation ONCE: when the sync filed a resident for an Airbnb / iCal
 * reservation (the resident carries that feed's connection id + event UID), the resident is the
 * row and the channel bar it covers is dropped. A channel stay no resident covers stays, and so
 * does a host block ("Not available"), which never has a resident.
 *
 * Calendar-only on purpose: apply it where the calendar's entry list is built, never to the list
 * the record page, "Open in Airbnb", payouts or the export feed read, which need the channel stay.
 */
export function withoutChannelStaysCoveredByResidents(entries: readonly PropertyBookingEntry[]): PropertyBookingEntry[] {
  const covered = new Set<string>();
  for (const entry of entries) {
    if (entry.source !== "hold" && entry.source !== "proplane") continue;
    if (entry.icalConnectionId && entry.icalSourceUid) covered.add(`${entry.icalConnectionId}\0${entry.icalSourceUid}`);
  }
  // A PropLane stay linked to its Airbnb / Booking.com reservation (typed link, or the HM code / same
  // dates auto-link) is that reservation: its channel copy is dropped too, so one guest is one bed.
  const linked = resolveChannelLinks(entries).covered;
  if (covered.size === 0 && linked.size === 0) return [...entries];
  return entries.filter((entry) => {
    if (!isChannelBookingSource(entry.source) || !entry.connectionId || !entry.sourceUid) return true;
    if (isAvailabilityBlockRow(entry)) return true;
    if (linked.has(channelStayCoverKey(entry))) return false;
    return !covered.has(`${entry.connectionId}\0${entry.sourceUid}`);
  });
}

/**
 * The deduped view of one entry list, remembered per list. A month grid, a year grid and the
 * manager snapshot all ask for the same `entries` once per (day, property) pair - hundreds of
 * full passes over the same immutable array for one answer. Keyed on the array's identity, so a
 * freshly built list is deduped once and a replaced one is never read from here.
 */
const dedupedEntryCache = new WeakMap<object, PropertyBookingEntry[]>();

function dedupedForOccupancy(entries: readonly PropertyBookingEntry[]): readonly PropertyBookingEntry[] {
  const cached = dedupedEntryCache.get(entries);
  if (cached) return cached;
  const deduped = withoutChannelStaysCoveredByResidents(entries);
  dedupedEntryCache.set(entries, deduped);
  return deduped;
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

/**
 * Whether an entry puts a PERSON in a bed (as opposed to closing it). One answer for every reader
 * of "who is here": a lease or approved placement, a PropLane block held for a named guest, and a
 * channel reservation are people; a manager's closed room, a block with nobody attached, a guest's
 * short-stay request still waiting on the host, a channel host block ("Airbnb (Not available)", "Blocked") and the listing's own
 * blocked dates are not.
 *
 * A channel's privacy-stripped "CLOSED - Not available" is deliberately a person: Booking.com and
 * VRBO write real reservations that way, and reading one as a closure would show an occupied room
 * as empty (see `host-block.ts`).
 */
export function isPersonOccupant(
  entry: Pick<PropertyBookingEntry, "source" | "summary" | "residentName" | "blockKind" | "bookingStatus" | "stayDetails">,
): boolean {
  if (entry.source === "proplane" || entry.source === "hold") return true;
  if (entry.source === "block") {
    if (entry.blockKind === "closed" || !entry.residentName?.trim()) return false;
    // A guest's short-stay REQUEST still waiting on the host reserves the room but nobody is in it yet. A booking
    // the manager typed by hand is a stay whatever its status reads (the Add sheet never sets one), so it counts.
    return !(entry.bookingStatus !== "confirmed" && isShortStayRequestSource(entry.stayDetails?.source));
  }
  const raw = String(entry.summary ?? "").trim().toLowerCase();
  if (isHostBlockSummary(raw)) return false;
  return !/\bblocked\b/.test(raw);
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
        !isIcalAvailabilityBlock(other.summary) &&
        // A named stay supersedes an anonymous availability hold, but a closure (nobody in it) never hides a
        // channel reservation, which is a person even when the feed names nobody ("Reserved").
        (isPersonOccupant(other) || !isPersonOccupant(entry)),
    );
  });
  let wholeHome = false;
  let wholeHomePerson = false;
  const bedsByRoom = new Map<string, number>();
  const peopleByRoom = new Map<string, number>();
  let checkIns = 0;
  for (const entry of countable) {
    const person = isPersonOccupant(entry);
    if (!entry.roomId) {
      wholeHome = true;
      if (person) wholeHomePerson = true;
    } else {
      bedsByRoom.set(entry.roomId, (bedsByRoom.get(entry.roomId) ?? 0) + 1);
      if (person) peopleByRoom.set(entry.roomId, (peopleByRoom.get(entry.roomId) ?? 0) + 1);
    }
    if (entry.start === dayKey && !isIcalAvailabilityBlock(entry.summary)) checkIns += 1;
  }
  let checkOuts = 0;
  for (const entry of propertyEntries) {
    if (entry.openEnded || isIcalAvailabilityBlock(entry.summary)) continue;
    if (addDaysToDateKey(entry.end, 1) === dayKey) checkOuts += 1;
  }
  let inHouse = 0;
  for (const [roomId, personCount] of peopleByRoom) {
    const capacity = Math.max(1, capacities.roomCapacity(propertyId, roomId));
    inHouse += Math.min(personCount, capacity);
  }
  if (wholeHome) {
    return { occupied: total, total, checkIns, checkOuts, inHouse: wholeHomePerson ? total : Math.min(inHouse, total) };
  }
  let occupied = 0;
  for (const [roomId, stayCount] of bedsByRoom) {
    const capacity = Math.max(1, capacities.roomCapacity(propertyId, roomId));
    occupied += Math.min(stayCount, capacity);
  }
  return { occupied: Math.min(occupied, total), total, checkIns, checkOuts, inHouse: Math.min(inHouse, total) };
}

/** Beds occupied across the houses in scope for one day. */
export function occupancyForDay(
  entries: readonly PropertyBookingEntry[],
  dayKey: string,
  propertyIds: readonly string[],
  capacities: OccupancyCapacities,
): OccupancyDayCell {
  // One reservation is one bed: a resident filed for an Airbnb stay covers that stay's channel row.
  // Hoisted out of the per-property loop and memoized on the entry list on purpose - the covered set
  // depends only on `entries`, and a year grid asks for every (day, property) pair, which made this
  // an extra full pass and copy on each one.
  const deduped = dedupedForOccupancy(entries);
  let occupied = 0;
  let inHouse = 0;
  let total = 0;
  let checkIns = 0;
  let checkOuts = 0;
  for (const propertyId of propertyIds) {
    const cell = propertyDayOccupiedBeds(deduped, dayKey, propertyId, capacities);
    occupied += cell.occupied;
    inHouse += cell.inHouse ?? 0;
    total += cell.total;
    checkIns += cell.checkIns;
    checkOuts += cell.checkOuts;
  }
  return { occupied, total, checkIns, checkOuts, inHouse };
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

/** The channel a row came from, named by the one source-label resolver ("Other calendar" when an iCal feed gave no label). */
function channelSourceName(entry: Pick<PropertyBookingEntry, "source"> & { channelLabel?: string }): string | undefined {
  if (!isChannelBookingSource(entry.source)) return undefined;
  return bookingSourceLabel(entry.source, entry.channelLabel);
}

/**
 * A day row that is only dates taken off the calendar, with no guest behind it: the manager's own
 * block, or a channel's "Not available". A channel "Reserved" is a real guest stay, so it is not one.
 */
export function isAvailabilityBlockRow(entry: Pick<PropertyBookingEntry, "source" | "summary" | "residentName">): boolean {
  if (isChannelBookingSource(entry.source)) {
    return isIcalAvailabilityBlock(entry.summary) && entry.summary?.trim().toLowerCase() !== "reserved";
  }
  return occupancyStayKind(entry) === "block";
}

/**
 * What a day row calls a stay. A channel's own "Not available" block names its channel
 * ("Airbnb · Not available"), because the manager did not make it and cannot edit it here;
 * only the manager's own block on a room reads "Blocked".
 */
export function dayStayDisplayName(entry: Pick<PropertyBookingEntry, "source" | "summary" | "residentName"> & { channelLabel?: string }): string {
  const channel = channelSourceName(entry);
  if (channel && isIcalAvailabilityBlock(entry.summary)) {
    if (entry.summary?.trim().toLowerCase() === "reserved") {
      return entry.residentName?.trim() || `${channel} · Reserved`;
    }
    return `${channel} · Not available`;
  }
  if (occupancyStayKind(entry) === "block") return "Blocked";
  const named = entry.residentName?.trim();
  if (named) return named;
  const raw = entry.summary?.trim() ?? "";
  if (!raw) return `Booked (${channelSourceName(entry) ?? "Airbnb"})`;
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
