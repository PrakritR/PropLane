/**
 * Address prefill — the pure apply/undo step (`src/lib/listing-prefill/apply.ts`).
 *
 * The two rules the wizard leans on: only a field still at its default is
 * written, and Undo restores the listing exactly. A record that lies about a
 * remodel must be one click from gone.
 */
import { describe, expect, it } from "vitest";
import {
  applyExtractedAdToSubmission,
  applyFactsToSubmission,
  bathIdFromCount,
  draftDescriptionFromFacts,
  prefillMarkFor,
  undoPrefill,
} from "@/lib/listing-prefill/apply";
import type { AddressFacts, ExtractedAd, RentEstimate } from "@/lib/listing-prefill/types";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

const FACTS: AddressFacts = {
  propertyType: "house",
  bedrooms: 3,
  bathrooms: 2,
  squareFeet: 1450,
  yearBuilt: 1962,
  lotSquareFeet: 4800,
  floors: 2,
  lastSaleYear: 2019,
  amenities: ["Heating", "Air conditioning", "Garage parking"],
};
const RENT: RentEstimate = { rentUsd: 2850, lowUsd: 2600, highUsd: 3100, comparables: 14 };

function fresh() {
  return normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
}

describe("applyFactsToSubmission", () => {
  it("fills every default field and records what it replaced", () => {
    const sub = fresh();
    const { patch, fields } = applyFactsToSubmission(sub, FACTS, RENT, "fixture");
    expect(patch.listingPropertyTypeId).toBe("house");
    expect(patch.listingBedroomSlots).toBe(3);
    expect(patch.listingTotalBathroomsId).toBe("2");
    expect(patch.listingStoriesId).toBe("2");
    expect(patch.houseSizeSqft).toBe(1450);
    expect(patch.yearBuilt).toBe(1962);
    expect(patch.lotSizeSqft).toBe(4800);
    expect(patch.amenitiesText).toBe("Heating\nAir conditioning\nGarage parking");
    expect(fields).toEqual(
      expect.arrayContaining(["listingPropertyTypeId", "listingBedroomSlots", "listingTotalBathroomsId", "listingStoriesId", "houseSizeSqft", "yearBuilt", "lotSizeSqft", "amenitiesText"]),
    );
    expect(patch.prefill?.rentEstimateUsd).toBe(2850);
    expect(patch.prefill?.previous.listingPropertyTypeId).toBe("");
    expect(patch.prefill?.previous.amenitiesText).toBe("");
  });

  it("leaves a value the manager already typed alone, unmarked", () => {
    const sub = { ...fresh(), listingPropertyTypeId: "condo", listingTotalBathroomsId: "1.5", amenitiesText: "WiFi\nHeating" };
    const { patch, fields } = applyFactsToSubmission(sub, FACTS, null, "fixture");
    expect(patch.listingPropertyTypeId).toBeUndefined();
    expect(patch.listingTotalBathroomsId).toBeUndefined();
    expect(fields).not.toContain("listingPropertyTypeId");
    expect(fields).not.toContain("listingTotalBathroomsId");
    // Amenities are additive: the two the record adds ride along, WiFi and Heating stay.
    expect(patch.amenitiesText).toBe("WiFi\nHeating\nAir conditioning\nGarage parking");
    expect(prefillMarkFor({ ...sub, ...patch }, "listingPropertyTypeId")).toBeNull();
    expect(prefillMarkFor({ ...sub, ...patch }, "amenitiesText")).toBe("filled");
  });

  it("rounds bathrooms to the stepper's halves and caps at 4+", () => {
    expect(bathIdFromCount(2.25)).toBe("2.5");
    expect(bathIdFromCount(1.1)).toBe("1");
    expect(bathIdFromCount(5)).toBe("4+");
  });

  it("does not touch bedrooms when rooms already exist", () => {
    const sub = fresh();
    const withRooms = { ...sub, listingBedroomSlots: 2, rooms: [sub.rooms[0]!, { ...sub.rooms[0]!, id: "r2", name: "Room 2" }] };
    const { patch } = applyFactsToSubmission(withRooms, FACTS, null, "fixture");
    expect(patch.listingBedroomSlots).toBeUndefined();
  });
});

describe("applyExtractedAdToSubmission", () => {
  const AD: ExtractedAd = {
    headline: "Sunny 3BR Queen Anne house",
    description: "Bright three-bedroom house on a quiet street.",
    amenities: ["In-unit laundry", "Garage parking"],
    petsAllowed: true,
    listedRentUsd: 2700,
    bedrooms: 3,
    bathrooms: 2,
    squareFeet: 1500,
  };

  it("fills the words and the pet rule, marks them as imported, keeps the listed rent aside", () => {
    const sub = fresh();
    const { patch, fields } = applyExtractedAdToSubmission(sub, AD, "2026-08-12T00:00:00.000Z");
    expect(patch.tagline).toBe(AD.headline);
    expect(patch.houseOverview).toBe(AD.description);
    expect(patch.petFriendly).toBe(true);
    expect(patch.amenitiesText).toBe("In-unit laundry\nGarage parking");
    expect(fields).toEqual(expect.arrayContaining(["tagline", "houseOverview", "petFriendly", "amenitiesText"]));
    expect(patch.prefill?.listedRentUsd).toBe(2700);
    expect(patch.prefill?.listedRentAt).toBe("2026-08-12T00:00:00.000Z");
    // The rent is NEVER written to the listing.
    expect(patch.entireHomeMonthlyRent).toBeUndefined();
    expect(prefillMarkFor({ ...sub, ...patch }, "tagline")).toBe("imported");
  });

  it("lets facts from records win over the ad's numbers", () => {
    const sub = fresh();
    const facts = applyFactsToSubmission(sub, FACTS, RENT, "fixture");
    const after = { ...sub, ...facts.patch };
    const { patch } = applyExtractedAdToSubmission(after, { ...AD, squareFeet: 9999, bedrooms: 5 }, null);
    expect(patch.houseSizeSqft).toBeUndefined();
    expect(patch.listingBedroomSlots).toBeUndefined();
    expect(prefillMarkFor({ ...after, ...patch }, "houseSizeSqft")).toBe("filled");
  });
});

describe("undoPrefill", () => {
  it("restores every touched value exactly and forgets the record", () => {
    const sub = fresh();
    const facts = applyFactsToSubmission(sub, FACTS, RENT, "fixture");
    const afterFacts = { ...sub, ...facts.patch };
    const ad = applyExtractedAdToSubmission(afterFacts, { headline: "H", description: "D", amenities: ["Yard / patio"], petsAllowed: true, listedRentUsd: null, bedrooms: null, bathrooms: null, squareFeet: null }, null);
    const afterAd = { ...afterFacts, ...ad.patch };
    const restored = { ...afterAd, ...undoPrefill(afterAd) };
    for (const key of ["listingPropertyTypeId", "listingBedroomSlots", "listingTotalBathroomsId", "listingStoriesId", "houseSizeSqft", "yearBuilt", "lotSizeSqft", "amenitiesText", "tagline", "houseOverview", "petFriendly"] as const) {
      expect(restored[key]).toEqual(sub[key]);
    }
    expect(restored.prefill).toBeUndefined();
  });

  it("keeps a 'Not this home' dismissal through an undo", () => {
    const sub = fresh();
    const { patch } = applyFactsToSubmission({ ...sub, prefill: { source: "fixture", fetchedAt: "x", fields: [], adFields: [], previous: {}, dismissedAddressKey: "1 main st|seattle|wa|98101" } }, FACTS, null, "fixture");
    const restored = { ...sub, ...patch, ...undoPrefill({ ...sub, ...patch }) };
    expect(restored.prefill?.dismissedAddressKey).toBe("1 main st|seattle|wa|98101");
    expect(restored.prefill?.fields).toEqual([]);
  });
});

describe("draftDescriptionFromFacts", () => {
  it("writes a plain paragraph from what is on the listing, nothing invented", () => {
    const sub = { ...fresh(), ...applyFactsToSubmission(fresh(), FACTS, null, "fixture").patch, city: "Seattle", neighborhood: "Queen Anne" };
    const text = draftDescriptionFromFacts(sub);
    expect(text).toContain("1,450 sq ft single-family home built in 1962");
    expect(text).toContain("Queen Anne, Seattle");
    expect(text).toContain("3 bedrooms and 2 bathrooms across 2 floors");
    expect(text).toContain("Rooms rent individually");
    expect(text).not.toMatch(/\$/);
  });
});
