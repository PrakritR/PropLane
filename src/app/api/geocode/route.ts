import { NextResponse } from "next/server";
import { listingGeocodeQuery, parseGeocodeResult, type GeocodeCoords } from "@/lib/geocode-address";
import { boundedCacheSet, nominatimUserAgent, throttleNominatim } from "@/lib/nominatim.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import type { MockProperty } from "@/data/types";

export const runtime = "nodejs";

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const geocodeCache = new Map<string, { coords: GeocodeCoords; at: number }>();

async function geocodeWithNominatim(query: string): Promise<GeocodeCoords | null> {
  await throttleNominatim();

  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "0");
  url.searchParams.set("countrycodes", "us");

  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": nominatimUserAgent() },
    next: { revalidate: 60 * 60 * 24 * 30 },
  });

  if (!res.ok) return null;

  const rows = (await res.json()) as Array<{ lat?: string; lon?: string }>;
  const hit = rows[0];
  if (!hit) return null;

  return parseGeocodeResult({ lat: hit.lat, lng: hit.lon });
}

function cacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Geocode a listing address to WGS84 coordinates (OpenStreetMap Nominatim, cached). */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const rawQ = searchParams.get("q")?.trim() ?? "";
  const address = searchParams.get("address")?.trim() ?? "";
  const zip = searchParams.get("zip")?.trim() ?? "";
  const neighborhood = searchParams.get("neighborhood")?.trim() ?? "";
  const unitLabel = searchParams.get("unitLabel")?.trim() ?? "";

  const query =
    rawQ ||
    listingGeocodeQuery({ address, zip, neighborhood, unitLabel } satisfies Pick<
      MockProperty,
      "address" | "zip" | "neighborhood" | "unitLabel"
    >);

  if (!query || query.length < 4) {
    return NextResponse.json({ error: "A valid address query is required." }, { status: 400 });
  }

  if (!(await rateLimit(`geocode:${clientIpFrom(req)}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const key = cacheKey(query);
  const cached = geocodeCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(cached.coords, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  }

  try {
    const coords = await geocodeWithNominatim(query);
    if (!coords) {
      return NextResponse.json({ error: "Address could not be located." }, { status: 404 });
    }
    boundedCacheSet(geocodeCache, key, { coords, at: Date.now() });
    return NextResponse.json(coords, {
      headers: { "Cache-Control": "public, s-maxage=86400, stale-while-revalidate=604800" },
    });
  } catch {
    return NextResponse.json({ error: "Geocoding failed." }, { status: 502 });
  }
}
