import { NextResponse } from "next/server";
import type { MockProperty } from "@/data/types";
import { geocodeListingAddress } from "@/lib/listing-geocode.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The map pin for ONE listing, through the same ZIP-verified lookup the listing payload uses
 * (`listing-geocode.server`): a street hit is accepted only inside the listing's own ZIP, and the fallback is
 * that ZIP's centroid - never a city centre, and never the free-text `/api/geocode` match that put
 * "4709A 8th Ave, 98105" in Westlake.
 *
 * It exists for the second half of a cold load: the page's own lookup is bounded (`LISTING_GEOCODE_WAIT_MS`),
 * so a listing can ship without a pin while the lookup is still running. The client then asks here, which
 * reads the same 30-day cache that lookup is filling.
 *
 * The address is read from the STORED property row, never from the query: `propertyId` is the only input, so
 * the cache this fills is keyed on the catalog's own addresses rather than on anything a caller can invent.
 * Only coordinates are returned - no listing field, and nothing about whether the home is published.
 */
export async function GET(req: Request) {
  const propertyId = new URL(req.url).searchParams.get("propertyId")?.trim() ?? "";
  if (!UUID.test(propertyId)) {
    return NextResponse.json({ error: "A listing id is required." }, { status: 400 });
  }

  if (!(await rateLimit(`listing-geocode:${clientIpFrom(req)}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  try {
    const db = createSupabaseServiceRoleClient();
    const { data, error } = await db
      .from("manager_property_records")
      .select("property_data")
      .eq("id", propertyId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Geocoding failed." }, { status: 502 });
    const stored = (data?.property_data ?? null) as MockProperty | null;
    if (!stored) return NextResponse.json({ error: "Listing not found." }, { status: 404 });

    const coords = await geocodeListingAddress({
      address: stored.address,
      zip: stored.zip,
      city: stored.listingSubmission?.city,
      state: stored.state ?? stored.listingSubmission?.state,
    });
    if (!coords) return NextResponse.json({ error: "Address could not be located." }, { status: 404 });
    return NextResponse.json(coords, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch {
    return NextResponse.json({ error: "Geocoding failed." }, { status: 502 });
  }
}
