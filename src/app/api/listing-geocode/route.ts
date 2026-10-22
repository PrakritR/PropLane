import { NextResponse } from "next/server";
import { geocodeListingAddress } from "@/lib/listing-geocode.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * The map pin for ONE listing address, through the same ZIP-verified lookup the listing payload uses
 * (`listing-geocode.server`): a street hit is accepted only inside the listing's own ZIP, and the fallback is
 * that ZIP's centroid - never a city centre, and never the free-text `/api/geocode` match that put
 * "4709A 8th Ave, 98105" in Westlake.
 *
 * It exists for the second half of a cold load: the page's own lookup is bounded (`LISTING_GEOCODE_WAIT_MS`),
 * so a listing can ship without a pin while the lookup is still running. The client then asks here, which
 * reads the same 30-day cache that lookup is filling. A ZIP is required: without one there is nothing to
 * verify a hit against, so the map draws its neutral fallback centre instead.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const address = searchParams.get("address")?.trim() ?? "";
  const zip = searchParams.get("zip")?.trim() ?? "";
  const city = searchParams.get("city")?.trim() ?? "";
  const state = searchParams.get("state")?.trim() ?? "";
  if (!/^\d{5}(?:-\d{4})?$/.test(zip)) {
    return NextResponse.json({ error: "A listing ZIP is required." }, { status: 400 });
  }

  if (!(await rateLimit(`listing-geocode:${clientIpFrom(req)}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  try {
    const coords = await geocodeListingAddress({
      address: address.slice(0, 200),
      zip,
      city: city.slice(0, 120),
      state: state.slice(0, 2),
    });
    if (!coords) return NextResponse.json({ error: "Address could not be located." }, { status: 404 });
    return NextResponse.json(coords, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch {
    return NextResponse.json({ error: "Geocoding failed." }, { status: 502 });
  }
}
