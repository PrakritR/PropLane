import "server-only";
import { getPublicListings } from "@/lib/public-listings.server";
import { loadPublicOccupancySnapshot } from "@/lib/public-room-occupancy-snapshot.server";
import { pacificListingDay } from "@/lib/public-room-occupancy";
import { computeSeattleRoomOccupancy } from "@/lib/marketing/track-record-occupancy";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import { resolveRoomOccupancy, type RoomOccupancy } from "@/lib/marketing/track-record";

/**
 * The homepage "N of M rooms occupied", computed live from the occupancy snapshot (captain,
 * 2026-11-10) so it agrees with the Dashboard. PUBLIC and identical for every caller: never
 * scoped to a viewer or a workspace. Cached an hour per instance (the captain's call; the page
 * and llms.txt revalidate faster than that but hit this cache), and a failure is never cached:
 * it falls back to the last stated figure.
 */
const HOUR_MS = 60 * 60 * 1000;
const cache = createTtlCache<RoomOccupancy | null>(HOUR_MS);

function pacificTodayKey(now = new Date()): string {
  const d = pacificListingDay(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function readLive(): Promise<RoomOccupancy | null> {
  const listings = await getPublicListings({ liveAvailability: false });
  const rooms = await loadPublicOccupancySnapshot(() => Promise.resolve(listings));
  return computeSeattleRoomOccupancy(listings, rooms, pacificTodayKey());
}

export async function liveRoomOccupancy(): Promise<RoomOccupancy> {
  try {
    const live = serverSnapshotCacheEnabled() ? await cache.get("seattle", readLive) : await readLive();
    return resolveRoomOccupancy(live);
  } catch {
    return resolveRoomOccupancy(null);
  }
}

export function clearLiveRoomOccupancy(): void {
  cache.clear();
}
