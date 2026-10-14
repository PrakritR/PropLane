/**
 * A host's own calendar block, as a channel exports it ("Airbnb (Not available)"), is not a
 * reservation: no guest holds the bed. It still closes the dates on the channel, so the Bookings
 * calendar shows it as a block, but it must never count toward room capacity or be exported back.
 * "Reserved" is a real booking and is deliberately NOT matched here.
 *
 * The match is on the WHOLE summary (optionally wrapped in the channel's own name, which is how
 * Airbnb writes it) — never a substring. Booking.com and VRBO privacy-strip real reservations to
 * "CLOSED - Not available", and reading one of those as a host block would publish an occupied
 * room as free.
 */
import { coveringIntervals, nextDayKey, uncovered } from "@/lib/room-occupancy-rule";

const HOST_BLOCK_LABELS: ReadonlySet<string> = new Set(["not available", "blocked", "unavailable"]);
const CHANNEL_WRAPPED = /^[a-z0-9][a-z0-9 .&'’-]*\(([^()]+)\)$/;

export function isHostBlockSummary(summary: string | null | undefined): boolean {
  const raw = String(summary ?? "").trim().toLowerCase();
  if (!raw) return false;
  if (HOST_BLOCK_LABELS.has(raw)) return true;
  const wrapped = CHANNEL_WRAPPED.exec(raw);
  return wrapped ? HOST_BLOCK_LABELS.has(wrapped[1]!.trim()) : false;
}

/** The stored flag wins; ranges stored before the flag existed are derived from their summary. */
export function isHostBlockRange(range: { hostBlock?: boolean; summary?: string | null }): boolean {
  return typeof range.hostBlock === "boolean" ? range.hostBlock : isHostBlockSummary(range.summary);
}

/** Ranges that take a bed: everything except a host block. */
export function withoutHostBlocks<T extends { hostBlock?: boolean; summary?: string | null }>(ranges: readonly T[]): T[] {
  return ranges.filter((range) => !isHostBlockRange(range));
}

type EchoCandidate = {
  source: string;
  propertyId: string;
  roomId: string;
  start: string;
  end: string;
  openEnded?: boolean;
  bookingStatus?: string;
  summary?: string | null;
  hostBlock?: boolean;
  /**
   * Set only on a trimmed remainder: the dates of the RAW imported range it was cut from. A host
   * block's durable identity is its UID PLUS those dates (Airbnb reuses one UID for every block a
   * host has - `channelStayTombstoneKey`), so Remove stay and Undo must send these, never the
   * remainder's own visible dates.
   */
  channelRangeStart?: string;
  channelRangeEnd?: string;
};

const LOCAL_OCCUPANT_SOURCES = new Set(["proplane", "hold", "block"]);

/**
 * Drops (or trims) a channel's host block ("Airbnb (Not available)") that PropLane's own occupancy
 * already covers on the same room. PropLane exports its residents, holds and blocks to the channel
 * as unavailable and the channel's feed hands them back, so the import draws each stay twice.
 * The covering set is the union of the non-channel entries of that room (back-to-back residents
 * together cover one long echo); a host block only partly covered keeps its uncovered remainder as
 * one entry per gap. A host block with nothing under it (closed on the channel itself) and every
 * reservation are kept untouched. The raw imported ranges are never edited: this only shapes the
 * entries the calendar and its tabs draw, and each remainder carries the raw range's dates so it
 * stays removable.
 *
 * Coverage is `coveringIntervals` + `uncovered` from `room-occupancy-rule` - the same subtraction
 * the occupancy snapshot runs on `echoable` spans, so the calendar and the room rows cannot drift.
 */
export function withoutEchoedHostBlocks<T extends EchoCandidate>(entries: readonly T[]): T[] {
  const locals = entries.filter((entry) => LOCAL_OCCUPANT_SOURCES.has(entry.source) && entry.bookingStatus !== "cancelled");
  if (locals.length === 0) return [...entries];
  const out: T[] = [];
  for (const entry of entries) {
    if (LOCAL_OCCUPANT_SOURCES.has(entry.source) || !isHostBlockRange(entry)) {
      out.push(entry);
      continue;
    }
    const covering = coveringIntervals(
      locals
        .filter((local) => local.propertyId === entry.propertyId && (!local.roomId || local.roomId === entry.roomId))
        .map((local) => ({ start: local.start, end: local.openEnded ? null : local.end })),
    );
    const pieces = uncovered({ start: entry.start, end: entry.end }, covering);
    // A channel can re-export the exclusive check-out as a trailing day; that day is not a gap.
    const tail = pieces[pieces.length - 1];
    if (tail && tail.start === entry.end && tail.end === entry.end && covering.some((c) => c.end !== null && nextDayKey(c.end) === entry.end)) {
      pieces.pop();
    }
    if (pieces.length === 1 && pieces[0]!.start === entry.start && pieces[0]!.end === entry.end) out.push(entry);
    else {
      for (const piece of pieces) {
        out.push({
          ...entry,
          start: piece.start,
          end: piece.end ?? entry.end,
          channelRangeStart: entry.channelRangeStart ?? entry.start,
          channelRangeEnd: entry.channelRangeEnd ?? entry.end,
        });
      }
    }
  }
  return out;
}
