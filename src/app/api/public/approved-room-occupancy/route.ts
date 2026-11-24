import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { loadPublicOccupancySnapshot } from "@/lib/public-room-occupancy-snapshot.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createTtlCache, serverSnapshotCacheEnabled } from "@/lib/server-ttl-cache";
import type { MockProperty } from "@/data/types";

export const runtime = "nodejs";

/**
 * WHICH homes are public (ids and rooms) is the same answer for everyone and does not need to be live: a `fresh` check
 * used to rebuild the whole catalog (every listing's work number, work email, forms and attribution) before it could read
 * the one house it was asked about, which is what held the apply wizard's Continue for 10-25 seconds. The catalog is kept
 * for the response's own 60 seconds; the occupancy read below stays live and uncached.
 */
const rawCatalogCache = createTtlCache<MockProperty[]>(60_000);
function rawPublicCatalog(): Promise<MockProperty[]> {
  const load = () => getPublicListings({ liveAvailability: false });
  return serverSnapshotCacheEnabled() ? rawCatalogCache.get("raw-catalog", load) : load();
}

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
    if (!fresh) {
      // The raw catalog: the labels are derived from this snapshot, so they cannot be what it is built from.
      const rooms = await loadPublicOccupancySnapshot(rawPublicCatalog);
      return NextResponse.json({ rooms }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" } });
    }
    const publicListings = await rawPublicCatalog();
    const listings = publicListings.filter((listing) => listing.id === propertyId);
    if (listings.length === 0) return NextResponse.json({ error: "Listing is unavailable." }, { status: 404 });
    const rooms = await loadPublicRoomOccupancy(db, listings);
    return NextResponse.json({ rooms }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return NextResponse.json({ error: "Could not load room availability." }, { status: 503 });
  }
}
