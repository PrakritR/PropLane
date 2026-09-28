import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function GET(request?: NextRequest) {
  try {
    const fresh = request?.nextUrl.searchParams.get("fresh") === "1";
    const propertyId = request?.nextUrl.searchParams.get("propertyId")?.trim();
    if (fresh && !propertyId) return NextResponse.json({ error: "Property is required." }, { status: 400 });
    if (fresh && request && !(await rateLimit(`room-availability:${clientIpFrom(request)}`, 10, 60_000)).ok) {
      return NextResponse.json({ error: "Too many availability checks. Try again shortly." }, { status: 429 });
    }
    const db = createSupabaseServiceRoleClient();
    const publicListings = await getPublicListings();
    const listings = fresh ? publicListings.filter((listing) => listing.id === propertyId) : publicListings;
    if (fresh && listings.length === 0) return NextResponse.json({ error: "Listing is unavailable." }, { status: 404 });
    const rooms = await loadPublicRoomOccupancy(db, listings);
    return NextResponse.json({ rooms }, { headers: { "Cache-Control": fresh
      ? "private, no-store"
      : "public, s-maxage=60, stale-while-revalidate=120" } });
  } catch {
    return NextResponse.json({ error: "Could not load room availability." }, { status: 503 });
  }
}
