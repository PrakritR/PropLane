/**
 * One predicate for "when can a renter move into this room": the header count, the browse
 * card, the room rows and the room modal all call it, so they cannot disagree.
 *
 * Input is the anonymous bed spans `/api/public/approved-room-occupancy` already publishes
 * (dates and counts only, never a name), so the answer carries dates only. Pure and client-safe.
 */
import { classifyRoomOpening } from "@/lib/room-availability-style";
import { nextDayKey, occupiedBedsOn } from "@/lib/room-occupancy-rule";
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
const OCCUPANCY_DERIVED_LABEL = /^\s*unavailable\s*(?:until\b|\()/i;

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

function addMonthsKey(day: string, months: number): string {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
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

/** The glyph-fact line: "Next opening Oct 15". */
export function formatNextOpening(date: string, today: string): string {
  return `Next opening ${formatOpeningDate(date, today)}`;
}
