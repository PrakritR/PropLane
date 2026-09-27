import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { getPublicListings } from "@/lib/public-listings.server";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = createSupabaseServiceRoleClient();
    const listings = await getPublicListings();
    const rooms = await loadPublicRoomOccupancy(db, listings);
    return NextResponse.json({ rooms }, { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } });
  } catch {
    return NextResponse.json({ error: "Could not load room availability." }, { status: 503 });
  }
}
