import type { ListingRoomRow } from "@/data/listing-rich-content";
import { openNowStatusText, publicStatusFromAvailability, roomAvailability, type RoomAvailability } from "@/lib/room-availability";
import { roomAvailabilityTone, type RoomAvailabilityTone } from "@/lib/room-availability-style";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/room-choice-value";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

/**
 * The occupancy row for one room, by its exact `<propertyId>::<roomId>` key and nothing else.
 *
 * Use this, never {@link findPublicRoomOccupancy}, when the rows span MORE THAN ONE HOUSE (the catalog-wide
 * snapshot behind `applyLiveRoomAvailability`): two houses can each own a "room-1", and the suffix fallback would
 * then publish one house's spans as the other's. A miss here means the snapshot never saw the room.
 */
export function findPublicRoomOccupancyExact(
  rows: readonly PublicRoomOccupancy[],
  propertyId: string,
  roomId: string,
): PublicRoomOccupancy | undefined {
  const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`;
  return rows.find((entry) => entry.roomChoice === choice);
}

/**
 * The occupancy row for one room: exact `<propertyId>::<roomId>` first, then any row ending in `::<roomId>`.
 * The suffix fallback is for ONE house's rows, whose keys may carry a different property id than the page asks
 * under — so it is taken only when every row belongs to the same house. Rows covering several houses (a
 * catalog-wide snapshot, a multi-house share) resolve exactly or not at all, because two houses can each own
 * a "room-1" and the fallback would publish one house's spans as the other's.
 */
export function findPublicRoomOccupancy(
  rows: readonly PublicRoomOccupancy[],
  propertyId: string,
  roomId: string,
): PublicRoomOccupancy | undefined {
  const exact = findPublicRoomOccupancyExact(rows, propertyId, roomId);
  if (exact) return exact;
  let house: string | null = null;
  for (const entry of rows) {
    const owner = entry.roomChoice.split(LISTING_ROOM_CHOICE_SEP)[0] ?? "";
    if (house === null) house = owner;
    else if (house !== owner) return undefined;
  }
  return rows.find((entry) => entry.roomChoice.endsWith(`${LISTING_ROOM_CHOICE_SEP}${roomId}`));
}

type AvailabilityRoom = Pick<ListingRoomRow, "id" | "availability" | "occupancyCapacity"> & {
  /** The room's own opening date (submission field). A future one is a floor: the room is not open before it. */
  moveInAvailableDate?: string | null;
};

/**
 * One room's availability from the property's published occupancy rows (no row = no spans).
 * The room's own `moveInAvailableDate` rides along as a FLOOR: saved copy that closes the room still
 * closes it, and the later of the two dates wins.
 */
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
 * "Open now" is the ONE availability count: rooms (never beds) a renter can move into today, where the
 * shared `roomAvailability` predicate says "now". A room that opens later reads "Opens <date>" and is
 * never counted. The header, key-facts tile, room list and sticky bar all read this, so they cannot
 * disagree. With no occupancy rows (fetch failed) it is the static count.
 */
export function countRoomsAvailableNow(
  rooms: readonly AvailabilityRoom[],
  occupancyRows: readonly PublicRoomOccupancy[],
  today: string,
  propertyId: string,
): number {
  return rooms.filter((room) => resolveRoomAvailability(room, occupancyRows, today, propertyId).kind === "now").length;
}

/**
 * The share summary's `openNow` for one house, from a client occupancy read: the count when the read
 * answered, `undefined` while it loads, when it failed, or when the house lists no rooms — no read, no claim.
 * The one place every share preview derives it, so a preview can never disagree with the sent email.
 */
export function shareOpenNowCount(
  rooms: readonly AvailabilityRoom[],
  occupancy: { rows: readonly PublicRoomOccupancy[]; loading: boolean; failed: boolean },
  today: string,
  propertyId: string,
): number | undefined {
  if (occupancy.loading || occupancy.failed || rooms.length === 0) return undefined;
  return countRoomsAvailableNow(rooms, occupancy.rows, today, propertyId);
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
  const spans = findPublicRoomOccupancy(occupancy.rows, propertyId, room.id)?.spans ?? [];
  const status = publicStatusFromAvailability(resolveRoomAvailability(room, occupancy.rows, today, propertyId), spans, room.occupancyCapacity, today);
  return {
    text: openNowStatusText(status, today),
    tone: status.kind === "now" ? "available" : status.kind === "soon" ? "future" : "unavailable",
  };
}
