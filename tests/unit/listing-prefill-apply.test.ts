/**
 * Address prefill — the pure gate/apply/undo step (`src/lib/listing-prefill/apply.ts`).
 *
 * Three rules the wizard leans on: the card comes up only on a blank listing,
 * only a field still at its default is written, and what the card lists is
 * exactly what the click writes. A record that lies about a remodel must be
 * one click from gone.
 */
import { describe, expect, it } from "vitest";
import {
  applyFactsToSubmission,
  bathIdFromCount,
  draftDescriptionFromFacts,
  listingIsBlankForPrefill,
  prefillEntries,
  prefillMarkFor,
  rentPerRoomFromEstimate,
  undoPrefill,
} from "@/lib/listing-prefill/apply";
import type { AddressFacts, RentEstimate } from "@/lib/listing-prefill/types";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

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
function entire(): ManagerListingSubmissionV1 {
  return { ...fresh(), listingPlaceCategoryId: "entire_home" };
}

describe("listingIsBlankForPrefill (the gate)", () => {
  it("is open on a brand-new listing, with or without an address", () => {
    expect(listingIsBlankForPrefill(fresh())).toBe(true);
    expect(listingIsBlankForPrefill({ ...fresh(), address: "142 Ash St", city: "Seattle", zip: "98109", buildingName: "Ash House", houseOverview: "Sunny." })).toBe(true);
  });

  it("closes once any home fact is set", () => {
    const sub = fresh();
    expect(listingIsBlankForPrefill({ ...sub, listingPropertyTypeId: "condo" })).toBe(false);
    expect(listingIsBlankForPrefill({ ...sub, listingBedroomSlots: 2 })).toBe(false);
    expect(listingIsBlankForPrefill({ ...sub, rooms: [sub.rooms[0]!, { ...sub.rooms[0]!, id: "r2", name: "Room 2" }] })).toBe(false);
    expect(listingIsBlankForPrefill({ ...sub, listingTotalBathroomsId: "1.5" })).toBe(false);
    expect(listingIsBlankForPrefill({ ...sub, houseSizeSqft: 900 })).toBe(false);
    expect(listingIsBlankForPrefill({ ...sub, yearBuilt: 1990 })).toBe(false);
  });
});

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

  it("makes the rooms, the bathroom cards and the two shared spaces", () => {
    const sub = fresh();
    const { patch } = applyFactsToSubmission(sub, FACTS, null, "fixture");
    expect(patch.rooms?.map((r) => r.name)).toEqual(["Room 1", "Room 2", "Room 3"]);
    expect(patch.bathrooms?.map((b) => b.name)).toEqual(["Bathroom 1", "Bathroom 2"]);
    expect(patch.sharedSpaces?.map((s) => [s.name, s.spaceKind])).toEqual([
      ["Kitchen & dining", "kitchen"],
      ["Living / lounge", "living"],
    ]);
    // Side effects are remembered for Undo but the mark belongs to the count.
    expect(Object.keys(patch.prefill!.previous)).toEqual(expect.arrayContaining(["rooms", "bathrooms", "sharedSpaces"]));
    expect(prefillMarkFor({ ...sub, ...patch }, "sharedSpaces")).toBe("filled");
    expect(prefillMarkFor({ ...sub, ...patch }, "rooms")).toBeNull();
  });

  it("a half bath makes a half-bath card and fills every new one from the listing's stored (legacy) bathroom defaults", () => {
    const sub = { ...fresh(), bathroomDefaults: { location: "Upstairs" } };
    const { patch } = applyFactsToSubmission(sub, { ...FACTS, bathrooms: 2.5 }, null, "fixture");
    expect(patch.listingTotalBathroomsId).toBe("2.5");
    expect(patch.bathrooms).toHaveLength(3);
    expect(patch.bathrooms?.[2]?.shower).toBe(false);
    expect(patch.bathrooms?.every((b) => b.location === "Upstairs")).toBe(true);
  });

  it("splits the estimate per room onto the Default room and every room, marked estimated", () => {
    const sub = fresh();
    const { patch } = applyFactsToSubmission(sub, FACTS, RENT, "fixture");
    expect(rentPerRoomFromEstimate(2850, 3)).toBe(950);
    expect(patch.houseDefaults?.monthlyRent).toBe(950);
    expect(patch.rooms?.every((r) => r.monthlyRent === 950)).toBe(true);
    expect(patch.prefill?.rentPerRoomUsd).toBe(950);
    expect(prefillMarkFor({ ...sub, ...patch }, "houseDefaults")).toBe("estimated");
    expect(patch.entireHomeMonthlyRent).toBeUndefined();
  });

  it("gives a whole-place listing the estimate as its rent and no shared spaces", () => {
    const sub = entire();
    const { patch } = applyFactsToSubmission(sub, FACTS, RENT, "fixture");
    expect(patch.entireHomeMonthlyRent).toBe(2850);
    expect(patch.houseDefaults).toBeUndefined();
    expect(patch.sharedSpaces).toBeUndefined();
    expect(prefillMarkFor({ ...sub, ...patch }, "entireHomeMonthlyRent")).toBe("estimated");
  });

  it("never touches a rent someone already set", () => {
    const sub = { ...fresh(), houseDefaults: { monthlyRent: 1200 } };
    const { patch } = applyFactsToSubmission(sub, FACTS, RENT, "fixture");
    expect(patch.houseDefaults).toBeUndefined();
    expect(patch.prefill?.rentPerRoomUsd).toBeUndefined();
    const home = { ...entire(), entireHomeMonthlyRent: 3000 };
    expect(applyFactsToSubmission(home, FACTS, RENT, "fixture").patch.entireHomeMonthlyRent).toBeUndefined();
  });

  it("leaves a value the manager already typed alone, unmarked", () => {
    const sub = { ...fresh(), listingPropertyTypeId: "condo", listingTotalBathroomsId: "1.5", amenitiesText: "WiFi\nHeating" };
    const { patch, fields } = applyFactsToSubmission(sub, FACTS, null, "fixture");
    expect(patch.listingPropertyTypeId).toBeUndefined();
    expect(patch.listingTotalBathroomsId).toBeUndefined();
    expect(patch.bathrooms).toBeUndefined();
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
    expect(patch.rooms).toBeUndefined();
  });
});

describe("prefillEntries (the list is the contract)", () => {
  it("lists one row per entry the click writes, in the card's order", () => {
    const rows = prefillEntries(fresh(), FACTS, RENT);
    expect(rows.map((r) => [r.label, r.value, r.makes ?? "", r.kind])).toEqual([
      ["Home type", "House", "", "filled"],
      ["Bedrooms", "3", "Room 1–3", "filled"],
      ["Rent per room", "≈ $950", "", "estimated"],
      ["Bathrooms", "2", "Bathroom 1–2", "filled"],
      ["Shared spaces", "Kitchen & dining · Living / lounge", "", "filled"],
      ["Size", "1,450", "", "filled"],
      ["Year built", "1962", "", "filled"],
      ["Floors", "2", "", "filled"],
      ["Lot", "4,800", "", "filled"],
      ["Amenities", "Heating · Air conditioning · Garage parking", "", "filled"],
      ["Rent estimate", "≈ $2,850", "", "reference"],
    ]);
    expect(rows.find((r) => r.label === "Rent per room")?.detail).toBe("/mo · $2,850 ÷ 3");
  });

  it("every listed key is in the patch and every patched key is listed", () => {
    const sub = fresh();
    const rows = prefillEntries(sub, FACTS, RENT);
    const { patch } = applyFactsToSubmission(sub, FACTS, RENT, "fixture");
    const listed = new Set(rows.filter((r) => r.kind !== "reference").map((r) => r.key));
    for (const key of listed) expect(patch).toHaveProperty(key);
    // What the patch writes beyond the listed keys is only the side effects of a listed row plus the record.
    const unlisted = Object.keys(patch).filter((k) => !listed.has(k));
    expect(unlisted.sort()).toEqual(["bathrooms", "prefill", "rooms"]);
  });

  it("drops a row the record cannot fill and a row the listing already has", () => {
    const rows = prefillEntries({ ...fresh(), listingPropertyTypeId: "condo" }, { ...FACTS, floors: null, lotSquareFeet: null, amenities: [] }, null);
    const labels = rows.map((r) => r.label);
    expect(labels).not.toContain("Home type");
    expect(labels).not.toContain("Floors");
    expect(labels).not.toContain("Lot");
    expect(labels).not.toContain("Amenities");
    expect(labels).not.toContain("Rent per room");
    expect(labels).not.toContain("Rent estimate");
  });

  it("shows one Rent row and no shared spaces for a whole-place listing", () => {
    const labels = prefillEntries(entire(), FACTS, RENT).map((r) => r.label);
    expect(labels).toContain("Rent");
    expect(labels).not.toContain("Rent per room");
    expect(labels).not.toContain("Shared spaces");
  });
});

describe("undoPrefill", () => {
  it("restores every touched value exactly, cards included, and forgets the record", () => {
    const sub = fresh();
    const { patch } = applyFactsToSubmission(sub, FACTS, RENT, "fixture");
    const after = { ...sub, ...patch };
    const restored = { ...after, ...undoPrefill(after) };
    for (const key of [
      "listingPropertyTypeId",
      "listingBedroomSlots",
      "listingTotalBathroomsId",
      "listingStoriesId",
      "houseSizeSqft",
      "yearBuilt",
      "lotSizeSqft",
      "amenitiesText",
      "rooms",
      "bathrooms",
      "sharedSpaces",
      "houseDefaults",
    ] as const) {
      expect(restored[key]).toEqual(sub[key]);
    }
    expect(restored.prefill).toBeUndefined();
    expect(listingIsBlankForPrefill(restored)).toBe(true);
  });

  it("keeps a 'Not this home' dismissal through an undo", () => {
    const sub = fresh();
    const { patch } = applyFactsToSubmission({ ...sub, prefill: { source: "fixture", fetchedAt: "x", fields: [], adFields: [], previous: {}, dismissedAddressKey: "1 main st|seattle|wa|98101" } }, FACTS, null, "fixture");
    const restored = { ...sub, ...patch, ...undoPrefill({ ...sub, ...patch }) };
    expect(restored.prefill?.dismissedAddressKey).toBe("1 main st|seattle|wa|98101");
    expect(restored.prefill?.fields).toEqual([]);
  });

  it("tolerates a record saved before the ad feature was removed", () => {
    const sub = normalizeManagerListingSubmissionV1({
      ...createDefaultListingSubmission(),
      tagline: "Old headline",
      prefill: { source: "fixture", fetchedAt: "x", fields: [], adFields: ["tagline"], previous: { tagline: "" }, listedRentUsd: 800, adDismissed: true } as unknown as ManagerListingSubmissionV1["prefill"],
    });
    expect(sub.prefill).not.toHaveProperty("listedRentUsd");
    expect(prefillMarkFor(sub, "tagline")).toBe("imported");
    expect({ ...sub, ...undoPrefill(sub) }.tagline).toBe("");
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
