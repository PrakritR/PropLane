/**
 * Turn looked-up facts into a listing patch — and back.
 *
 * Pure and client-safe. Three rules the wizard relies on:
 *
 * 1. The card comes up only on a BLANK listing (`listingIsBlankForPrefill`):
 *    a listing that already has a home type, bedrooms, bathrooms, size or year
 *    is never second-guessed, and never spends a lookup.
 * 2. Only a field still at its DEFAULT is written. A value the manager typed
 *    is never overwritten and never marked.
 * 3. What the card LISTS is exactly what the click WRITES: `prefillEntries`
 *    describes the patch `applyFactsToSubmission` builds, so a row never
 *    appears for something that would not fill and nothing fills unlisted.
 *    Everything written is recorded on `submission.prefill` with the value it
 *    replaced, so "Undo" restores the listing exactly.
 */

import { listingAmenityLinesFromValue } from "@/data/manager-listing-presets";
import {
  applyEntireHomeListingPricing,
  applyListingBathroomSlots,
  applyListingBedroomSlots,
  emptySharedSpace,
  isEntireHomeListing,
  type ManagerListingSubmissionV1,
  type ManagerSharedSpaceSubmission,
} from "@/lib/manager-listing-submission";
import { applyBathroomDefaults, bathroomDefaultsForSubmission, defaultValueIsUnset, sharedSpaceDefaultsForSubmission, writeSharedSpaceField, SHARED_SPACE_DEFAULT_FIELDS } from "@/lib/listing-record-defaults";
import { emptyListingHouseDefaults } from "@/lib/listing-house-defaults";
import type { AddressFacts, ListingPrefillRecordV1, PrefillPropertyType, RentEstimate } from "./types";

export type PrefillPatch = { patch: Partial<ManagerListingSubmissionV1>; fields: string[] };

/** The stepper counts in halves and "4+" is its top — same rule as the Basics step. */
export function bathIdFromCount(n: number): string {
  const half = Math.round(n * 2) / 2;
  if (half >= 4.5) return "4+";
  return String(Math.max(1, half));
}

const MAX_FLOORS = 8;
const MAX_BEDROOMS = 20;

export const PROPERTY_TYPE_LABELS: Record<PrefillPropertyType, string> = {
  house: "House",
  townhouse: "Townhouse",
  condo: "Condo",
  apartment: "Apartment",
  duplex: "Small building",
  other: "Home",
};

/** The two shared spaces every by-the-room home starts with. A default for a shared home, not a fact about the house. */
const SHARED_HOME_SPACES: readonly { name: string; kind: ManagerSharedSpaceSubmission["spaceKind"] }[] = [
  { name: "Kitchen & dining", kind: "kitchen" },
  { name: "Living / lounge", kind: "living" },
];

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

/** Rent per room from the estimate: the home's rent split evenly, to the nearest $10. */
export function rentPerRoomFromEstimate(rentUsd: number, bedrooms: number): number {
  if (!(rentUsd > 0) || !(bedrooms > 0)) return 0;
  return Math.max(10, Math.round(rentUsd / bedrooms / 10) * 10);
}

/**
 * True when the home's own facts are all still unset — no type, the bedroom
 * stepper at 1 with a single untouched room, no bathroom count, no size, no
 * year built. City, ZIP, name and description never count: they are the
 * address, not the home. This is the gate for the lookup and the card.
 */
export function listingIsBlankForPrefill(sub: ManagerListingSubmissionV1): boolean {
  return (
    !(sub.listingPropertyTypeId ?? "").trim() &&
    (sub.listingBedroomSlots ?? 1) === 1 &&
    (sub.rooms?.length ?? 0) <= 1 &&
    !(sub.listingTotalBathroomsId ?? "").trim() &&
    (sub.bathrooms?.length ?? 0) <= 1 &&
    sub.houseSizeSqft == null &&
    sub.yearBuilt == null
  );
}

/**
 * Facts → patch. `source` names the provider so the record can say where a
 * value came from. Bedrooms make room cards and bathrooms make bathroom cards
 * exactly as the Basics steppers do; a by-the-room home gets its rent per
 * room (marked ✦ Estimated on the Pricing step) and the two standard shared
 * spaces; a whole-place home gets the estimate as its rent.
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
  // Side effects of a fill (the rooms a count makes) are remembered so Undo
  // puts them back, but never marked — the mark belongs to the count.
  const rememberOnly = (key: keyof ManagerListingSubmissionV1) => remember(record, sub, key);
  const byRoom = !isEntireHomeListing(sub);

  if (facts.propertyType && !sub.listingPropertyTypeId) {
    touch("listingPropertyTypeId");
    patch.listingPropertyTypeId = facts.propertyType;
  }

  let rooms = sub.rooms;
  if (facts.bedrooms && (sub.listingBedroomSlots ?? 1) === 1 && (sub.rooms?.length ?? 0) <= 1) {
    const count = Math.min(MAX_BEDROOMS, facts.bedrooms);
    const applied = applyListingBedroomSlots({ ...sub, listingBedroomSlots: count }, count);
    touch("listingBedroomSlots");
    patch.listingBedroomSlots = count;
    if (applied.ok) {
      rememberOnly("rooms");
      rooms = applied.sub.rooms;
      patch.rooms = rooms;
    }
  }

  if (rent) {
    record.rentEstimateUsd = rent.rentUsd;
    record.rentEstimateLowUsd = rent.lowUsd ?? undefined;
    record.rentEstimateHighUsd = rent.highUsd ?? undefined;
    const bedrooms = patch.listingBedroomSlots ?? sub.listingBedroomSlots ?? rooms.length ?? 1;
    const nothingPriced = !rooms.some((r) => r.monthlyRent > 0);
    if (byRoom) {
      const perRoom = rentPerRoomFromEstimate(rent.rentUsd, bedrooms);
      const defaults = { ...emptyListingHouseDefaults(), ...(sub.houseDefaults ?? {}) };
      if (perRoom > 0 && !(defaults.monthlyRent > 0) && nothingPriced) {
        touch("houseDefaults");
        patch.houseDefaults = { ...(sub.houseDefaults ?? {}), monthlyRent: perRoom };
        record.rentPerRoomUsd = perRoom;
        rememberOnly("rooms");
        rooms = rooms.map((r) => (r.monthlyRent > 0 ? r : { ...r, monthlyRent: perRoom }));
        patch.rooms = rooms;
      }
    } else if (!(sub.entireHomeMonthlyRent && sub.entireHomeMonthlyRent > 0) && nothingPriced) {
      touch("entireHomeMonthlyRent");
      rememberOnly("rooms");
      const priced = applyEntireHomeListingPricing({ ...sub, rooms }, { entireHomeMonthlyRent: rent.rentUsd });
      patch.entireHomeMonthlyRent = priced.entireHomeMonthlyRent;
      rooms = priced.rooms;
      patch.rooms = rooms;
    }
  }

  if (facts.bathrooms && !sub.listingTotalBathroomsId && (sub.bathrooms?.length ?? 0) <= 1) {
    const id = bathIdFromCount(facts.bathrooms);
    const count = id === "4+" ? 4 : Number(id);
    touch("listingTotalBathroomsId");
    patch.listingTotalBathroomsId = id;
    const applied = applyListingBathroomSlots({ ...sub, listingTotalBathroomsId: id }, count);
    if (applied.ok) {
      // A card the count makes copies the Default bathroom, as the stepper's do.
      const before = sub.bathrooms?.length ?? 0;
      const stored = bathroomDefaultsForSubmission(sub);
      rememberOnly("bathrooms");
      patch.bathrooms = applied.sub.bathrooms.map((bath, i) => (i >= before ? applyBathroomDefaults(bath, stored) : bath));
    }
  }

  if (byRoom && (sub.sharedSpaces?.length ?? 0) === 0) {
    const defaults = sharedSpaceDefaultsForSubmission(sub);
    touch("sharedSpaces");
    patch.sharedSpaces = SHARED_HOME_SPACES.map(({ name, kind }, i) => {
      let space: ManagerSharedSpaceSubmission = { ...emptySharedSpace(i), name, spaceKind: kind };
      for (const field of SHARED_SPACE_DEFAULT_FIELDS) {
        if (!defaultValueIsUnset(defaults[field])) space = writeSharedSpaceField(space, field, defaults[field]);
      }
      return space;
    });
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
  patch.prefill = record;
  return { patch, fields: record.fields.filter((f) => f in patch) };
}

/** One row of the card: what the click writes, in the manager's words. */
export type PrefillEntry = {
  key: string;
  label: string;
  /** The value, as shown: "8", "1,561". */
  value: string;
  /** The unit or note after the value: "sq ft", "/mo · $5,610 ÷ 8". */
  detail?: string;
  /** What the row makes beyond the field: "Room 1–8". */
  makes?: string;
  kind: "filled" | "estimated" | "reference";
};

function n(v: number): string {
  return v.toLocaleString("en-US");
}
function money(v: number): string {
  return `$${n(v)}`;
}

/**
 * The rows the card lists — derived from the patch the click would apply, so
 * the list and the fill can never disagree. The rent estimate is the one
 * reference row: shown on the Pricing step, never written to a rent.
 */
export function prefillEntries(sub: ManagerListingSubmissionV1, facts: AddressFacts, rent: RentEstimate | null): PrefillEntry[] {
  const { patch } = applyFactsToSubmission(sub, facts, rent, sub.prefill?.source ?? "rentcast");
  const rows: PrefillEntry[] = [];
  if (patch.listingPropertyTypeId) rows.push({ key: "listingPropertyTypeId", label: "Home type", value: PROPERTY_TYPE_LABELS[patch.listingPropertyTypeId as PrefillPropertyType] ?? "Home", kind: "filled" });
  if (patch.listingBedroomSlots) {
    const count = patch.listingBedroomSlots;
    rows.push({ key: "listingBedroomSlots", label: "Bedrooms", value: String(count), makes: patch.rooms && count > 1 ? `Room 1–${count}` : undefined, kind: "filled" });
  }
  if (patch.houseDefaults?.monthlyRent && rent) {
    const beds = patch.listingBedroomSlots ?? sub.listingBedroomSlots ?? 1;
    rows.push({ key: "houseDefaults", label: "Rent per room", value: `≈ ${money(patch.houseDefaults.monthlyRent)}`, detail: `/mo · ${money(rent.rentUsd)} ÷ ${beds}`, kind: "estimated" });
  } else if (patch.entireHomeMonthlyRent) {
    rows.push({ key: "entireHomeMonthlyRent", label: "Rent", value: `≈ ${money(patch.entireHomeMonthlyRent)}`, detail: "/mo", kind: "estimated" });
  }
  if (patch.listingTotalBathroomsId) {
    const id = patch.listingTotalBathroomsId;
    const cards = patch.bathrooms?.length ?? 0;
    rows.push({ key: "listingTotalBathroomsId", label: "Bathrooms", value: id, makes: cards > 1 ? `Bathroom 1–${cards}` : undefined, kind: "filled" });
  }
  if (patch.sharedSpaces?.length) rows.push({ key: "sharedSpaces", label: "Shared spaces", value: patch.sharedSpaces.map((s) => s.name).join(" · "), kind: "filled" });
  if (patch.houseSizeSqft) rows.push({ key: "houseSizeSqft", label: "Size", value: n(patch.houseSizeSqft), detail: "sq ft", kind: "filled" });
  if (patch.yearBuilt) rows.push({ key: "yearBuilt", label: "Year built", value: String(patch.yearBuilt), kind: "filled" });
  if (patch.listingStoriesId) rows.push({ key: "listingStoriesId", label: "Floors", value: patch.listingStoriesId, kind: "filled" });
  if (patch.lotSizeSqft) rows.push({ key: "lotSizeSqft", label: "Lot", value: n(patch.lotSizeSqft), detail: "sq ft", kind: "filled" });
  if (patch.amenitiesText != null) {
    const have = new Set(listingAmenityLinesFromValue(sub.amenitiesText).map((l) => l.toLowerCase()));
    const added = listingAmenityLinesFromValue(patch.amenitiesText).filter((l) => !have.has(l.toLowerCase()));
    if (added.length) rows.push({ key: "amenitiesText", label: "Amenities", value: added.join(" · "), kind: "filled" });
  }
  if (rent) {
    const range = rent.lowUsd && rent.highUsd ? `${money(rent.lowUsd)}–${money(rent.highUsd)}` : "";
    rows.push({ key: "rentEstimate", label: "Rent estimate", value: `≈ ${money(rent.rentUsd)}`, detail: `/mo${range ? ` · ${range}` : ""}`, kind: "reference" });
  }
  return rows;
}

/** Put back every value the prefill replaced, and forget the record. */
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

/**
 * Which keys the record says were filled — for the marks beside each field.
 * `imported` is what the property import (a spreadsheet) wrote; `estimated`
 * is a rent derived from the estimate rather than read from a record.
 */
export function prefillMarkFor(sub: ManagerListingSubmissionV1, key: keyof ManagerListingSubmissionV1): "filled" | "imported" | "estimated" | null {
  const r = sub.prefill;
  if (!r) return null;
  if (r.adFields.includes(key)) return "imported";
  if (key === "houseDefaults" || key === "entireHomeMonthlyRent") return r.fields.includes(key) ? "estimated" : null;
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
