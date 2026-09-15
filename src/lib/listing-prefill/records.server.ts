import "server-only";

/**
 * Property facts and a rent estimate by address, from RentCast.
 *
 * RentCast is the one provider in the Sep 2026 survey that is self-serve, has
 * a free development tier, and whose API terms allow storing and displaying
 * what it returns. Two calls per new address: `/properties` for the record and
 * `/avm/rent/long-term` for the estimate. Both are cached for 30 days by the
 * route, so a repeated address never bills twice.
 *
 * Without `RENTCAST_API_KEY` the feature stays dark (the card never appears).
 * `LISTING_PREFILL_PROVIDER=fixture` swaps in a deterministic local provider
 * for development and tests; it is refused on a production deployment.
 */

import type { AddressFacts, PrefillAddressInput, RentEstimate } from "./types";
import { prefillAddressLine } from "./types";

const RENTCAST_BASE = "https://api.rentcast.io/v1";
const TIMEOUT_MS = 8_000;

export type RecordsProviderKind = "rentcast" | "fixture" | null;

export function recordsProviderKind(): RecordsProviderKind {
  const explicit = (process.env.LISTING_PREFILL_PROVIDER ?? "").trim().toLowerCase();
  if (explicit === "fixture") {
    // A fixture on the live site would show made-up facts to real managers.
    if (process.env.VERCEL_ENV === "production") return null;
    return "fixture";
  }
  return process.env.RENTCAST_API_KEY?.trim() ? "rentcast" : null;
}

export type FactsLookup = { facts: AddressFacts | null; rent: RentEstimate | null };

export async function lookupAddressFacts(input: PrefillAddressInput): Promise<FactsLookup> {
  const kind = recordsProviderKind();
  if (kind === "fixture") return fixtureFacts(input);
  if (kind === "rentcast") return rentcastFacts(input);
  return { facts: null, rent: null };
}

/* ───────────────────────────── RentCast ───────────────────────────── */

type RentcastProperty = {
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  lotSize?: number;
  yearBuilt?: number;
  lastSaleDate?: string;
  features?: {
    floorCount?: number;
    garage?: boolean;
    garageSpaces?: number;
    pool?: boolean;
    cooling?: boolean;
    heating?: boolean;
    fireplace?: boolean;
  };
};

type RentcastRentAvm = {
  rent?: number;
  rentRangeLow?: number;
  rentRangeHigh?: number;
  comparables?: unknown[];
};

async function rentcastGet<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const key = process.env.RENTCAST_API_KEY?.trim();
  if (!key) return null;
  const url = new URL(`${RENTCAST_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "X-Api-Key": key, Accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    // 404 is RentCast's "no record for that address" — a real answer, not a failure.
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`RentCast ${path} answered ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** RentCast's property types → the wizard's tiles. Unknown kinds become "other", never a guess. */
export function mapRentcastPropertyType(raw: string | undefined): AddressFacts["propertyType"] {
  const t = (raw ?? "").trim().toLowerCase();
  if (!t) return null;
  if (t.includes("single family")) return "house";
  if (t.includes("townhouse") || t.includes("town house")) return "townhouse";
  if (t.includes("condo")) return "condo";
  if (t.includes("apartment")) return "apartment";
  if (t.includes("multi")) return "duplex";
  return "other";
}

/** Record booleans → the house-wide amenity labels the wizard stores verbatim. */
export function amenitiesFromRecordFeatures(f: RentcastProperty["features"] | undefined): string[] {
  const out: string[] = [];
  if (!f) return out;
  if (f.heating) out.push("Heating");
  if (f.cooling) out.push("Air conditioning");
  if (f.garage || (f.garageSpaces ?? 0) > 0) out.push("Garage parking");
  return out;
}

export function hasAnyFact(f: AddressFacts): boolean {
  return Boolean(f.propertyType || f.bedrooms || f.bathrooms || f.squareFeet || f.yearBuilt || f.lotSquareFeet || f.floors || f.amenities.length);
}

function positive(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export function factsFromRentcastProperty(p: RentcastProperty): AddressFacts {
  const sale = typeof p.lastSaleDate === "string" ? Number(p.lastSaleDate.slice(0, 4)) : NaN;
  return {
    propertyType: mapRentcastPropertyType(p.propertyType),
    bedrooms: positive(p.bedrooms) ? Math.round(p.bedrooms as number) : null,
    bathrooms: positive(p.bathrooms),
    squareFeet: positive(p.squareFootage) ? Math.round(p.squareFootage as number) : null,
    yearBuilt: positive(p.yearBuilt) && (p.yearBuilt as number) > 1600 ? Math.round(p.yearBuilt as number) : null,
    lotSquareFeet: positive(p.lotSize) ? Math.round(p.lotSize as number) : null,
    floors: positive(p.features?.floorCount) ? Math.round(p.features!.floorCount as number) : null,
    lastSaleYear: Number.isFinite(sale) && sale > 1900 ? sale : null,
    amenities: amenitiesFromRecordFeatures(p.features),
  };
}

async function rentcastFacts(input: PrefillAddressInput): Promise<FactsLookup> {
  const address = prefillAddressLine(input);
  const [properties, avm] = await Promise.all([
    rentcastGet<RentcastProperty[] | RentcastProperty>("/properties", { address }),
    rentcastGet<RentcastRentAvm>("/avm/rent/long-term", { address }).catch(() => null),
  ]);
  const record = Array.isArray(properties) ? properties[0] : properties;
  const parsed = record ? factsFromRentcastProperty(record) : null;
  // A record that carries no facts at all (commercial parcels, some condos) is
  // "nothing on record", not a found home with blank chips.
  const facts = parsed && hasAnyFact(parsed) ? parsed : null;
  const rent =
    avm && positive(avm.rent)
      ? {
          rentUsd: Math.round(avm.rent as number),
          lowUsd: positive(avm.rentRangeLow) ? Math.round(avm.rentRangeLow as number) : null,
          highUsd: positive(avm.rentRangeHigh) ? Math.round(avm.rentRangeHigh as number) : null,
          comparables: Array.isArray(avm.comparables) ? avm.comparables.length : null,
        }
      : null;
  return { facts, rent };
}

/* ───────────────────────────── fixture ───────────────────────────── */

/**
 * Deterministic facts for development and end-to-end proof. Derived from the
 * street text so the same address always answers the same way; a street
 * containing "nowhere" answers "no record", which is the not-found path.
 */
export function fixtureFacts(input: PrefillAddressInput): FactsLookup {
  const street = input.address.trim().toLowerCase();
  if (!street || street.includes("nowhere")) return { facts: null, rent: null };
  let h = 7;
  for (const ch of street) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const beds = 2 + (h % 3); // 2–4
  const baths = [1, 1.5, 2, 2.5][h % 4]!;
  const sqft = 900 + (h % 14) * 100;
  const year = 1920 + (h % 100);
  const floors = 1 + (h % 2);
  const rent = 1_900 + (h % 16) * 100;
  return {
    facts: {
      propertyType: (["house", "townhouse", "condo"] as const)[h % 3],
      bedrooms: beds,
      bathrooms: baths,
      squareFeet: sqft,
      yearBuilt: year,
      lotSquareFeet: 3_600 + (h % 30) * 100,
      floors,
      lastSaleYear: 2010 + (h % 15),
      amenities: ["Heating", ...(h % 2 ? ["Air conditioning"] : []), ...(h % 3 ? ["Garage parking"] : [])],
    },
    rent: { rentUsd: rent, lowUsd: rent - 250, highUsd: rent + 250, comparables: 8 + (h % 12) },
  };
}
