import { isHostBlockRange } from "@/lib/channel-calendar/host-block";
import type { ChannelCalendarImportedRange, ChannelCalendarProvider } from "@/lib/channel-calendar/types";

type Range = { start: string; end: string };

export type FeedConnection = {
  id: string;
  roomId: string;
  provider: ChannelCalendarProvider;
  exportToken?: string;
  importedRanges: readonly ChannelCalendarImportedRange[];
};

export type FeedPlacement = { connectionId: string; start: string; end: string };

/**
 * A connection's stays reach this feed when it is the same room, or either side is the whole
 * home (room id = property id): a whole-home booking blocks every room and a room booking
 * blocks the whole home. When unsure this includes more, since over-blocking never double-books.
 */
export function connectionTouchesRoom(connectionRoomId: string, roomId: string, propertyId: string): boolean {
  return connectionRoomId === roomId || connectionRoomId === propertyId || roomId === propertyId;
}

/**
 * Bookings other channels brought in, for the feed pasted into `destination`. The destination's
 * own imports are left out (echo); `null` means "every channel" (a generic or shared link).
 * Reads each connection's stored ranges AND the placeholder placements filed from them.
 */
export function importedRangesForFeed(input: {
  propertyId: string;
  roomId: string;
  destination: ChannelCalendarProvider | null;
  connections: readonly FeedConnection[];
  placements: readonly FeedPlacement[];
}): Range[] {
  const relevant = input.connections.filter(
    (c) => (input.destination === null || c.provider !== input.destination) && connectionTouchesRoom(c.roomId, input.roomId, input.propertyId),
  );
  const ids = new Set(relevant.map((c) => c.id));
  const out: Range[] = [];
  for (const connection of relevant) {
    for (const range of connection.importedRanges) {
      // A host block would echo straight back to the channel it came from.
      if (isHostBlockRange(range)) continue;
      const start = String(range.start ?? "").trim();
      if (!start) continue;
      out.push({ start, end: String(range.end ?? start).trim() || start });
    }
  }
  for (const placement of input.placements) {
    if (ids.has(placement.connectionId)) out.push({ start: placement.start, end: placement.end || placement.start });
  }
  // Exact duplicates collapse here; contiguous ones merge in exportBlockedRanges.
  const seen = new Set<string>();
  return out.filter((r) => r.end >= r.start && !seen.has(`${r.start}|${r.end}`) && seen.add(`${r.start}|${r.end}`));
}
