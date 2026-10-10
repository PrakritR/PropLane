import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(request?: NextRequest) {
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
    const publicListings = await getPublicListings();
    const listings = fresh ? publicListings.filter((listing) => listing.id === propertyId) : publicListings;
    if (fresh && listings.length === 0) return NextResponse.json({ error: "Listing is unavailable." }, { status: 404 });
    const rooms = await loadPublicRoomOccupancy(db, listings);
    return NextResponse.json({ rooms }, { headers: { "Cache-Control": fresh
      ? "private, no-store"
      : "public, s-maxage=60, stale-while-revalidate=300" } });
  } catch {
    return NextResponse.json({ error: "Could not load room availability." }, { status: 503 });
  }
}
