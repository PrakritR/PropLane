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
