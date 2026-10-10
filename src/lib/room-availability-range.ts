/**
 * "Is this room free from A to B?" - the pure half. Nights are the unit: a stay
 * from `moveIn` to `moveOut` (exclusive) occupies the nights `moveIn .. moveOut - 1`.
 * Input is the anonymous capacity spans `loadPublicRoomOccupancy` already returns, so this
 * file can never see a resident, a guest or a reservation, and its output carries dates only.
 */
import { z } from "zod";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

/** Open-ended asks look this far ahead. */
export const ROOM_AVAILABILITY_OPEN_ENDED_DAYS = 365;
/** Longest stay the tool will evaluate. */
export const ROOM_AVAILABILITY_MAX_STAY_DAYS = 1095;

const DAY_MS = 86_400_000;

/** Accepts YYYY-MM-DD or M/D/YYYY; returns a real YYYY-MM-DD or null. */
export function normalizeRangeDay(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  const normalized = slash ? `${slash[3]}-${slash[1].padStart(2, "0")}-${slash[2].padStart(2, "0")}` : value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const date = new Date(`${normalized}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === normalized ? normalized : null;
}

export function addRangeDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function rangeDaysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
}

/** Today in PropLane's zone (Pacific) as YYYY-MM-DD. */
export function pacificTodayKey(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export type RoomRangeVerdict = {
  available: boolean;
  /** First stretch of blocked nights inside the asked range (dates only; `end` is the last blocked night). */
  firstConflict?: { start: string; end: string | null };
  /** Open-ended asks only: the first night after `moveIn` that is not free, when `moveIn` itself is free. */
  freeUntil?: string;
  /** Earliest date >= moveIn from which the room is free for the whole requested length (only when not available). */
  nextAvailableFrom?: string;
};

export type RoomRangeInput = {
  spans: PublicRoomOccupancy["spans"];
  /** The room's published resident capacity (raw listing value). */
  capacity: unknown;
  /** The room's own "not available before" date (moveInAvailableDate). */
  availableFrom?: string | null;
  moveIn: string;
  /** Exclusive. Absent = open-ended (checked 12 months ahead). */
  moveOut?: string | null;
};

/** Pure: one room, one range. Throws nothing; callers validate the dates. */
export function evaluateRoomRange(input: RoomRangeInput): RoomRangeVerdict {
  const { moveIn } = input;
  const openEnded = !input.moveOut;
  const length = openEnded
    ? ROOM_AVAILABILITY_OPEN_ENDED_DAYS
    : Math.max(1, rangeDaysBetween(moveIn, input.moveOut as string));
  const capacity = normalizeRoomOccupancyCapacity(input.capacity);
  const availableFrom = normalizeRangeDay(input.availableFrom);
  // Look past the asked range far enough to find the next window and the end of a conflict.
  const horizon = length + ROOM_AVAILABILITY_OPEN_ENDED_DAYS + 1;
  const blocked: boolean[] = new Array(horizon).fill(false);
  for (let i = 0; i < horizon; i += 1) {
    const day = addRangeDays(moveIn, i);
    if (availableFrom && day < availableFrom) { blocked[i] = true; continue; }
    let count = 0;
    for (const span of input.spans) {
      if (span.start <= day && (!span.end || day <= span.end)) count += span.count;
    }
    blocked[i] = count >= capacity;
  }
  const firstBlocked = blocked.slice(0, length).indexOf(true);
  if (firstBlocked < 0) {
    if (!openEnded) return { available: true };
    const later = blocked.indexOf(true);
    return { available: true, ...(later >= 0 ? { freeUntil: addRangeDays(moveIn, later) } : {}) };
  }
  let runEnd = firstBlocked;
  while (runEnd + 1 < horizon && blocked[runEnd + 1]) runEnd += 1;
  const verdict: RoomRangeVerdict = {
    available: false,
    firstConflict: {
      start: addRangeDays(moveIn, firstBlocked),
      end: runEnd + 1 >= horizon ? null : addRangeDays(moveIn, runEnd),
    },
  };
  if (!blocked[0] && openEnded) verdict.freeUntil = addRangeDays(moveIn, firstBlocked);
  const prefix = [0];
  for (const b of blocked) prefix.push(prefix[prefix.length - 1]! + (b ? 1 : 0));
  for (let start = 0; start <= ROOM_AVAILABILITY_OPEN_ENDED_DAYS && start + length <= horizon; start += 1) {
    if (prefix[start + length]! - prefix[start]! === 0) {
      verdict.nextAvailableFrom = addRangeDays(moveIn, start);
      break;
    }
  }
  return verdict;
}

function formatLong(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

/**
 * Respect the room's own move-in date in the "right now" label: a room whose
 * `moveInAvailableDate` is still ahead is not "Available now". The occupancy
 * label is kept when it already says the room is unavailable.
 */
export function applyMoveInDateToLabel(label: string, availableFrom: unknown, today: string): string {
  const from = normalizeRangeDay(availableFrom);
  if (!from || from <= today) return label;
  if (label === "Available now") return `Available from ${formatLong(from)}`;
  if (label.startsWith("Available now until ")) {
    const until = new Date(label.slice("Available now until ".length));
    const untilDay = Number.isFinite(until.getTime())
      ? `${until.getFullYear()}-${String(until.getMonth() + 1).padStart(2, "0")}-${String(until.getDate()).padStart(2, "0")}`
      : null;
    return untilDay && from <= untilDay
      ? `Available from ${formatLong(from)}${label.slice("Available now".length)}`
      : `Available from ${formatLong(from)}`;
  }
  return label;
}

/** Input and wording for `check_room_availability`, shared by the prospect, resident-SMS and manager variants. */
export const checkRoomAvailabilityInputSchema = z
  .object({
    listingId: z.string().min(1).describe("Listing / property id from list_live_listings (or list_properties for a manager)."),
    roomId: z.string().min(1).optional().describe("Room id from the listing. Omit to check every room."),
    moveIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("First night, YYYY-MM-DD."),
    moveOut: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Move-out date, YYYY-MM-DD, exclusive (the first night NOT stayed). Omit for an open-ended stay, checked 12 months ahead."),
  })
  .strict();

export const CHECK_ROOM_AVAILABILITY_DESCRIPTION =
  "Is this room free for these dates? Checks the real booking calendar (leases, residents, manager blocks, Airbnb / Booking.com bookings, the room's own earliest move-in date and its resident capacity) for the nights from moveIn up to, not including, moveOut, and returns per room: available (true, false, or null when it could not be verified), firstConflict dates, freeUntil (open-ended asks), nextAvailableFrom, and rentLabel. Dates only: it never names who is staying. Quote only its result; null means it could not be verified, so say so instead of guessing.";

