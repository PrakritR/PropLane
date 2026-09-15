/**
 * Turn looked-up facts or pasted-ad fields into a listing patch — and back.
 *
 * Pure and client-safe. Two rules the wizard relies on:
 *
 * 1. Only a field still at its DEFAULT is written. A value the manager typed
 *    is never overwritten and never marked.
 * 2. Everything written is recorded on `submission.prefill` with the value it
 *    replaced, so "Undo" restores the listing exactly.
 */

import { listingAmenityLinesFromValue } from "@/data/manager-listing-presets";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { AddressFacts, ExtractedAd, ListingPrefillRecordV1, RentEstimate } from "./types";

export type PrefillPatch = { patch: Partial<ManagerListingSubmissionV1>; fields: string[] };

/** The stepper counts in halves and "4+" is its top — same rule as the Basics step. */
export function bathIdFromCount(n: number): string {
  const half = Math.round(n * 2) / 2;
  if (half >= 4.5) return "4+";
  return String(Math.max(1, half));
}

const MAX_FLOORS = 8;

function emptyRecord(source: ListingPrefillRecordV1["source"]): ListingPrefillRecordV1 {
  return { source, fetchedAt: new Date().toISOString(), fields: [], adFields: [], previous: {} };
}

function remember(record: ListingPrefillRecordV1, sub: ManagerListingSubmissionV1, key: keyof ManagerListingSubmissionV1) {
  if (!(key in record.previous)) record.previous[key] = sub[key];
}

function mergeAmenities(current: string, add: string[]): { next: string; added: string[] } {
  const lines = listingAmenityLinesFromValue(current);
  const have = new Set(lines.map((l) => l.toLowerCase()));
  const added = add.filter((a) => a && !have.has(a.toLowerCase()));
  return { next: [...lines, ...added].join("\n"), added };
}

/**
 * Facts → patch. `source` names the provider so the record can say where a
 * value came from.
 */
export function applyFactsToSubmission(
  sub: ManagerListingSubmissionV1,
  facts: AddressFacts,
  rent: RentEstimate | null,
  source: ListingPrefillRecordV1["source"],
): PrefillPatch {
  const record: ListingPrefillRecordV1 = { ...(sub.prefill ?? emptyRecord(source)), source, fetchedAt: new Date().toISOString() };
  record.previous = { ...record.previous };
  record.fields = [...record.fields];
  const patch: Partial<ManagerListingSubmissionV1> = {};
  const touch = (key: keyof ManagerListingSubmissionV1) => {
    remember(record, sub, key);
    if (!record.fields.includes(key)) record.fields.push(key);
  };

  if (facts.propertyType && !sub.listingPropertyTypeId) {
    touch("listingPropertyTypeId");
    patch.listingPropertyTypeId = facts.propertyType;
  }
  if (facts.bedrooms && (sub.listingBedroomSlots ?? 1) === 1 && (sub.rooms?.length ?? 0) <= 1) {
    touch("listingBedroomSlots");
    patch.listingBedroomSlots = Math.min(20, facts.bedrooms);
  }
  if (facts.bathrooms && !sub.listingTotalBathroomsId) {
    touch("listingTotalBathroomsId");
    patch.listingTotalBathroomsId = bathIdFromCount(facts.bathrooms);
  }
  if (facts.floors && !sub.listingStoriesId) {
    touch("listingStoriesId");
    patch.listingStoriesId = String(Math.min(MAX_FLOORS, facts.floors));
  }
  if (facts.squareFeet && sub.houseSizeSqft == null) {
    touch("houseSizeSqft");
    patch.houseSizeSqft = facts.squareFeet;
  }
  if (facts.yearBuilt && sub.yearBuilt == null) {
    touch("yearBuilt");
    patch.yearBuilt = facts.yearBuilt;
  }
  if (facts.lotSquareFeet && sub.lotSizeSqft == null) {
    touch("lotSizeSqft");
    patch.lotSizeSqft = facts.lotSquareFeet;
  }
  if (facts.amenities.length) {
    const { next, added } = mergeAmenities(sub.amenitiesText, facts.amenities);
    if (added.length) {
      touch("amenitiesText");
      patch.amenitiesText = next;
    }
  }
  if (rent) {
    record.rentEstimateUsd = rent.rentUsd;
    record.rentEstimateLowUsd = rent.lowUsd ?? undefined;
    record.rentEstimateHighUsd = rent.highUsd ?? undefined;
  }
  patch.prefill = record;
  return { patch, fields: record.fields.filter((f) => f in patch) };
}

/** Pasted-ad fields → patch. Facts the ad states fill only what records left blank. */
export function applyExtractedAdToSubmission(
  sub: ManagerListingSubmissionV1,
  ad: ExtractedAd,
  listedAt: string | null,
): PrefillPatch {
  const record: ListingPrefillRecordV1 = { ...(sub.prefill ?? emptyRecord("fixture")) };
  record.previous = { ...record.previous };
  record.adFields = [...record.adFields];
  record.fields = [...record.fields];
  const patch: Partial<ManagerListingSubmissionV1> = {};
  const touch = (key: keyof ManagerListingSubmissionV1) => {
    remember(record, sub, key);
    if (!record.adFields.includes(key)) record.adFields.push(key);
  };

  if (ad.headline && !sub.tagline.trim()) {
    touch("tagline");
    patch.tagline = ad.headline;
  }
  if (ad.description && !sub.houseOverview.trim()) {
    touch("houseOverview");
    patch.houseOverview = ad.description;
  }
  if (ad.amenities.length) {
    const { next, added } = mergeAmenities(sub.amenitiesText, ad.amenities);
    if (added.length) {
      touch("amenitiesText");
      patch.amenitiesText = next;
    }
  }
  if (ad.petsAllowed === true && !sub.petFriendly) {
    touch("petFriendly");
    patch.petFriendly = true;
  }
  if (ad.bedrooms && (sub.listingBedroomSlots ?? 1) === 1 && (sub.rooms?.length ?? 0) <= 1 && !record.fields.includes("listingBedroomSlots")) {
    touch("listingBedroomSlots");
    patch.listingBedroomSlots = Math.min(20, Math.round(ad.bedrooms));
  }
  if (ad.bathrooms && !sub.listingTotalBathroomsId) {
    touch("listingTotalBathroomsId");
    patch.listingTotalBathroomsId = bathIdFromCount(ad.bathrooms);
  }
  if (ad.squareFeet && sub.houseSizeSqft == null) {
    touch("houseSizeSqft");
    patch.houseSizeSqft = Math.round(ad.squareFeet);
  }
  if (ad.listedRentUsd) {
    record.listedRentUsd = ad.listedRentUsd;
    record.listedRentAt = listedAt;
  }
  patch.prefill = record;
  return { patch, fields: record.adFields.filter((f) => f in patch) };
}

/** Put back every value the prefill and the import replaced, and forget the record. */
export function undoPrefill(sub: ManagerListingSubmissionV1): Partial<ManagerListingSubmissionV1> {
  const record = sub.prefill;
  if (!record) return {};
  // Everything `previous` remembers comes back — including keys that were
  // changed as a side effect and never marked (the rooms a bedroom count
  // created), which is why this reads `previous` rather than the field lists.
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(record.previous)) patch[key] = record.previous[key];
  patch.prefill = record.dismissedAddressKey ? { ...emptyRecord(record.source), dismissedAddressKey: record.dismissedAddressKey } : undefined;
  return patch as Partial<ManagerListingSubmissionV1>;
}

/** Which keys the record says were filled — for the marks beside each field. */
export function prefillMarkFor(sub: ManagerListingSubmissionV1, key: keyof ManagerListingSubmissionV1): "filled" | "imported" | null {
  const r = sub.prefill;
  if (!r) return null;
  if (r.adFields.includes(key)) return "imported";
  if (r.fields.includes(key)) return "filled";
  return null;
}

/** A plain description from the facts on the submission — the offline "Write a description". */
export function draftDescriptionFromFacts(sub: ManagerListingSubmissionV1): string {
  const type = ({ house: "single-family home", townhouse: "townhouse", condo: "condo", apartment: "apartment", duplex: "small multi-unit building", other: "home" } as Record<string, string>)[sub.listingPropertyTypeId ?? ""] ?? "home";
  const size = sub.houseSizeSqft ? `${sub.houseSizeSqft.toLocaleString("en-US")} sq ft ` : "";
  const built = sub.yearBuilt ? ` built in ${sub.yearBuilt}` : "";
  const lot = sub.lotSizeSqft ? ` on a ${sub.lotSizeSqft.toLocaleString("en-US")} sq ft lot` : "";
  const where = [sub.neighborhood, sub.city].filter(Boolean).join(", ");
  const beds = sub.listingBedroomSlots ?? sub.rooms?.length ?? 1;
  const bathsId = sub.listingTotalBathroomsId;
  const baths = bathsId === "4+" ? "4+" : bathsId;
  const floors = Number(sub.listingStoriesId) > 1 ? ` across ${sub.listingStoriesId} floors` : "";
  const amenities = listingAmenityLinesFromValue(sub.amenitiesText).slice(0, 4);
  const byRoom = sub.listingPlaceCategoryId !== "entire_home";
  return [
    `A ${size}${type}${built}${lot}${where ? ` in ${where}` : ""}.`,
    `${beds} bedroom${beds === 1 ? "" : "s"}${baths ? ` and ${baths} bathroom${baths === "1" ? "" : "s"}` : ""}${floors}.`,
    amenities.length ? `${amenities.join(", ")}.` : "",
    byRoom ? "Rooms rent individually with shared common spaces." : "",
  ]
    .filter(Boolean)
    .join(" ");
}
