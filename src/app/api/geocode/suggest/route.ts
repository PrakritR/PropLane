import { NextResponse } from "next/server";
import { parseNominatimAddressSuggestions } from "@/lib/geocode-address";
import { boundedCacheSet, nominatimUserAgent, throttleNominatim } from "@/lib/nominatim.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const suggestCache = new Map<string, { suggestions: ReturnType<typeof parseNominatimAddressSuggestions>; at: number }>();

function cacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Bias short street-only queries toward the Seattle metro (PropPlane's primary market). */
function nominatimQuery(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return trimmed;
  const hasRegion = /,\s*[A-Z]{2}\b/i.test(trimmed) || /\b(wa|washington|seattle)\b/i.test(trimmed);
  const looksLikeStreet = /\d/.test(trimmed) && !hasRegion;
  return looksLikeStreet ? `${trimmed}, Seattle, WA` : trimmed;
}

/** Address autocomplete for listing create (OpenStreetMap Nominatim). */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 4) {
    return NextResponse.json({ suggestions: [] });
  }

  if (!(await rateLimit(`geocode-suggest:${clientIpFrom(req)}`, 30, 60_000)).ok) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }

  const key = cacheKey(q);
  const cached = suggestCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return NextResponse.json(
      { suggestions: cached.suggestions },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  }

  try {
    await throttleNominatim();

    const url = new URL("https://nominatim.openstreetmap.org/search");
    const searchQ = nominatimQuery(q);
    url.searchParams.set("q", searchQ);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "6");
    url.searchParams.set("countrycodes", "us");
    // Prefer greater Seattle when the query is ambiguous.
    url.searchParams.set("viewbox", "-122.55,47.38,-122.15,47.78");
    url.searchParams.set("bounded", "0");

    const res = await fetch(url.toString(), {
      headers: { Accept: "application/json", "User-Agent": nominatimUserAgent() },
      next: { revalidate: 60 * 60 },
    });

    if (!res.ok) {
      return NextResponse.json({ error: "Address lookup failed." }, { status: 502 });
    }

    const rows = (await res.json()) as unknown;
    const suggestions = parseNominatimAddressSuggestions(rows);
    boundedCacheSet(suggestCache, key, { suggestions, at: Date.now() });

    return NextResponse.json(
      { suggestions },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch {
    return NextResponse.json({ error: "Address lookup failed." }, { status: 502 });
  }
}
