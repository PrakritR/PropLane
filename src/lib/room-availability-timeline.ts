/**
 * Room availability as a timeline of OCCUPIED spans.
 *
 * A room is available by default. Anything that closes it — the manager's own
 * "occupied dates" (`manualUnavailableRanges`), a resident's stay, a Bookings
 * block, an Airbnb import — is a span with a start and an optional end. What a
 * renter is told ("Available now", "Available from November 1, 2026",
 * "Unavailable (occupied)") is DERIVED from those spans here and nowhere else,
 * so the wizard, the listing side panel and the public card cannot disagree.
 *
 * Pure and client-safe: date keys in, strings out. No storage, no network.
 */

import { CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX } from "@/lib/channel-calendar/types";
import type { ManagerRoomUnavailableRange } from "@/lib/manager-listing-submission";

export type OccupiedSpanSource = "manual" | "resident" | "block" | "channel";

export type OccupiedSpan = {
  id: string;
  /** Inclusive YYYY-MM-DD. */
  start: string;
  /** Inclusive YYYY-MM-DD, or null when the span has no end. */
  end: string | null;
  source: OccupiedSpanSource;
  /** Who or what closed the room, for a booked span ("Lease · Maya Zuneh", "Blocked", "Airbnb"). */
  label?: string;
};

export type RoomAvailabilityReadout = {
  /** True when a span covers `today`. */
  occupiedNow: boolean;
  /** The one-line label renters see; also what the room's `availability` field stores. */
  label: string;
  /** Next day the room is free (YYYY-MM-DD), or "" when it is free today. Stored as `moveInAvailableDate`. */
  availableFrom: string;
  /** The span that closes the room today, if any. */
  current: OccupiedSpan | null;
};

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const FAR_FUTURE = "9999-12-31";

export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && DATE_KEY.test(value);
}

export function dateKeyFromDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Today's local calendar day as YYYY-MM-DD. */
export function todayDateKey(now: Date = new Date()): string {
  return dateKeyFromDate(now);
}

export function shiftDateKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  return dateKeyFromDate(new Date(y, m - 1, d + days));
}

export function formatDateKeyLong(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

export function formatDateKeyShort(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** An Airbnb-imported range is read-only in the wizard; the calendar sync owns it. */
export function isChannelImportedRangeId(id: string): boolean {
  return id.startsWith(`${CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX}-`);
}

export function spanCovers(span: Pick<OccupiedSpan, "start" | "end">, dayKey: string): boolean {
  return isDateKey(span.start) && span.start <= dayKey && (span.end === null || span.end === "" || dayKey <= span.end);
}

/** An End before its Start is the one thing the manager can get wrong on a row. */
export function spanEndsBeforeStart(span: Pick<OccupiedSpan, "start" | "end">): boolean {
  return Boolean(span.end) && isDateKey(span.start) && isDateKey(span.end) && span.end < span.start;
}

/** Two inclusive spans share at least one day. Open ends run to the horizon. */
export function spansOverlap(a: Pick<OccupiedSpan, "start" | "end">, b: Pick<OccupiedSpan, "start" | "end">): boolean {
  return a.start <= (b.end ?? FAR_FUTURE) && b.start <= (a.end ?? FAR_FUTURE);
}

/** The room's own stored ranges as spans: the manager's rows plus read-only Airbnb imports. */
export function manualRangesToSpans(ranges: readonly ManagerRoomUnavailableRange[] | undefined): OccupiedSpan[] {
  return (ranges ?? [])
    .filter((r) => isDateKey(r.start))
    .map((r) => ({
      id: r.id,
      start: r.start,
      end: isDateKey(r.end) ? r.end : null,
      source: isChannelImportedRangeId(r.id) ? ("channel" as const) : ("manual" as const),
      ...(isChannelImportedRangeId(r.id) ? { label: "Airbnb" } : {}),
    }));
}

/**
 * A room saved before occupied dates existed carries only a future
 * `moveInAvailableDate`. Read it as "occupied from today until the day before",
 * so the old answer keeps its meaning without rewriting the stored room.
 */
export function legacyMoveInDateAsSpan(moveInAvailableDate: string | undefined, today: string): OccupiedSpan | null {
  const date = (moveInAvailableDate ?? "").trim();
  if (!isDateKey(date) || date <= today) return null;
  return { id: "legacy-available-from", start: today, end: shiftDateKey(date, -1), source: "manual" };
}

/**
 * Which span closes the room on `dayKey`: a booked span before a typed one, then
 * the one that runs longest, so an open-ended stay is never hidden by a short block.
 */
export function spanOccupying(spans: readonly OccupiedSpan[], dayKey: string): OccupiedSpan | null {
  const covering = spans.filter((s) => spanCovers(s, dayKey) && !spanEndsBeforeStart(s));
  if (covering.length === 0) return null;
  const byEnd = (a: OccupiedSpan, b: OccupiedSpan) => (b.end ?? FAR_FUTURE).localeCompare(a.end ?? FAR_FUTURE);
  const booked = covering.filter((s) => s.source !== "manual").sort(byEnd);
  return booked[0] ?? covering.sort(byEnd)[0] ?? null;
}

/**
 * The one derivation: from spans and a day, what the room reads as.
 *
 * - covered today, no end      → "Unavailable (occupied)", availableFrom ""
 * - covered today, ends E      → "Available from <E+1>", availableFrom E+1
 *   (if another span starts on E+1 the chain continues to its end)
 * - free today, next span at S → "Available now until <S-1>"
 * - free today, nothing ahead  → "Available now"
 */
export function deriveRoomAvailability(spans: readonly OccupiedSpan[], today: string): RoomAvailabilityReadout {
  const valid = spans.filter((s) => isDateKey(s.start) && !spanEndsBeforeStart(s));
  let current = spanOccupying(valid, today);
  if (current) {
    // Walk consecutive spans so "occupied until Oct 31" followed by "occupied Nov 1 → Nov 30" reads as free on Dec 1.
    let freeOn = current.end ? shiftDateKey(current.end, 1) : null;
    let guard = 0;
    while (freeOn && guard++ < 64) {
      const next = spanOccupying(valid, freeOn);
      if (!next) break;
      current = next;
      freeOn = next.end ? shiftDateKey(next.end, 1) : null;
    }
    if (!freeOn) return { occupiedNow: true, label: "Unavailable (occupied)", availableFrom: "", current };
    return { occupiedNow: true, label: `Available from ${formatDateKeyLong(freeOn)}`, availableFrom: freeOn, current };
  }
  const upcoming = valid.filter((s) => s.start > today).sort((a, b) => a.start.localeCompare(b.start))[0];
  if (upcoming) {
    return { occupiedNow: false, label: `Available now until ${formatDateKeyLong(shiftDateKey(upcoming.start, -1))}`, availableFrom: "", current: null };
  }
  return { occupiedNow: false, label: "Available now", availableFrom: "", current: null };
}

/**
 * The fields a room stores when its occupied dates change. `availability` and
 * `moveInAvailableDate` stay written so every existing reader — the public card,
 * SMS answers, the side panel — keeps working without learning about spans.
 */
export function roomAvailabilityPatch(
  ranges: readonly ManagerRoomUnavailableRange[],
  bookedSpans: readonly OccupiedSpan[],
  today: string,
): { manualUnavailableRanges: ManagerRoomUnavailableRange[]; availability: string; moveInAvailableDate: string } {
  const readout = deriveRoomAvailability([...manualRangesToSpans(ranges), ...bookedSpans], today);
  return {
    manualUnavailableRanges: [...ranges],
    availability: readout.label,
    moveInAvailableDate: readout.availableFrom,
  };
}

let seq = 0;
export function newOccupiedRangeId(): string {
  seq += 1;
  return `unavail-${Date.now().toString(36)}-${seq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
