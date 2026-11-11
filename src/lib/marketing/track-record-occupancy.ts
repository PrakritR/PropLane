import { AMBIKA_SEATTLE_PROPERTY_IDS } from "@/lib/ambika-seattle-occupancy";
import { TRACK_RECORD, type RoomOccupancy } from "@/lib/marketing/track-record";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

/**
 * Rooms occupied across the Seattle homes PropLane runs, from the anonymous public occupancy
 * snapshot (the same spans the catalog's live room labels read). Pure: the server wrapper
 * (`track-record-live.server.ts`) feeds it the snapshot and today's Pacific day.
 */

type Listing = {
  id: string;
  title?: string | null;
  address?: string | null;
  buildingName?: string | null;
  listingSubmission?: { rooms?: { id: string }[] } | null;
};

/** One matcher per home, against the listing's title / address / building name. */
const HOME_MATCHERS: readonly RegExp[] = [/5257\s+brooklyn/i, /5259\s+brooklyn/i, /4709/i];

const PREFERRED_IDS: ReadonlySet<string> = new Set(Object.values(AMBIKA_SEATTLE_PROPERTY_IDS));

function coversDay(span: PublicRoomOccupancy["spans"][number], day: string): boolean {
  return span.count > 0 && span.start <= day && (span.end === null || span.end >= day);
}

/**
 * Null when any of the homes cannot be found in the listings or has no rooms: a partial read would
 * publish a smaller total than the real one, so the caller falls back to the last stated figure.
 */
export function computeSeattleRoomOccupancy(
  listings: readonly Listing[],
  rooms: readonly PublicRoomOccupancy[],
  today: string,
): RoomOccupancy | null {
  const spansByRoom = new Map(rooms.map((r) => [r.roomChoice, r.spans] as const));
  let roomsTotal = 0;
  let roomsOccupied = 0;
  let homes = 0;
  for (const matcher of HOME_MATCHERS) {
    const candidates = listings.filter((l) => matcher.test(`${l.title ?? ""} ${l.address ?? ""} ${l.buildingName ?? ""}`));
    const listing = candidates.find((l) => PREFERRED_IDS.has(l.id)) ?? candidates[0];
    const homeRooms = listing?.listingSubmission?.rooms ?? [];
    if (!listing || homeRooms.length === 0) return null;
    homes += 1;
    for (const room of homeRooms) {
      roomsTotal += 1;
      const spans = spansByRoom.get(`${listing.id}::${room.id}`) ?? [];
      if (spans.some((span) => coversDay(span, today))) roomsOccupied += 1;
    }
  }
  return homes === TRACK_RECORD.homes && roomsTotal > 0 ? { roomsOccupied, roomsTotal } : null;
}
