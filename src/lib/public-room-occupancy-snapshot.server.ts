import "server-only";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { MockProperty } from "@/data/types";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";

/** One snapshot per instance for as long as the CDN would hold it (`s-maxage=60`). */
const snapshotCache = createTtlCache<PublicRoomOccupancy[]>(60_000);

/**
 * The anonymous occupancy of every listed house. The occupancy route and the catalog's live room labels
 * (`applyLiveRoomAvailability`) read this one snapshot, so a label and the spans it came from cannot disagree.
 * `listings` must be the RAW catalog (`getPublicListings({ liveAvailability: false })`): the labels are derived
 * from this snapshot, so asking the labelled catalog for it would be circular.
 */
export async function loadPublicOccupancySnapshot(listings: () => Promise<MockProperty[]>): Promise<PublicRoomOccupancy[]> {
  const load = async () => loadPublicRoomOccupancy(createSupabaseServiceRoleClient(), await listings());
  return serverSnapshotCacheEnabled() ? snapshotCache.get("snapshot", load) : load();
}

export function clearPublicOccupancySnapshot(): void {
  snapshotCache.clear();
}
