import type { MockProperty } from "@/data/types";
import { US_STATE_ABBREVS } from "@/app/(public)/rent/apply/apply-validation";

export type GeocodeCoords = { lat: number; lng: number };

export type AddressSuggestion = {
  id: string;
  label: string;
  address: string;
  zip: string;
  neighborhood: string;
  city: string;
  state: string;
  lat: number | null;
  lng: number | null;
};

type NominatimAddressParts = {
  house_number?: string;
  road?: string;
  pedestrian?: string;
  neighbourhood?: string;
  suburb?: string;
  city_district?: string;
  quarter?: string;
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  municipality?: string;
  county?: string;
  state?: string;
  "ISO3166-2-lvl4"?: string;
  postcode?: string;
  building?: string;
};

export type NominatimSearchHit = {
  place_id?: number | string;
  display_name?: string;
  lat?: string;
  lon?: string;
  class?: string;
  type?: string;
  address?: NominatimAddressParts;
};

const STREET_TYPE_ALIASES: Record<string, string> = {
  st: "street",
  street: "street",
  ave: "avenue",
  avenue: "avenue",
  av: "avenue",
  rd: "road",
  road: "road",
  blvd: "boulevard",
  boulevard: "boulevard",
  pkwy: "parkway",
  parkway: "parkway",
  dr: "drive",
  drive: "drive",
  ln: "lane",
  lane: "lane",
  ct: "court",
  court: "court",
  ter: "terrace",
  terrace: "terrace",
  pl: "place",
  place: "place",
  cir: "circle",
  circle: "circle",
  hwy: "highway",
  highway: "highway",
  way: "way",
  trl: "trail",
  trail: "trail",
};

const DIRECTION_ALIASES: Record<string, string> = {
  n: "north",
  north: "north",
  s: "south",
  south: "south",
  e: "east",
  east: "east",
  w: "west",
  west: "west",
  ne: "northeast",
  northeast: "northeast",
  nw: "northwest",
  northwest: "northwest",
  se: "southeast",
  southeast: "southeast",
  sw: "southwest",
  southwest: "southwest",
};

const STREET_TYPES = new Set(Object.values(STREET_TYPE_ALIASES));
const DIRECTIONS = new Set(Object.values(DIRECTION_ALIASES));
const DROP_TOKENS = new Set(["usa", "united", "states", "the", "of"]);
const ADMIN_NOMINATIM_TYPES = new Set([
  "city",
  "county",
  "state",
  "administrative",
  "town",
  "village",
  "municipality",
  "province",
  "region",
  "suburb",
]);

function normalizeSuggestToken(token: string): string {
  const lower = token.toLowerCase();
  return STREET_TYPE_ALIASES[lower] ?? DIRECTION_ALIASES[lower] ?? lower;
}

function splitSuggestTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(normalizeSuggestToken)
    .filter((token) => token.length > 0 && !DROP_TOKENS.has(token));
}

/** House numbers like 123 / 4709a — not ordinal street names (15th, 22nd). */
function isHouseNumberToken(token: string): boolean {
  return /^\d+[a-z]?$/.test(token) && !/(?:st|nd|rd|th)$/.test(token);
}

type SuggestQueryTokens = {
  house: string | null;
  road: string[];
  hasDigits: boolean;
};

function parseSuggestQueryTokens(text: string): SuggestQueryTokens {
  const tokens = splitSuggestTokens(text);
  let house: string | null = null;
  const road: string[] = [];
  for (const token of tokens) {
    if (house === null && isHouseNumberToken(token)) {
      house = token;
      continue;
    }
    if (STREET_TYPES.has(token) || DIRECTIONS.has(token)) continue;
    road.push(token);
  }
  return { house, road, hasDigits: /\d/.test(text) };
}

function suggestionStreetText(suggestion: AddressSuggestion, hit: NominatimSearchHit): string {
  const parts = hit.address ?? {};
  const road = firstNonEmpty(parts.road, parts.pedestrian);
  const house = parts.house_number?.trim() ?? "";
  const structured = house && road ? `${house} ${road}` : firstNonEmpty(road, house);
  return structured || suggestion.address;
}

function isAdminOnlyHit(hit: NominatimSearchHit, suggestion: AddressSuggestion): boolean {
  const parts = hit.address ?? {};
  const hasStreet = Boolean(
    parts.road?.trim() || parts.pedestrian?.trim() || parts.house_number?.trim() || parts.building?.trim(),
  );
  const cls = (hit.class ?? "").toLowerCase();
  const typ = (hit.type ?? "").toLowerCase();
  if (hasStreet) return false;
  if (cls === "place" || ADMIN_NOMINATIM_TYPES.has(typ)) return true;
  const city = suggestion.city.trim().toLowerCase();
  const addr = suggestion.address.trim().toLowerCase();
  return !addr || addr === city;
}

function scoreAddressSuggestion(
  query: SuggestQueryTokens,
  suggestion: AddressSuggestion,
  hit: NominatimSearchHit,
): number | null {
  if (query.hasDigits && isAdminOnlyHit(hit, suggestion)) return null;

  const streetText = suggestionStreetText(suggestion, hit);
  const street = parseSuggestQueryTokens(streetText);
  const roadOverlap = query.road.filter((token) => street.road.includes(token));
  const houseMatch = Boolean(query.house && street.house && query.house === street.house);

  if (query.road.length > 0 && roadOverlap.length === 0) return null;
  if (query.road.length === 0 && query.house && !houseMatch) return null;
  if (query.road.length === 0 && !query.house && splitSuggestTokens(streetText).length === 0) return null;

  let score = roadOverlap.length * 20;
  if (houseMatch) score += 100;
  if (houseMatch && roadOverlap.length > 0) score += 50;
  return score;
}

/** Normalize the typed query for Nominatim — do not rewrite it into a Seattle street. */
export function shapeNominatimSuggestQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Filter and rank Nominatim hits: house-number + road overlap first; drop
 * city/county/state rows when the query has digits; drop streets that share
 * no tokens with what the applicant typed.
 */
export function rankNominatimAddressSuggestions(query: string, rows: unknown): AddressSuggestion[] {
  if (!Array.isArray(rows)) return [];
  const parsedQuery = parseSuggestQueryTokens(query);
  const scored: { suggestion: AddressSuggestion; score: number }[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const hit = row as NominatimSearchHit;
    const parsed = parseNominatimAddressSuggestion(hit);
    if (!parsed) continue;
    const key = `${parsed.address}|${parsed.zip}|${parsed.neighborhood}`.toLowerCase();
    if (seen.has(key)) continue;
    const score = scoreAddressSuggestion(parsedQuery, parsed, hit);
    if (score === null) continue;
    seen.add(key);
    scored.push({ suggestion: parsed, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((row) => row.suggestion);
}

/** Build a stable geocoding query from listing address fields. */
export function listingGeocodeQuery(
  property: Pick<MockProperty, "address" | "zip" | "neighborhood" | "unitLabel"> & {
    city?: string;
    state?: string;
  },
): string {
  const street = property.address?.trim() ?? "";
  const unit = property.unitLabel?.trim() ?? "";
  const neighborhood = property.neighborhood?.trim() ?? "";
  const city = property.city?.trim() ?? "";
  const state = property.state?.trim().toUpperCase() ?? "";
  const zip = property.zip?.trim() ?? "";

  // Deliberately DROP the unit from the geocode query. A unit is inside the same
  // building, so it adds no geographic precision, but "APT 211" / "#3" is not a
  // geocodable token and measurably degrades the match - Nominatim either misses
  // or returns a lower-confidence centroid. Strip a unit already embedded in the
  // street line for the same reason; the unit is still shown in the UI.
  // Match a SINGLE leading separator (`[,\s]`, not `[,\s]+`) before the unit
  // token: the immediately-following `.replace(/[,\s]+$/, "")` strips any extra
  // trailing separators the same way, so the final output is identical while the
  // regex stays linear-time (the `[,\s]+` variant backtracks polynomially on a
  // long run of whitespace — CodeQL js/polynomial-redos).
  const streetLine = (street || unit)
    .replace(/[,\s](?:apt|apartment|unit|ste|suite|#)\s*[\w-]+\s*$/i, "")
    .replace(/[,\s]+$/, "")
    .trim() || street;

  const location =
    city && state ? `${city}, ${state}` : city || neighborhood;

  const parts = [streetLine, location, zip].filter(Boolean);
  if (!parts.length) return "";

  const query = parts.join(", ");
  if (/^\d{5}(-\d{4})?$/.test(zip) && !/\b(usa|united states)\b/i.test(query)) {
    return `${query}, USA`;
  }
  return query;
}

export function parseGeocodeResult(value: unknown): GeocodeCoords | null {
  if (!value || typeof value !== "object") return null;
  const lat = Number((value as { lat?: unknown }).lat);
  const lng = Number((value as { lng?: unknown }).lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat, lng };
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function parseNominatimState(parts: NominatimAddressParts): string {
  const iso = parts["ISO3166-2-lvl4"]?.trim() ?? "";
  const isoMatch = iso.match(/^US-([A-Z]{2})$/i);
  if (isoMatch) return isoMatch[1]!.toUpperCase();

  const raw = parts.state?.trim() ?? "";
  if (/^[A-Za-z]{2}$/.test(raw)) {
    const abbrev = raw.toUpperCase();
    return US_STATE_ABBREVS.has(abbrev) ? abbrev : "";
  }
  return "";
}

/** Map a Nominatim search hit into listing address fields. */
export function parseNominatimAddressSuggestion(hit: NominatimSearchHit): AddressSuggestion | null {
  const parts = hit.address ?? {};
  const road = firstNonEmpty(parts.road, parts.pedestrian);
  const house = parts.house_number?.trim() ?? "";
  const street = house && road ? `${house} ${road}` : firstNonEmpty(road, house);
  const city = firstNonEmpty(parts.city, parts.town, parts.village, parts.hamlet, parts.municipality);
  const state = parseNominatimState(parts);
  const neighborhood = firstNonEmpty(
    parts.neighbourhood,
    parts.suburb,
    parts.city_district,
    parts.quarter,
    city,
  );
  const zip = (parts.postcode?.trim() ?? "").replace(/\s+/g, "").slice(0, 10);
  const label = hit.display_name?.trim() || [street, neighborhood, city, zip].filter(Boolean).join(", ");
  if (!street && !label) return null;

  const coords = parseGeocodeResult({ lat: hit.lat, lng: hit.lon });
  const id = String(hit.place_id ?? label);

  return {
    id,
    label,
    address: street || label.split(",")[0]?.trim() || "",
    zip,
    neighborhood,
    city,
    state,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
  };
}

export function parseNominatimAddressSuggestions(value: unknown): AddressSuggestion[] {
  if (!Array.isArray(value)) return [];
  const out: AddressSuggestion[] = [];
  const seen = new Set<string>();
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const parsed = parseNominatimAddressSuggestion(row as NominatimSearchHit);
    if (!parsed) continue;
    const key = `${parsed.address}|${parsed.zip}|${parsed.neighborhood}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}
