/**
 * Address prefill — the shapes shared by the lookup route, the pure apply
 * step and the wizard card.
 *
 * FACTS about the home (type, beds, baths, size, year, floors, lot, the
 * amenities a record carries, a rent estimate) come from a licensed
 * property-records provider by address. Nothing else is looked up: PropLane
 * never fetches a listing page or searches for one
 * (docs/agents/listing-prefill.md).
 */

/** The property-type ids the wizard's tiles use (`PROPERTY_KIND_TILES`). */
export type PrefillPropertyType = "house" | "townhouse" | "condo" | "apartment" | "duplex" | "other";

export type AddressFacts = {
  propertyType: PrefillPropertyType | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  yearBuilt: number | null;
  lotSquareFeet: number | null;
  floors: number | null;
  lastSaleYear: number | null;
  /** Labels from `HOUSE_WIDE_AMENITY_PRESETS` the record supports (heating, AC, parking…). */
  amenities: string[];
};

export type RentEstimate = {
  rentUsd: number;
  lowUsd: number | null;
  highUsd: number | null;
  comparables: number | null;
};

export type ListingPrefillStatus = "found" | "none" | "quota" | "error" | "unavailable";

export type ListingPrefillResult = {
  status: ListingPrefillStatus;
  facts: AddressFacts | null;
  rent: RentEstimate | null;
  /** True when this answer came from the 30-day cache and cost no lookup. */
  cached: boolean;
  /** Lookups left this month on a capped plan; null when unlimited. */
  lookupsLeft: number | null;
  source: "rentcast" | "fixture" | null;
};

/**
 * Stored on the submission (`ManagerListingSubmissionV1.prefill`) so the
 * wizard can mark what it filled and undo it exactly. Private: never on the
 * public projection.
 */
export type ListingPrefillRecordV1 = {
  /** `file` — written by the property import (a spreadsheet the manager uploaded). */
  source: "rentcast" | "fixture" | "file";
  fetchedAt: string;
  /** Submission keys the facts prefill wrote (`houseDefaults` / `entireHomeMonthlyRent` mean the estimated rent). */
  fields: string[];
  /** Submission keys the property import wrote — marked "Imported" rather than "Filled". */
  adFields: string[];
  /** Exact values the touched keys held before, so Undo restores them. */
  previous: Record<string, unknown>;
  rentEstimateUsd?: number;
  rentEstimateLowUsd?: number;
  rentEstimateHighUsd?: number;
  /** The estimate split per bedroom, when the click wrote it as the Default room's rent. */
  rentPerRoomUsd?: number;
  /** The address key the manager dismissed with "Not this home". */
  dismissedAddressKey?: string;
};

/** Address parts the route accepts; the wizard sends what the autocomplete filled. */
export type PrefillAddressInput = {
  address: string;
  city: string;
  state: string;
  zip: string;
};

/** One stable key per address, for the cache and for "Not this home". */
export function prefillAddressKey(input: PrefillAddressInput): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return [norm(input.address), norm(input.city), norm(input.state).slice(0, 2), norm(input.zip).slice(0, 5)]
    .filter(Boolean)
    .join("|");
}

/** The single-line address the providers take. */
export function prefillAddressLine(input: PrefillAddressInput): string {
  const street = input.address.trim();
  const cityState = [input.city.trim(), input.state.trim().toUpperCase().slice(0, 2)].filter(Boolean).join(", ");
  return [street, cityState, input.zip.trim().slice(0, 5)].filter(Boolean).join(", ");
}
