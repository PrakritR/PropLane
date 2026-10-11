/**
 * The one rule for "is this room occupied on day D", as anonymous bed spans.
 *
 * A room-day is occupied when a resident stay (approved application, hand-added or signed), a
 * channel reservation, a manager block or the listing's own blocked dates covers it, up to the
 * room's bed capacity. Checkout days are exclusive; every `end` here is the LAST occupied day.
 *
 * One exception, shared with the manager snapshot (`propertyDayOccupiedBeds`): a channel
 * "Not available" / host block that sits on a day another occupant already holds the room is
 * PropLane's own export echoing back, not a second occupant (`echoable`). A standalone one still
 * closes the room. Every reader of occupancy — the public picker, the apply wizard, the bots and
 * the manager's room rows — folds its spans through `occupiedBedSpans`, so none can drift.
 *
 * Pure and client-safe: date keys in, date keys out, never a name.
 */
import { aggregateRoomOccupancy, type PublicRoomOccupancy } from "@/lib/public-room-occupancy";

export type RoomBedSpan = {
  /** Inclusive first day, YYYY-MM-DD. */
  start: string;
  /** Inclusive last day, or null when the stay has no end. */
  end: string | null;
  /** Beds taken (defaults to one; a whole-home stay takes every bed of the room). */
  count?: number;
  /** A channel closure that is only an occupant when nothing else holds the room that day. */
  echoable?: boolean;
};

const FAR_FUTURE = "9999-12-31";

export function nextDayKey(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

export function previousDayKey(day: string): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}

type Interval = { start: string; end: string | null };

/** The pieces of `span` no `covering` interval touches. `covering` must be sorted and non-overlapping. */
function uncovered(span: Interval, covering: readonly Interval[]): Interval[] {
  const spanEnd = span.end ?? FAR_FUTURE;
  const out: Interval[] = [];
  let cursor: string | null = span.start;
  for (const cover of covering) {
    if (cursor === null) break;
    const coverEnd = cover.end ?? FAR_FUTURE;
    if (coverEnd < cursor) continue;
    if (cover.start > spanEnd) break;
    if (cover.start > cursor) out.push({ start: cursor, end: previousDayKey(cover.start) });
    cursor = cover.end === null ? null : nextDayKey(cover.end);
    if (cursor !== null && cursor > spanEnd) cursor = null;
  }
  if (cursor !== null) out.push({ start: cursor, end: span.end });
  return out;
}

/** Anonymous capacity spans for one room: every occupant, minus channel closures echoing another occupant. */
export function occupiedBedSpans(spans: readonly RoomBedSpan[]): PublicRoomOccupancy["spans"] {
  const real = spans.filter((span) => !span.echoable && span.start);
  const echoes = spans.filter((span) => span.echoable && span.start);
  if (echoes.length === 0) return aggregateRoomOccupancy(real);
  const covering = aggregateRoomOccupancy(real).map(({ start, end }) => ({ start, end }));
  const kept = echoes.flatMap((span) =>
    uncovered({ start: span.start, end: span.end }, covering).map((piece) => ({ ...piece, count: span.count ?? 1 })),
  );
  return aggregateRoomOccupancy([...real, ...kept]);
}

/** Beds taken on one day. */
export function occupiedBedsOn(spans: PublicRoomOccupancy["spans"], day: string): number {
  let count = 0;
  for (const span of spans) if (span.start <= day && (!span.end || day <= span.end)) count += span.count;
  return count;
}
