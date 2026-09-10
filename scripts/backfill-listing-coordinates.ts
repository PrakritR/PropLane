/**
 * Replace the legacy Seattle placeholder coordinates on listing rows with the
 * real geocode of each listing's own address.
 *
 * An older wizard wrote one hardcoded Seattle pair onto every listing it made,
 * regardless of address. Nothing writes it any more, and `getNearbyTransit`
 * already detects that exact pair and geocodes the address instead, so the app
 * is correct today - but it means EVERY transit lookup spends a live Nominatim
 * call, and the public instance is rate-limited to roughly one request a second
 * and asks that servers not use it in bulk. Storing the true coordinates once
 * removes that dependency from the request path.
 *
 * Dry run by default:
 *   node --env-file=.env.staging.local --conditions=react-server --import tsx \
 *     scripts/backfill-listing-coordinates.ts
 *   …same command with --apply to write.
 *
 * Never runs against production listings without the captain's explicit opt-in,
 * and refuses the locked live listings outright even with it.
 */
import { createClient } from "@supabase/supabase-js";
import { listingGeocodeQuery } from "@/lib/geocode-address";
import { LEGACY_WIZARD_PLACEHOLDER_COORDS } from "@/lib/nearby-transit.server";
import { refuseProductionListingWrites } from "./lib/refuse-production-listing-writes.mjs";

const APPLY = process.argv.includes("--apply");
const NOMINATIM = process.env.NOMINATIM_PROVIDER_URL?.trim() || "https://nominatim.openstreetmap.org/search";
/** Nominatim's usage policy: at most one request per second from one client. */
const REQUEST_SPACING_MS = 1100;

/**
 * Locked live listings (AGENTS.md). Skipped before the production opt-in is even
 * consulted.
 *
 * Matched against the row id as well as the address: a unit number can live in
 * `unitLabel` rather than `address`, so an address-only check let
 * `mgr-seed-4709a-8th-ave-ne` through on the first dry run.
 */
const LOCKED_FRAGMENTS = ["5257 brooklyn", "5259 brooklyn", "4709a", "4709a 8th", "5257", "5259"];

type Row = {
  id: string;
  status: string | null;
  row_data: Record<string, unknown> | null;
  property_data: Record<string, unknown> | null;
};

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function isPlaceholderOrMissing(source: Record<string, unknown>): boolean {
  const lat = num(source.mapLat);
  const lng = num(source.mapLng);
  if (lat === null || lng === null) return true;
  return lat === LEGACY_WIZARD_PLACEHOLDER_COORDS.lat && lng === LEGACY_WIZARD_PLACEHOLDER_COORDS.lng;
}

function isLocked(id: string, source: Record<string, unknown>): boolean {
  const haystack = `${id} ${String(source.address ?? "")} ${String(source.unitLabel ?? "")}`.toLowerCase();
  return LOCKED_FRAGMENTS.some((fragment) => haystack.includes(fragment));
}

type GeocodeOutcome =
  | { kind: "ok"; lat: number; lng: number }
  | { kind: "miss" }
  | { kind: "imprecise"; detail: string };

/**
 * Only a building-level hit is worth storing.
 *
 * Nominatim happily answers a house-numbered query with the centroid of the
 * whole street, which can sit a long way from the actual home. Writing that
 * would be worse than leaving the placeholder: the placeholder is recognised
 * and re-geocoded on every lookup, so it self-corrects once an address is
 * fixed, whereas a stored coordinate is taken as authoritative forever.
 */
async function geocode(query: string, wantsHouseNumber: boolean): Promise<GeocodeOutcome> {
  const url = new URL(NOMINATIM);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("addressdetails", "1");
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "PropLane/1.0 (listing-coordinate-backfill)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return { kind: "miss" };
  const body = (await res.json()) as {
    lat?: string; lon?: string; addresstype?: string; address?: { house_number?: string };
  }[];
  const hit = Array.isArray(body) ? body[0] : undefined;
  const lat = num(hit?.lat);
  const lng = num(hit?.lon);
  if (lat === null || lng === null) return { kind: "miss" };
  if (wantsHouseNumber && !hit?.address?.house_number) {
    return { kind: "imprecise", detail: hit?.addresstype ?? "no house number in match" };
  }
  return { kind: "ok", lat, lng };
}

/** A street number in the listing's own address line. */
function hasHouseNumber(address: string): boolean {
  return /\d/.test(address.trim().split(/[,\s]/)[0] ?? "");
}

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  refuseProductionListingWrites(url, "backfill-listing-coordinates");
  const db = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

  const { data, error } = await db
    .from("manager_property_records")
    .select("id, status, row_data, property_data");
  if (error) throw error;

  let scanned = 0;
  let skippedLocked = 0;
  let noAddress = 0;
  let noMatch = 0;
  let imprecise = 0;
  let updated = 0;

  for (const raw of (data ?? []) as Row[]) {
    // Write back into whichever object the app reads - propertySource() prefers
    // property_data and falls back to row_data.
    const column = asObject(raw.property_data) ? "property_data" : "row_data";
    const source = asObject(raw.property_data) ?? asObject(raw.row_data);
    if (!source) continue;
    scanned += 1;

    if (!isPlaceholderOrMissing(source)) continue;
    if (isLocked(raw.id, source)) {
      console.log(`skip  ${raw.id} — locked live listing`);
      skippedLocked += 1;
      continue;
    }

    const query = listingGeocodeQuery({
      address: String(source.address ?? ""),
      zip: String(source.zip ?? ""),
      neighborhood: String(source.neighborhood ?? ""),
      unitLabel: String(source.unitLabel ?? ""),
      city: String(source.city ?? ""),
      state: String(source.state ?? ""),
    });
    if (!query) {
      console.log(`skip  ${raw.id} — no geocodable address (${raw.status})`);
      noAddress += 1;
      continue;
    }

    const outcome = await geocode(query, hasHouseNumber(String(source.address ?? "")));
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
    if (outcome.kind === "miss") {
      console.log(`MISS  ${raw.id} — "${query}" did not geocode`);
      noMatch += 1;
      continue;
    }
    if (outcome.kind === "imprecise") {
      console.log(`LOOSE ${raw.id} — "${query}" matched ${outcome.detail}, not a building; left alone`);
      imprecise += 1;
      continue;
    }
    const coords = { lat: outcome.lat, lng: outcome.lng };

    console.log(`${APPLY ? "write" : "would"} ${raw.id} -> ${coords.lat}, ${coords.lng}  (${query})`);
    if (!APPLY) continue;

    const next = { ...source, mapLat: coords.lat, mapLng: coords.lng };
    const { error: writeError } = await db
      .from("manager_property_records")
      .update({ [column]: next })
      .eq("id", raw.id);
    if (writeError) throw writeError;
    updated += 1;
  }

  console.log(
    `\nscanned ${scanned} · ${APPLY ? "updated" : "would update"} ${APPLY ? updated : "the rows above"} · ` +
      `locked ${skippedLocked} · no address ${noAddress} · no match ${noMatch} · imprecise ${imprecise}`,
  );
  if (!APPLY) console.log("Dry run. Re-run with --apply to write.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
