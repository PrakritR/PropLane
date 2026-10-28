/**
 * One predicate for "when can a renter move into this room": the header count, the browse
 * card, the room rows and the room modal all call it, so they cannot disagree.
 *
 * Input is the anonymous bed spans `/api/public/approved-room-occupancy` already publishes
 * (dates and counts only, never a name), so the answer carries dates only. Pure and client-safe.
 */
import { classifyRoomOpening } from "@/lib/room-availability-style";
import { nextDayKey, occupiedBedsOn, previousDayKey } from "@/lib/room-occupancy-rule";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

export type RoomAvailability =
  /** A bed is free today. */
  | { kind: "now" }
  /** First day a bed is free, YYYY-MM-DD, after today. */
  | { kind: "from"; date: string }
  /** Closed with no end date: no date is invented. */
  | { kind: "unavailable" };

export type RoomAvailabilityRoom = { availability?: string | null; occupancyCapacity?: unknown };

/** The static label the occupancy fold itself writes ("Unavailable until …", "Unavailable (occupied)"): spans replace it. */
const OCCUPANCY_DERIVED_LABEL = /^\s*(?:unavailable\s*(?:until\b|\()|leased until\b)/i;

function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * Pure: the first day on or after `today` with a free bed.
 * A block ending today frees the room tomorrow; a block starting tomorrow leaves it open today;
 * a shared room is open while the beds taken are fewer than its capacity.
 * The room's own static copy still counts: a dated "Available from …" is a floor, and manager
 * copy that closes the room ("Leased", "Waitlist") is respected; the fold's own "Unavailable until …" is replaced by
 * the spans it came from.
 */
export function roomAvailability(
  room: RoomAvailabilityRoom,
  spans: PublicRoomOccupancy["spans"],
  today: string,
): RoomAvailability {
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const staticText = (room.availability ?? "").trim();
  let floor = today;
  if (staticText && !(spans.length > 0 && OCCUPANCY_DERIVED_LABEL.test(staticText))) {
    const opening = classifyRoomOpening(staticText);
    if (opening.kind === "unavailable" || opening.kind === "unknown") return { kind: "unavailable" };
    if (opening.kind === "later") {
      if (!opening.date) return { kind: "unavailable" };
      const dated = localDayKey(opening.date);
      if (dated > floor) floor = dated;
    }
  }
  // Occupancy only frees up the day after a span ends, so those are the only dates worth testing.
  const candidates = [floor];
  for (const span of spans) {
    if (!span.end) continue;
    const free = nextDayKey(span.end);
    if (free > floor) candidates.push(free);
  }
  candidates.sort();
  for (const day of candidates) {
    if (occupiedBedsOn(spans, day) < capacity) return day === today ? { kind: "now" } : { kind: "from", date: day };
  }
  return { kind: "unavailable" };
}

export type RoomUnavailableRange = {
  /** First unavailable day, YYYY-MM-DD (never before today). */
  start: string;
  /** Last unavailable day, or null when the room stays closed with no end. */
  end: string | null;
};

/**
 * The days the room modal's timeline draws red: the SAME decision as `roomAvailability`, laid out
 * as ranges from today. A day is red when the beds taken that day fill the room's capacity
 * (`occupiedBedsOn`), or when it falls before the room's own static opening date; a room the
 * status calls "Not available" is red from today with no end, so the calendar and the status
 * line can never disagree. Pure; spans are the anonymous ones the public occupancy route returns.
 */
export function roomUnavailableRanges(
  room: RoomAvailabilityRoom,
  spans: PublicRoomOccupancy["spans"],
  today: string,
): RoomUnavailableRange[] {
  const status = roomAvailability(room, spans, today);
  if (status.kind === "unavailable") return [{ start: today, end: null }];
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  const ranges: RoomUnavailableRange[] = [];
  // The room's own opening date (a dated "Available from …") is red until the day before it.
  const floor = roomAvailability(room, [], today);
  if (floor.kind === "from") ranges.push({ start: today, end: previousDayKey(floor.date) });
  // Occupancy only changes on a span's first day or the day after its last, so test just those.
  const points = new Set<string>();
  for (const span of spans) {
    points.add(span.start);
    if (span.end) points.add(nextDayKey(span.end));
  }
  const sorted = [...points].sort();
  sorted.forEach((point, index) => {
    if (occupiedBedsOn(spans, point) < capacity) return;
    const nextPoint = sorted[index + 1];
    const end = nextPoint ? previousDayKey(nextPoint) : null;
    if (end !== null && end < today) return;
    ranges.push({ start: point < today ? today : point, end });
  });
  // Merge touching or overlapping pieces so the grid sees clean ranges.
  ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: RoomUnavailableRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && (last.end === null || nextDayKey(last.end) >= range.start)) {
      if (last.end !== null && (range.end === null || range.end > last.end)) last.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/** `months` on from `day`, clamped to the last day of the target month (Aug 31 + 6 is Feb 28, not Mar 3). */
function addMonthsKey(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0, 12)).getUTCDate();
  target.setUTCDate(Math.min(date, lastDay));
  return target.toISOString().slice(0, 10);
}

/** "Oct 15", "Jan 4, 2027" in another year, "Sep 2027" more than six months out. */
export function formatOpeningDate(date: string, today: string): string {
  const at = new Date(`${date}T12:00:00Z`);
  if (date > addMonthsKey(today, 6)) {
    return at.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  const sameYear = date.slice(0, 4) === today.slice(0, 4);
  return at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone: "UTC",
  });
}

/** The line a room row, price card or modal says. */
export function formatRoomAvailability(availability: RoomAvailability, today: string): string {
  if (availability.kind === "now") return "Available now";
  if (availability.kind === "unavailable") return "Not available";
  const label = formatOpeningDate(availability.date, today);
  // A month-and-year label ("Sep 2027") reads without "from".
  return /^[A-Za-z]{3,4} \d{4}$/.test(label) ? `Available ${label}` : `Available from ${label}`;
}

/** A room that frees within this many days is advertised as "Available <date>"; one that frees later reads "Leased until <date>". */
export const PUBLIC_SOON_WINDOW_DAYS = 60;

export type PublicRoomStatus = {
  /** `now` vacant, `soon` free on a date inside the window (or a dated opening), `leased` held past the window, `closed` no end date. */
  kind: "now" | "soon" | "leased" | "closed";
  /** The public wording. The one string every reader (browse card, listing page, feeds, share card, assistant) prints. */
  text: string;
  /** First free day for `soon`; the last held day for `leased`. */
  date?: string;
};

function daysBetweenKeys(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function formatLeasedThrough(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** The wording for a room held today that frees on `freeDay` (D1: Available <date> within 60 days, else Leased until <date>). */
export function freeingRoomStatus(freeDay: string, today: string): PublicRoomStatus {
  if (daysBetweenKeys(today, freeDay) <= PUBLIC_SOON_WINDOW_DAYS) {
    return { kind: "soon", text: `Available ${formatOpeningDate(freeDay, today)}`, date: freeDay };
  }
  const lastHeld = previousDayKey(freeDay);
  return { kind: "leased", text: `Leased until ${formatLeasedThrough(lastHeld)}`, date: lastHeld };
}

/**
 * The one public label for a room, computed from live spans and never from the saved `availability` string:
 * vacant -> "Available now"; a held room freeing inside 60 days -> "Available <date>"; a held room freeing later
 * -> "Leased until <date>"; a room closed with no end -> "Not available". A vacant room whose own opening date
 * (`moveInAvailableDate`) is ahead is not leased: it reads "Available <date>" however far out.
 */
export function publicRoomStatus(
  room: { occupancyCapacity?: unknown; moveInAvailableDate?: string | null },
  spans: PublicRoomOccupancy["spans"],
  today: string,
): PublicRoomStatus {
  const floor = /^\d{4}-\d{2}-\d{2}$/.test(room.moveInAvailableDate ?? "") && (room.moveInAvailableDate as string) > today
    ? `Available from ${formatLeasedThrough(room.moveInAvailableDate as string)}`
    : "";
  const result = roomAvailability({ availability: floor, occupancyCapacity: room.occupancyCapacity }, spans, today);
  return publicStatusFromAvailability(result, spans, room.occupancyCapacity, today);
}

/** `roomAvailability`'s answer in public wording (D1). A dated opening on a room nobody holds today is "Available <date>" however far out. */
export function publicStatusFromAvailability(
  result: RoomAvailability,
  spans: PublicRoomOccupancy["spans"],
  occupancyCapacity: unknown,
  today: string,
): PublicRoomStatus {
  if (result.kind === "now") return { kind: "now", text: "Available now" };
  if (result.kind === "unavailable") return { kind: "closed", text: "Not available" };
  const held = occupiedBedsOn(spans, today) >= normalizeRoomOccupancyCapacity(occupancyCapacity);
  if (!held) return { kind: "soon", text: `Available ${formatOpeningDate(result.date, today)}`, date: result.date };
  return freeingRoomStatus(result.date, today);
}

/** The glyph-fact line: "Next opening Oct 15". */
export function formatNextOpening(date: string, today: string): string {
  return `Next opening ${formatOpeningDate(date, today)}`;
}
