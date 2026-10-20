import "server-only";

import { parseGeocodeResult, type GeocodeCoords } from "@/lib/geocode-address";
import { nominatimUserAgent, throttleNominatim } from "@/lib/nominatim.server";
import { createTtlCache } from "@/lib/server-ttl-cache";

/**
 * Server-side, ZIP-verified geocoding of ONE listing address for the public map pin.
 *
 * The free-text `/api/geocode?q=street, neighborhood, zip` path matched "4709A 8th Ave, 98105" in Westlake. This
 * uses Nominatim's STRUCTURED search and only accepts a street hit whose `address.postcode` is the listing's ZIP:
 *   (a) street + city + state + ZIP, postcode must match;
 *   (b) a house number with a letter suffix ("4709A") retries as the bare number ("4709");
 *   (c) else the ZIP's own centroid. Never a city centre when a ZIP exists;
 *   (d) no ZIP at all returns null, so the client keeps its own `/api/geocode` path.
 * A request failure throws and "nothing found" returns null; neither is cached (an address's coordinates do not
 * change, so a success is kept 30 days). Every call goes through the shared Nominatim queue and User-Agent.
 */

export type ListingGeocodeInput = {
  address?: string | null;
  zip?: string | null;
  city?: string | null;
  state?: string | null;
};

const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 7_000;
/** How long a page request waits for the pin before it ships without one. */
export const LISTING_GEOCODE_WAIT_MS = 2_500;

type NominatimRow = { lat?: string; lon?: string; address?: { postcode?: string } };

const cache = createTtlCache<GeocodeCoords>(CACHE_TTL_MS);

/** Test hook: drop every kept answer. */
export function clearListingGeocodeCache(): void {
  cache.clear();
}

function zip5(zip: string | null | undefined): string | null {
  const m = String(zip ?? "").trim().match(/^(\d{5})(?:-\d{4})?$/);
  return m ? m[1]! : null;
}

/** The street line without a unit ("APT 2", "#3"): a unit adds no geographic precision. */
function streetLine(address: string): string {
  return address
    .replace(/[,\s](?:apt|apartment|unit|ste|suite|#)\s*[\w-]+\s*$/i, "")
    .replace(/[,\s]+$/, "")
    .trim();
}

async function searchStructured(params: Record<string, string>): Promise<NominatimRow[]> {
  await throttleNominatim();
  const url = new URL(NOMINATIM_SEARCH_URL);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("limit", "5");
  const res = await fetch(url.toString(), {
    headers: { Accept: "application/json", "User-Agent": nominatimUserAgent() },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as NominatimRow[]) : [];
}

/** First row that parses to coordinates and sits in `zip`. */
function firstInZip(rows: NominatimRow[], zip: string, allowMissingPostcode: boolean): GeocodeCoords | null {
  for (const row of rows) {
    const postcode = row.address?.postcode?.trim().slice(0, 5);
    if (postcode ? postcode !== zip : !allowMissingPostcode) continue;
    const coords = parseGeocodeResult({ lat: row.lat, lng: row.lon });
    if (coords) return coords;
  }
  return null;
}

async function lookup(input: ListingGeocodeInput, zip: string): Promise<GeocodeCoords | null> {
  const city = input.city?.trim() ?? "";
  const state = input.state?.trim().toUpperCase() ?? "";
  const street = streetLine(input.address?.trim() ?? "");

  const attempts: string[] = [];
  if (street) {
    attempts.push(street);
    const suffixed = street.match(/^(\d+)[A-Za-z](?=\s)/);
    if (suffixed) attempts.push(street.replace(/^(\d+)[A-Za-z](?=\s)/, "$1"));
  }
  for (const attempt of attempts) {
    const rows = await searchStructured({ street: attempt, city, state, postalcode: zip });
    const hit = firstInZip(rows, zip, false);
    if (hit) return hit;
  }
  const centroid = await searchStructured({ postalcode: zip });
  return firstInZip(centroid, zip, true);
}

/** Coordinates for the listing, or null when none could be found (or there is no ZIP). Throws on a request failure. */
export async function geocodeListingAddress(input: ListingGeocodeInput): Promise<GeocodeCoords | null> {
  const zip = zip5(input.zip);
  if (!zip) return null;
  const key = [input.address ?? "", input.city ?? "", input.state ?? "", zip].join("|").toLowerCase().replace(/\s+/g, " ").trim();
  try {
    return await cache.get(key, async () => {
      const found = await lookup(input, zip);
      // Throwing keeps "not found" out of the cache; it is turned back into null below.
      if (!found) throw new NotFound();
      return found;
    });
  } catch (error) {
    if (error instanceof NotFound) return null;
    throw error;
  }
}

class NotFound extends Error {}

/**
 * {@link geocodeListingAddress} bounded for a page request: null on timeout or any failure. The lookup keeps
 * running past the timeout and fills the cache, so the next request has the pin.
 */
export async function geocodeListingAddressWithin(
  input: ListingGeocodeInput,
  ms: number = LISTING_GEOCODE_WAIT_MS,
): Promise<GeocodeCoords | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      geocodeListingAddress(input).catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
