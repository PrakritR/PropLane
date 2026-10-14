import type { ListingRoomRow } from "@/data/listing-rich-content";
import { formatRoomAvailability, roomAvailability, type RoomAvailability } from "@/lib/room-availability";
import { roomAvailabilityTone, type RoomAvailabilityTone } from "@/lib/room-availability-style";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/room-choice-value";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

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

type AvailabilityRoom = Pick<ListingRoomRow, "id" | "availability" | "occupancyCapacity">;

/** One room's availability from the property's published occupancy rows (no row = no spans). */
export function resolveRoomAvailability(
  room: AvailabilityRoom,
  occupancyRows: readonly PublicRoomOccupancy[],
  today: string,
  propertyId: string,
): RoomAvailability {
  const spans = findPublicRoomOccupancy(occupancyRows, propertyId, room.id)?.spans ?? [];
  return roomAvailability(room, spans, today);
}

/**
 * Rooms a renter can move into today: the shared `roomAvailability` predicate says "now". The one
 * place the key-facts tile and the sticky bar read, so they cannot disagree. With no occupancy
 * rows (fetch failed) it is the static count.
 */
export function countRoomsAvailableNow(
  rooms: readonly AvailabilityRoom[],
  occupancyRows: readonly PublicRoomOccupancy[],
  today: string,
  propertyId: string,
): number {
  return rooms.filter((room) => resolveRoomAvailability(room, occupancyRows, today, propertyId).kind === "now").length;
}

/** The earliest day any room frees up after today, or null when none has a date. Used when nothing is open now. */
export function nextOpeningDate(
  rooms: readonly AvailabilityRoom[],
  occupancyRows: readonly PublicRoomOccupancy[],
  today: string,
  propertyId: string,
): string | null {
  let best: string | null = null;
  for (const room of rooms) {
    const result = resolveRoomAvailability(room, occupancyRows, today, propertyId);
    if (result.kind === "from" && (best === null || result.date < best)) best = result.date;
  }
  return best;
}

/**
 * What a room row, the mobile row and the room modal say. `null` while occupancy loads, so the
 * stale static "Available now" never flashes; a failed request keeps the room's own static label
 * (it claims no date), and a loaded one reads the shared predicate.
 */
export function roomAvailabilityDisplay(
  room: AvailabilityRoom,
  occupancy: { rows: readonly PublicRoomOccupancy[]; loading: boolean; failed: boolean },
  today: string,
  propertyId: string,
): { text: string; tone: RoomAvailabilityTone } | null {
  if (occupancy.loading) return null;
  if (occupancy.failed) return { text: room.availability, tone: roomAvailabilityTone(room.availability) };
  const result = resolveRoomAvailability(room, occupancy.rows, today, propertyId);
  return {
    text: formatRoomAvailability(result, today),
    tone: result.kind === "now" ? "available" : result.kind === "from" ? "future" : "unavailable",
  };
}
