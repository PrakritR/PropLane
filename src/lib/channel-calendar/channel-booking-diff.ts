import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import type { ChannelCalendarImportedRange } from "@/lib/channel-calendar/types";

/**
 * Identity of a channel reservation across syncs: the feed's own UID, else the
 * stay itself (start | end | summary) for a feed that carries none.
 */
export function channelRangeKey(range: ChannelCalendarImportedRange): string {
  const uid = (range.sourceUid || "").trim();
  return uid || `${range.start}|${range.end}|${(range.summary || "").trim()}`;
}

export type ChannelBookingDiff = {
  created: ChannelCalendarImportedRange[];
  cancelled: ChannelCalendarImportedRange[];
};

/**
 * What a sync changed, as reservations. A host block ("Airbnb (Not available)")
 * is never a reservation - that is also how Airbnb echoes a PropLane stay back,
 * so it can never alert. The first sync of a connection (`baseline`) only
 * records what is already on the channel. A reservation that ended before
 * `today` is never news: channels drop finished stays from the feed, which is
 * not a cancellation.
 */
export function diffChannelReservations(input: {
  previous: readonly ChannelCalendarImportedRange[];
  next: readonly ChannelCalendarImportedRange[];
  baseline: boolean;
  /** YYYY-MM-DD; a range whose last night is before this is history. */
  today: string;
}): ChannelBookingDiff {
  if (input.baseline) return { created: [], cancelled: [] };
  // A feed that parsed but carries no events at all is not evidence that every stay was
  // cancelled - an upstream blip reads exactly the same. Announcing it would spend each stay's
  // one-shot event id, muting both the stay's return and its real cancellation later, so this
  // sync updates the calendar and announces nothing. A feed that still carries events (a host
  // block, another stay) is trusted, so an ordinary cancellation is still news.
  if (input.next.length === 0 && input.previous.length > 0) return { created: [], cancelled: [] };
  const reservations = (ranges: readonly ChannelCalendarImportedRange[]) =>
    ranges.filter((range) => !isHostBlockRange(range) && (range.end || range.start) >= input.today);
  const before = new Map(reservations(input.previous).map((range) => [channelRangeKey(range), range] as const));
  const after = new Map(reservations(input.next).map((range) => [channelRangeKey(range), range] as const));
  return {
    created: [...after].filter(([key]) => !before.has(key)).map(([, range]) => range),
    cancelled: [...before].filter(([key]) => !after.has(key)).map(([, range]) => range),
  };
}

/** The identities a reservation can be recognised by in another room's feed: its UID and its Airbnb reservation code. */
function movedIdentities(range: ChannelCalendarImportedRange): string[] {
  const ids: string[] = [];
  const uid = (range.sourceUid || "").trim();
  if (uid) ids.push(`uid:${uid}`);
  const code = (range.reservationCode || "").trim();
  if (code) ids.push(`code:${code}`);
  return ids;
}

/** Every reservation identity stored on the workspace's OTHER channel connections. */
export function reservationIdentitiesElsewhere(
  otherConnectionRanges: readonly (readonly ChannelCalendarImportedRange[])[],
): Set<string> {
  const out = new Set<string>();
  for (const ranges of otherConnectionRanges) {
    for (const range of ranges) {
      if (isHostBlockRange(range)) continue;
      for (const id of movedIdentities(range)) out.add(id);
    }
  }
  return out;
}

/**
 * Re-pointing a room's import URL at another listing moves the SAME stays between rooms of one workspace: the
 * room that took them reads them as new, the room that lost them reads them as cancelled. Neither is news. A
 * reservation (same iCal UID or reservation code) that the workspace's other connections also hold is a move, so
 * it is dropped from `created` (it was already there) and from `cancelled` (it is still there), whichever room
 * synced first. A stay with neither a UID nor a code is never treated as a move: two unnamed "Reserved" stays on
 * the same dates in two rooms are not provably one booking.
 */
export function withoutMovedReservations(
  diff: ChannelBookingDiff,
  elsewhere: ReadonlySet<string>,
): ChannelBookingDiff & { moved: ChannelCalendarImportedRange[] } {
  if (elsewhere.size === 0) return { ...diff, moved: [] };
  const isMove = (range: ChannelCalendarImportedRange) => movedIdentities(range).some((id) => elsewhere.has(id));
  return {
    created: diff.created.filter((range) => !isMove(range)),
    cancelled: diff.cancelled.filter((range) => !isMove(range)),
    moved: [...diff.created, ...diff.cancelled].filter(isMove),
  };
}
