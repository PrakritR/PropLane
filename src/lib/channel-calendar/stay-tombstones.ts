import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
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
  /** The connection the stay was removed from (absent on a tombstone written before this was recorded). */
  connectionId?: string;
  /** The signed-in manager who removed it (server-stamped, never a body field). */
  removedBy?: string;
};

/** A stored tombstone with its record id, as the "Removed stays" list reads it. */
export type StoredChannelStayTombstone = ChannelStayTombstone & { id: string };

/** A tombstone belongs to a connection's room + channel; a recorded connection id narrows it further. */
export function tombstoneBelongsToConnection(
  tombstone: Pick<ChannelStayTombstone, "propertyId" | "roomId" | "provider" | "connectionId">,
  connection: { id: string; property_id: string; room_id: string; provider: string },
): boolean {
  return (
    tombstone.propertyId === connection.property_id &&
    tombstone.roomId === connection.room_id &&
    tombstone.provider === connection.provider &&
    (!tombstone.connectionId || tombstone.connectionId === connection.id)
  );
}

/** The key of a stored tombstone (a host block's carries its dates). */
export function channelStayTombstoneKeyOf(t: ChannelStayTombstone): string {
  return channelStayTombstoneKey({
    ...t,
    start: t.range.start,
    end: t.range.end,
    hostBlock: t.range.hostBlock,
    summary: t.range.summary,
  });
}

/**
 * Identity of a tombstone. Room + channel + UID: a UID is only unique within one feed.
 *
 * A host block ("Airbnb (Not available)") is the exception: Airbnb reuses ONE UID for every
 * block a host has, across dates and listings, so its identity also carries the dates
 * (`start|end`). Pass `hostBlock` (or a `summary` that reads as one) with the range's dates.
 * Reservations (unique UIDs) stay UID-only.
 */
export function channelStayTombstoneKey(input: {
  propertyId: string;
  roomId: string;
  provider: string;
  sourceUid: string;
  start?: string | null;
  end?: string | null;
  hostBlock?: boolean;
  summary?: string | null;
}): string {
  const parts = [input.propertyId.trim(), input.roomId.trim(), input.provider.trim(), input.sourceUid.trim()];
  if (isHostBlockRange({ hostBlock: input.hostBlock, summary: input.summary })) {
    const start = (input.start ?? "").trim();
    parts.push(start, (input.end ?? start).trim());
  }
  return parts.join("|");
}

/** The UID a range is identified by (an iCal event with no UID falls back to its derived id). */
export function importedRangeUid(range: Pick<ChannelCalendarImportedRange, "sourceUid" | "id">): string {
  return (range.sourceUid || range.id || "").trim();
}

/**
 * Drops every tombstoned reservation; `kept` is what a sync is allowed to store.
 *
 * A removed RESERVATION is identified by its UID, but a UID is only a promise that the feed names the same booking:
 * when the feed lists that UID with DIFFERENT dates than the ones the manager removed (the guest changed the stay, or
 * the channel reused the UID for a rebooking), it is new information and is stored again. Pass `removedDates`
 * (tombstone key -> the removed range's dates) to enable that; a tombstone with no recorded dates, and every host
 * block (whose key already carries its dates), prunes exactly as before.
 */
export function pruneTombstonedRanges(
  ranges: readonly ChannelCalendarImportedRange[],
  connection: { propertyId: string; roomId: string; provider: string },
  tombstoneKeys: ReadonlySet<string>,
  removedDates?: ReadonlyMap<string, { start: string; end: string }>,
): { kept: ChannelCalendarImportedRange[]; dropped: ChannelCalendarImportedRange[] } {
  const kept: ChannelCalendarImportedRange[] = [];
  const dropped: ChannelCalendarImportedRange[] = [];
  for (const range of ranges) {
    const uid = importedRangeUid(range);
    const key = uid
      ? channelStayTombstoneKey({
          ...connection,
          sourceUid: uid,
          start: range.start,
          end: range.end,
          hostBlock: range.hostBlock,
          summary: range.summary,
        })
      : "";
    let hit = Boolean(key) && tombstoneKeys.has(key);
    if (hit && removedDates && !isHostBlockRange(range)) {
      const removed = removedDates.get(key);
      if (removed && removed.start && (removed.start !== range.start || (removed.end || removed.start) !== (range.end || range.start))) hit = false;
    }
    (hit ? dropped : kept).push(range);
  }
  return { kept, dropped };
}

/**
 * Everything {@link pruneTombstonedRanges} needs, carried in ONE value.
 *
 * The dates must travel with the keys: a caller holding only the key set prunes by UID alone, so a
 * reservation the feed now lists with different dates would be dropped instead of stored again.
 */
export type ChannelStayTombstonePrune = {
  keys: Set<string>;
  removedDates: Map<string, { start: string; end: string }>;
};

/** The key set and the dates each tombstone removed, for {@link pruneTombstonedRanges}. */
export function tombstonePruneOf(tombstones: readonly ChannelStayTombstone[]): ChannelStayTombstonePrune {
  return { keys: new Set(tombstones.map(channelStayTombstoneKeyOf)), removedDates: removedDatesByKey(tombstones) };
}

/** Tombstone key -> the dates that were removed, for {@link pruneTombstonedRanges}. */
export function removedDatesByKey(
  tombstones: readonly ChannelStayTombstone[],
): Map<string, { start: string; end: string }> {
  return new Map(tombstones.map((t) => [channelStayTombstoneKeyOf(t), { start: t.range.start, end: t.range.end || t.range.start }]));
}
