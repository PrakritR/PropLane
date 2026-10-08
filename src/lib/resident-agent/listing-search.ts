/**
 * The resident personal agent's housing search: a pure function over PUBLIC listings.
 *
 * Its input is what `getPublicListings()` returns (already run through `publicListingProjection`, the
 * explicit allowlist both anonymous readers share), and its output is a second, narrower allowlist: a
 * card of facts a browse page already shows. Nothing private can be added here by accident because a
 * card is built field by field, never by spreading a listing. In particular it carries no manager
 * id, phone, email or workspace: who a listing routes to is re-derived on the server from the
 * listing id at request time (see `resolvePublicListing`), never offered to the model.
 */
import type { MockProperty } from "@/data/types";
import { filterRoomListings } from "@/lib/room-listings-catalog";
import { resolveAllowedLeaseTerms } from "@/lib/manager-listing-submission";
import { AIRBNB_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

export type ResidentListingFilters = {
  /** Neighborhood, street, city or ZIP text. Every word must appear in the listing's public location. */
  area?: string;
  /** Bedrooms in the home. 0 is a studio; 3 means three or more. */
  beds?: number;
  /** Highest monthly rent in whole dollars. */
  maxRent?: number;
  /** Desired move-in as YYYY-MM-DD. */
  moveInDate?: string;
  /** Stay length the resident wants. */
  term?: "short" | "long";
};

/** Exactly the public facts the agent may state about a listing. */
export type ResidentListingCard = {
  listingId: string;
  name: string;
  address: string;
  neighborhood: string;
  zip: string;
  beds: number;
  baths: number;
  /** Lowest monthly-equivalent rent among the rooms that matched, or null when none is published. */
  fromRent: number | null;
  availability: string;
  roomsMatching: number;
  petFriendly: boolean;
  /** Lease types the listing publishes, empty when it publishes none. */
  leaseTerms: string[];
};

export type ResidentListingSearchResult = {
  cards: ResidentListingCard[];
  /** How many listings matched before the result cap. */
  matched: number;
  /** How many published listings were searched. */
  searched: number;
};

export const RESIDENT_SEARCH_RESULT_LIMIT = 6;

const STOP_WORDS = new Set(["in", "near", "the", "area", "of", "around", "by", "at", "a", "an", "to", "close"]);

function bedroomFilterId(beds: number | undefined): string {
  if (beds === undefined) return "any";
  if (beds <= 0) return "studio";
  if (beds >= 3) return "3";
  return String(Math.trunc(beds));
}

function areaTokens(area: string | undefined): string[] {
  return (area ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function publicLocationText(p: MockProperty): string {
  return [p.neighborhood, p.address, p.zip, p.title, p.buildingName, p.state].join(" ").toLowerCase();
}

function allowedTerms(p: MockProperty): string[] {
  try {
    return p.listingSubmission && p.listingSubmission.v === 1 ? resolveAllowedLeaseTerms(p.listingSubmission) : [];
  } catch {
    return [];
  }
}

function termMatches(p: MockProperty, term: "short" | "long" | undefined): boolean {
  if (!term) return true;
  const terms = allowedTerms(p);
  if (term === "short") return terms.includes(SHORT_TERM_LEASE_TERM);
  // A listing that publishes no terms is not excluded; one that publishes only stays is.
  return terms.length === 0 || terms.some((t) => t !== SHORT_TERM_LEASE_TERM && t !== AIRBNB_LEASE_TERM);
}

function availabilityText(labels: string[]): string {
  return labels.find((label) => /now/i.test(label)) ?? labels[0] ?? "Ask the manager";
}

export function searchResidentListings(
  listings: readonly MockProperty[],
  filters: ResidentListingFilters,
): ResidentListingSearchResult {
  const tokens = areaTokens(filters.area);
  const byArea = listings.filter((p) => {
    const text = publicLocationText(p);
    return tokens.every((token) => text.includes(token));
  });
  const byTerm = byArea.filter((p) => termMatches(p, filters.term));
  const rows = filterRoomListings([...byTerm], {
    zipRaw: "",
    radiusMiles: 50,
    maxBudgetNum: filters.maxRent && filters.maxRent > 0 ? filters.maxRent : null,
    bathroom: "any",
    bedroom: bedroomFilterId(filters.beds),
    neighborhood: "any",
    moveIn: filters.moveInDate,
  });

  const rowsByProperty = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = rowsByProperty.get(row.propertyId) ?? [];
    list.push(row);
    rowsByProperty.set(row.propertyId, list);
  }

  const cards: ResidentListingCard[] = [];
  for (const p of byTerm) {
    const matching = rowsByProperty.get(p.id);
    if (!matching?.length) continue;
    const rents = matching.map((r) => r.rentNumeric).filter((n): n is number => typeof n === "number" && n > 0);
    cards.push({
      listingId: p.id,
      name: (p.buildingName || p.title || "").trim(),
      address: p.address,
      neighborhood: p.neighborhood,
      zip: p.zip,
      beds: p.beds,
      baths: p.baths,
      fromRent: rents.length ? Math.round(Math.min(...rents)) : null,
      availability: availabilityText(matching.map((r) => r.availabilityLabel)),
      roomsMatching: matching.length,
      petFriendly: p.petFriendly,
      leaseTerms: allowedTerms(p),
    });
  }
  cards.sort((a, b) => (a.fromRent ?? Number.MAX_SAFE_INTEGER) - (b.fromRent ?? Number.MAX_SAFE_INTEGER));
  return { cards: cards.slice(0, RESIDENT_SEARCH_RESULT_LIMIT), matched: cards.length, searched: listings.length };
}
