import { NextResponse } from "next/server";
import { rankNominatimAddressSuggestions, shapeNominatimSuggestQuery } from "@/lib/geocode-address";
import { boundedCacheSet, nominatimUserAgent, throttleNominatim } from "@/lib/nominatim.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const suggestCache = new Map<string, { suggestions: ReturnType<typeof rankNominatimAddressSuggestions>; at: number }>();

function cacheKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
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
    const searchQ = shapeNominatimSuggestQuery(q);
    url.searchParams.set("q", searchQ);
    url.searchParams.set("format", "json");
    url.searchParams.set("addressdetails", "1");
    // Raise the fetch limit so ranking has rows to pick from.
    url.searchParams.set("limit", "12");
    url.searchParams.set("countrycodes", "us");
    // Seattle viewbox is a preference only — never rewrite the query into ", Seattle, WA".
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
    const suggestions = rankNominatimAddressSuggestions(q, rows);
    boundedCacheSet(suggestCache, key, { suggestions, at: Date.now() });

    return NextResponse.json(
      { suggestions },
      { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } },
    );
  } catch {
    return NextResponse.json({ error: "Address lookup failed." }, { status: 502 });
  }
}
