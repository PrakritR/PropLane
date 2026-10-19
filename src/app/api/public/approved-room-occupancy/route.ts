import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

export const runtime = "nodejs";

/** One snapshot per instance for as long as the CDN would hold it (`s-maxage=60`). */
const snapshotCache = createTtlCache<PublicRoomOccupancy[]>(60_000);

export async function GET(request: NextRequest) {
  try {
    const fresh = request?.nextUrl.searchParams.get("fresh") === "1";
    // The CDN keys the shared snapshot on the full URL, so `?x=<random>` would miss it every time and
    // reach the database. A snapshot read takes no parameters: send any variant to the one cacheable URL.
    if (request && !fresh && request.nextUrl.search) {
      return NextResponse.redirect(new URL(request.nextUrl.pathname, request.url), 308);
    }
    const propertyId = request?.nextUrl.searchParams.get("propertyId")?.trim();
    if (fresh && !propertyId) return NextResponse.json({ error: "Property is required." }, { status: 400 });
    // Every caller is limited, not only `fresh`: the snapshot is CDN-cached, so a legitimate client
    // rarely reaches this far, and a cache-missing one is bounded the same way.
    if (request) {
      const limited = fresh
        ? await rateLimit(`room-availability:${clientIpFrom(request)}`, 10, 60_000)
        : await rateLimit(`room-availability-snapshot:${clientIpFrom(request)}`, 30, 60_000);
      if (!limited.ok) return NextResponse.json({ error: "Too many availability checks. Try again shortly." }, { status: 429 });
    }
    const db = createSupabaseServiceRoleClient();
    // The shared snapshot reads every listed house's placements; a CDN miss (or a dev server) used to repeat that
    // whole read per browse load. A `fresh` check is one house, uncached, and always live.
    const loadSnapshot = async () => loadPublicRoomOccupancy(db, await getPublicListings());
    if (!fresh) {
      const rooms = serverSnapshotCacheEnabled() ? await snapshotCache.get("snapshot", loadSnapshot) : await loadSnapshot();
      return NextResponse.json({ rooms }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
    }
    const publicListings = await getPublicListings();
    const listings = publicListings.filter((listing) => listing.id === propertyId);
    if (listings.length === 0) return NextResponse.json({ error: "Listing is unavailable." }, { status: 404 });
    const rooms = await loadPublicRoomOccupancy(db, listings);
    return NextResponse.json({ rooms }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load room availability." }, { status: 503 });
  }
}
