import type { ChannelCalendarImportedRange, ChannelCalendarProvider } from "@/lib/channel-calendar/types";

/**
 * C2-AB7 — a removed channel stay stays removed.
 *
 * Remove stay leaves a durable tombstone keyed by the feed's own event UID on
 * one room's one channel. The sync prunes tombstoned UIDs before it stores the
 * ranges (so Bookings, the public room calendar, the reminders and the
 * occupancy snapshot all stop seeing the stay) and Undo deletes the tombstone
 * and restores the range it carried.
 */

export type ChannelStayTombstone = {
  /** Where the stay lives: one room's one channel connection. */
  propertyId: string;
  roomId: string;
  provider: ChannelCalendarProvider;
  /** The feed's event UID — the only stable identity an iCal reservation has. */
  sourceUid: string;
  /** What was removed, so Undo can put it back without waiting on the next sync. */
  range: ChannelCalendarImportedRange;
  removedAt: string;
};

/** Identity of a tombstone. Room + channel + UID: a UID is only unique within one feed. */
export function channelStayTombstoneKey(input: {
  propertyId: string;
  roomId: string;
  provider: string;
  sourceUid: string;
}): string {
  return [input.propertyId.trim(), input.roomId.trim(), input.provider.trim(), input.sourceUid.trim()].join("|");
}

/** The UID a range is identified by (an iCal event with no UID falls back to its derived id). */
export function importedRangeUid(range: Pick<ChannelCalendarImportedRange, "sourceUid" | "id">): string {
  return (range.sourceUid || range.id || "").trim();
}

/** Drops every tombstoned reservation; `kept` is what a sync is allowed to store. */
export function pruneTombstonedRanges(
  ranges: readonly ChannelCalendarImportedRange[],
  connection: { propertyId: string; roomId: string; provider: string },
  tombstoneKeys: ReadonlySet<string>,
): { kept: ChannelCalendarImportedRange[]; dropped: ChannelCalendarImportedRange[] } {
  const kept: ChannelCalendarImportedRange[] = [];
  const dropped: ChannelCalendarImportedRange[] = [];
  for (const range of ranges) {
    const uid = importedRangeUid(range);
    const hit = uid && tombstoneKeys.has(channelStayTombstoneKey({ ...connection, sourceUid: uid }));
    (hit ? dropped : kept).push(range);
  }
  return { kept, dropped };
}
