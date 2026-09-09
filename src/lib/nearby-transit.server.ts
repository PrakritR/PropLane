import "server-only";

import { listingGeocodeQuery, parseGeocodeResult, type GeocodeCoords } from "@/lib/geocode-address";
import { boundedCacheSet, nominatimUserAgent, throttleNominatim } from "@/lib/nominatim.server";

export type TransitMode = "bart" | "bus" | "public_transit";
export type NearbyTransitStop = { name: string; mode: "bart" | "bus" | "rail"; distanceMiles: number };
export type NearbyTransitResult = {
  verified: boolean;
  source: "OpenStreetMap";
  sourceUrl: typeof OSM_ATTRIBUTION_URL;
  fetchedAt: string;
  searchRadiusMeters: number;
  distanceKind: "straight_line";
  stops: NearbyTransitStop[];
  error?: "location_unavailable" | "provider_unavailable" | "unverified_response";
};

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const OSM_ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";
const RADIUS_METERS = 3200;
// A verified 3.2 km lookup in central San Francisco contains about 2,500
// mapped bus elements and exceeds 1 MB. Keep a finite cap without rejecting
// that ordinary dense-city response before the nearest-stop filter runs.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const POSITIVE_TTL = 24 * 60 * 60 * 1000;
const NEGATIVE_TTL = 12 * 60 * 1000;
const FAILURE_TTL = 45 * 1000;
const cache = new Map<string, { at: number; ttl: number; value: NearbyTransitResult }>();
const inflight = new Map<string, Promise<NearbyTransitResult>>();
const geocodeCache = new Map<string, { at: number; value: GeocodeCoords | null }>();
const geocodeInflight = new Map<string, Promise<GeocodeCoords | null>>();
let overpassTail: Promise<void> = Promise.resolve();
let overpassQueued = 0;

async function withOverpassSlot<T>(work: () => Promise<T>): Promise<T> {
  if (overpassQueued >= 3) throw new Error("overpass_queue_full");
  overpassQueued += 1;
  const prior = overpassTail;
  let release!: () => void;
  overpassTail = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try { return await work(); }
  finally {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    overpassQueued -= 1;
    release();
  }
}

function validCoords(value: unknown): GeocodeCoords | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { lat?: unknown; lng?: unknown };
  if (raw.lat === null || raw.lat === undefined || raw.lng === null || raw.lng === undefined) return null;
  if (String(raw.lat).trim() === "" || String(raw.lng).trim() === "") return null;
  return parseGeocodeResult(value);
}

function providerEndpoint(envName: "NOMINATIM_PROVIDER_URL" | "OVERPASS_PROVIDER_URL", localDefault: string): string | null {
  const configured = process.env[envName]?.trim() ?? "";
  if (!configured && (process.env.VERCEL || process.env.NODE_ENV === "production")) return null;
  try {
    const url = new URL(configured || localDefault);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}

async function jsonResponse(res: Response): Promise<unknown | null> {
  if (!res.ok || !res.headers.get("content-type")?.toLowerCase().includes("application/json")) return null;
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!res.body) return null;
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch { return null; }
}

async function geocode(source: Record<string, unknown>): Promise<GeocodeCoords | null> {
  const street = String(source.address ?? "").trim();
  const zip = String(source.zip ?? "").trim();
  const city = String(source.city ?? "").trim();
  const state = String(source.state ?? "").trim();
  if (!street || (!zip && !(city && state))) return null;
  const query = listingGeocodeQuery({
    address: String(source.address ?? ""), zip: String(source.zip ?? ""),
    neighborhood: String(source.neighborhood ?? ""), unitLabel: String(source.unitLabel ?? ""),
    city: String(source.city ?? ""), state: String(source.state ?? ""),
  });
  if (!query) return null;
  const key = query.toLowerCase().replace(/\s+/g, " ");
  const cached = geocodeCache.get(key);
  if (cached && Date.now() - cached.at < (cached.value ? POSITIVE_TTL : NEGATIVE_TTL)) return cached.value;
  const pending = geocodeInflight.get(key); if (pending) return pending;
  const task = (async () => {
    try {
      await throttleNominatim();
      const endpoint = providerEndpoint("NOMINATIM_PROVIDER_URL", NOMINATIM_URL);
      if (!endpoint) return null;
      const url = new URL(endpoint);
      url.searchParams.set("q", query); url.searchParams.set("format", "json");
      url.searchParams.set("limit", "1"); url.searchParams.set("countrycodes", "us");
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": nominatimUserAgent() }, redirect: "error", signal: AbortSignal.timeout(7000) });
      const body = await jsonResponse(res);
      const hit = Array.isArray(body) ? body[0] as { lat?: unknown; lon?: unknown } | undefined : undefined;
      const value = hit ? validCoords({ lat: hit.lat, lng: hit.lon }) : null;
      boundedCacheSet(geocodeCache, key, { at: Date.now(), value }, 500); return value;
    } finally { geocodeInflight.delete(key); }
  })();
  geocodeInflight.set(key, task); return task;
}

function radians(n: number) { return n * Math.PI / 180; }
function miles(a: GeocodeCoords, b: GeocodeCoords): number {
  const dLat = radians(b.lat - a.lat); const dLng = radians(b.lng - a.lng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function parseOverpassTransit(value: unknown, origin: GeocodeCoords, mode: TransitMode): NearbyTransitStop[] | null {
  if (!value || typeof value !== "object" || typeof (value as { remark?: unknown }).remark === "string" || !Array.isArray((value as { elements?: unknown }).elements)) return null;
  const out = new Map<string, NearbyTransitStop & { rawDistance: number }>();
  for (const raw of (value as { elements: unknown[] }).elements) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as { lat?: unknown; lon?: unknown; center?: { lat?: unknown; lon?: unknown }; tags?: Record<string, unknown> };
    const coords = validCoords({ lat: row.lat ?? row.center?.lat, lng: row.lon ?? row.center?.lon });
    const tags = row.tags && typeof row.tags === "object" ? row.tags : {};
    const name = typeof tags.name === "string" ? tags.name.trim() : "";
    if (!coords || !name) continue;
    const railway = String(tags.railway ?? "").toLowerCase();
    const publicTransport = String(tags.public_transport ?? "").toLowerCase();
    const highway = String(tags.highway ?? "").toLowerCase();
    const network = `${String(tags.network ?? "")} ${String(tags.operator ?? "")}`.toLowerCase();
    const railMode = ["train", "subway", "light_rail", "tram"].some((key) => String(tags[key] ?? "").toLowerCase() === "yes");
    const railEvidence = ["station", "halt", "tram_stop"].includes(railway) ||
      (["station", "platform", "stop_position"].includes(publicTransport) && railMode);
    const bartStationEvidence = railway === "station" || publicTransport === "station" || railEvidence;
    const isBart = /(^|\W)bart(\W|$)|bay area rapid transit/.test(network) && bartStationEvidence;
    const isBus = highway === "bus_stop" || String(tags.bus ?? "").toLowerCase() === "yes" || String(tags.route ?? "").toLowerCase() === "bus";
    const kind: NearbyTransitStop["mode"] | null = isBart ? "bart" : isBus ? "bus" : railEvidence ? "rail" : null;
    if (!kind || (mode === "bart" && kind !== "bart") || (mode === "bus" && kind !== "bus")) continue;
    const rawDistance = miles(origin, coords);
    if (rawDistance * 1609.344 > RADIUS_METERS) continue;
    const distanceMiles = Number(rawDistance.toFixed(2));
    const key = `${name.toLowerCase()}:${kind}`;
    const prior = out.get(key);
    if (!prior || rawDistance < prior.rawDistance) out.set(key, { name, mode: kind, distanceMiles, rawDistance });
  }
  return [...out.values()].sort((a, b) => a.rawDistance - b.rawDistance).slice(0, 5)
    .map((stop) => ({ name: stop.name, mode: stop.mode, distanceMiles: stop.distanceMiles }));
}

function baseResult(): Pick<NearbyTransitResult, "source" | "sourceUrl" | "fetchedAt" | "searchRadiusMeters" | "distanceKind"> {
  return { source: "OpenStreetMap", sourceUrl: OSM_ATTRIBUTION_URL, fetchedAt: new Date().toISOString(), searchRadiusMeters: RADIUS_METERS, distanceKind: "straight_line" };
}

export async function getNearbyTransit(source: Record<string, unknown>, mode: TransitMode): Promise<NearbyTransitResult> {
  const stored = validCoords({ lat: source.mapLat, lng: source.mapLng });
  if (!stored && !providerEndpoint("NOMINATIM_PROVIDER_URL", NOMINATIM_URL)) {
    return { verified: false, ...baseResult(), stops: [], error: "provider_unavailable" };
  }
  let origin = stored;
  if (!origin) { try { origin = await geocode(source); } catch { origin = null; } }
  if (!origin) return { verified: false, ...baseResult(), stops: [], error: "location_unavailable" };
  const key = `v1:${origin.lat.toFixed(5)}:${origin.lng.toFixed(5)}:${mode}`;
  const hit = cache.get(key); if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const pending = inflight.get(key); if (pending) return pending;
  const task = (async () => {
    const selectors = mode === "bus"
      ? ['["highway"="bus_stop"]', '["bus"="yes"]']
      : mode === "bart"
        ? ['["railway"="station"]', '["public_transport"="station"]', '["public_transport"="platform"]']
        : ['["public_transport"]', '["highway"="bus_stop"]', '["railway"="station"]', '["railway"="halt"]', '["railway"="tram_stop"]'];
    const q = `[out:json][timeout:8][maxsize:33554432];(${selectors.map((selector) => `nwr(around:${RADIUS_METERS},${origin.lat},${origin.lng})${selector};`).join("")});out center tags;`;
    try {
      const endpoint = providerEndpoint("OVERPASS_PROVIDER_URL", OVERPASS_URL);
      if (!endpoint) throw new Error("overpass_not_configured");
      const body = await withOverpassSlot(async () => {
        const res = await fetch(endpoint, { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": nominatimUserAgent() }, body: new URLSearchParams({ data: q }), redirect: "error", signal: AbortSignal.timeout(10_000) });
        return jsonResponse(res);
      });
      const parsed = parseOverpassTransit(body, origin, mode);
      const value: NearbyTransitResult = parsed === null
        ? { verified: false, ...baseResult(), stops: [], error: "unverified_response" }
        : { verified: true, ...baseResult(), stops: parsed };
      boundedCacheSet(cache, key, { at: Date.now(), ttl: parsed === null ? FAILURE_TTL : parsed.length ? POSITIVE_TTL : NEGATIVE_TTL, value }, 500);
      return value;
    } catch {
      const value: NearbyTransitResult = { verified: false, ...baseResult(), stops: [], error: "provider_unavailable" };
      boundedCacheSet(cache, key, { at: Date.now(), ttl: FAILURE_TTL, value }, 500); return value;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, task); return task;
}

export function __resetNearbyTransitCache() { cache.clear(); inflight.clear(); geocodeCache.clear(); geocodeInflight.clear(); overpassTail = Promise.resolve(); overpassQueued = 0; }
