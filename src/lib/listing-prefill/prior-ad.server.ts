import "server-only";

/**
 * Point at an earlier public ad for an address — never read it.
 *
 * One search-index query (Tavily) per new address. We keep only hits on known
 * rental sites whose title or snippet carries the street number, and return
 * the site, title, date, snippet and link so the wizard can say "Your
 * Craigslist ad from Aug 12?". The listing page itself is never fetched: every
 * listing site forbids automated reads (docs/agents/listing-prefill.md), so
 * the ad's words only ever arrive by the manager pasting them.
 *
 * Without `TAVILY_API_KEY` this quietly returns no match. The fixture provider
 * (see records.server.ts) returns a match for any street with a number.
 */

import type { PrefillAddressInput, PriorAdMatch } from "./types";
import { recordsProviderKind } from "./records.server";

const TIMEOUT_MS = 6_000;

const RENTAL_SITES: Array<{ host: string; label: string }> = [
  { host: "craigslist.org", label: "Craigslist" },
  { host: "zillow.com", label: "Zillow" },
  { host: "trulia.com", label: "Trulia" },
  { host: "hotpads.com", label: "HotPads" },
  { host: "apartments.com", label: "Apartments.com" },
  { host: "realtor.com", label: "Realtor.com" },
  { host: "redfin.com", label: "Redfin" },
  { host: "zumper.com", label: "Zumper" },
  { host: "facebook.com", label: "Facebook" },
  { host: "rent.com", label: "Rent." },
  { host: "apartmentguide.com", label: "ApartmentGuide" },
];

type TavilyResult = { title?: string; url?: string; content?: string; published_date?: string };

export function siteLabelForUrl(url: string): string | null {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const hit = RENTAL_SITES.find((s) => host === s.host || host.endsWith(`.${s.host}`));
  return hit?.label ?? null;
}

/** "$2,700/mo", "$2700 per month", "2,700/month" → 2700. */
export function rentFromText(text: string): number | null {
  const m = text.match(/\$\s?(\d{1,2}(?:,\d{3})|\d{3,5})(?!\d)/);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) && n >= 300 && n <= 50_000 ? n : null;
}

function streetNumber(address: string): string | null {
  const m = address.trim().match(/^(\d+[A-Za-z]?)\b/);
  return m ? m[1]! : null;
}

export function pickPriorAd(address: PrefillAddressInput, results: TavilyResult[]): PriorAdMatch | null {
  const number = streetNumber(address.address);
  const streetWords = address.address.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  for (const r of results) {
    if (!r.url || !r.title) continue;
    const site = siteLabelForUrl(r.url);
    if (!site) continue;
    const hay = `${r.title} ${r.content ?? ""}`.toLowerCase();
    if (number && !hay.includes(number.toLowerCase())) continue;
    if (!streetWords.some((w) => hay.includes(w))) continue;
    return {
      site,
      title: r.title.trim().slice(0, 160),
      url: r.url,
      snippet: (r.content ?? "").trim().slice(0, 300),
      postedAt: r.published_date && !Number.isNaN(Date.parse(r.published_date)) ? new Date(r.published_date).toISOString() : null,
      listedRentUsd: rentFromText(`${r.title} ${r.content ?? ""}`),
    };
  }
  return null;
}

export async function findPriorAd(input: PrefillAddressInput): Promise<PriorAdMatch | null> {
  if (recordsProviderKind() === "fixture") return fixturePriorAd(input);
  const key = process.env.TAVILY_API_KEY?.trim();
  if (!key) return null;
  const query = `"${input.address.trim()}" ${input.city.trim()} ${input.state.trim()} for rent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: 8,
        search_depth: "basic",
        include_domains: RENTAL_SITES.map((s) => s.host),
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: TavilyResult[] };
    return pickPriorAd(input, data.results ?? []);
  } catch {
    // A search that fails only costs the "we found your ad" nudge; facts still fill.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function fixturePriorAd(input: PrefillAddressInput): PriorAdMatch | null {
  const street = input.address.trim();
  if (!streetNumber(street) || street.toLowerCase().includes("nowhere") || street.toLowerCase().includes("quiet")) return null;
  const rent = 1_900 + (street.length % 9) * 100;
  return {
    site: "Craigslist",
    title: `Sunny ${street} home with a yard`,
    url: `https://seattle.craigslist.org/see/apa/d/${encodeURIComponent(street.toLowerCase().replace(/\s+/g, "-"))}/0000000000.html`,
    snippet: `${street}, ${input.city || "Seattle"}. Bright home on a quiet street. $${rent.toLocaleString("en-US")}/mo.`,
    postedAt: "2026-08-12T00:00:00.000Z",
    listedRentUsd: rent,
  };
}
