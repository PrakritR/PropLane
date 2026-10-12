import type { ListingRoomRow } from "@/data/listing-rich-content";
import { classifyRoomOpening } from "@/lib/room-availability-style";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/room-choice-value";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { occupiedBedsOn } from "@/lib/room-occupancy-rule";

/** The occupancy row for one room: exact `<propertyId>::<roomId>` first, then any row ending in `::<roomId>`. */
export function findPublicRoomOccupancy(
  rows: readonly PublicRoomOccupancy[],
  propertyId: string,
  roomId: string,
): PublicRoomOccupancy | undefined {
  const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  return (
    rows.find((entry) => entry.roomChoice === choice) ??
    rows.find((entry) => entry.roomChoice.endsWith(`${LISTING_ROOM_CHOICE_SEP}${roomId}`))
  );
}

/**
 * Rooms a renter can move into today: the room's own availability copy says "now" AND
 * the beds taken today (from real occupancy) are fewer than its capacity. The one place
 * the key-facts tile and the sticky bar read, so they cannot disagree. With no occupancy
 * rows (fetch failed) it is the static count.
 */
export function countRoomsAvailableNow(
  rooms: readonly Pick<ListingRoomRow, "id" | "availability" | "occupancyCapacity">[],
  occupancyRows: readonly PublicRoomOccupancy[],
  today: string,
  propertyId = "",
): number {
  return rooms.filter((room) => {
    if (classifyRoomOpening(room.availability).kind !== "now") return false;
    const spans = findPublicRoomOccupancy(occupancyRows, propertyId, room.id)?.spans ?? [];
    return occupiedBedsOn(spans, today) < normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  }).length;
}
