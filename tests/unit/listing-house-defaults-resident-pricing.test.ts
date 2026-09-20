/**
 * Rent per resident and the Default card (PLAN-0920-0631): the per-resident fields
 * are never Default-card fields, a room carrying them is its own on every price
 * field for the Same-as-default-room tick and never takes a pushed default, and
 * Reset unticks it and copies the card's figure back.
 */
import { describe, expect, it } from "vitest";
import {
  applyHouseDefaultsToRooms,
  applyHouseTermPricingToRooms,
  clearRoomResidentPricing,
  emptyListingHouseDefaults,
  inferHouseDefaultsFromRooms,
  LISTING_HOUSE_DEFAULT_FIELDS,
  resetRoomFieldToDefault,
  roomFollowsTermDefault,
  roomHasResidentPricing,
  roomInheritsDefault,
  roomOverriddenDefaults,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import { createDefaultListingSubmission, type ManagerRoomSubmission } from "@/lib/manager-listing-submission";

function room(over: Partial<ManagerRoomSubmission> = {}): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: over.id ?? "room-a", monthlyRent: 1050, securityDeposit: "500", ...over };
}

function perResident(over: Partial<ManagerRoomSubmission> = {}): ManagerRoomSubmission {
  return room({
    occupancyCapacity: 2,
    residentPricing: "per_resident",
    residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }],
    ...over,
  });
}

function defaults(over: Partial<ListingHouseDefaults> = {}): ListingHouseDefaults {
  return { ...emptyListingHouseDefaults(), monthlyRent: 1050, securityDeposit: "500", utilitiesEstimate: "75", ...over };
}

describe("the per-resident fields are never Default-card fields", () => {
  it("are not in the field list and are never inferred onto the card", () => {
    expect(LISTING_HOUSE_DEFAULT_FIELDS).not.toContain("residentPricing");
    expect(LISTING_HOUSE_DEFAULT_FIELDS).not.toContain("residentPrices");
    const inferred = inferHouseDefaultsFromRooms([perResident(), perResident({ id: "room-b" })]) as unknown as Record<string, unknown>;
    expect("residentPricing" in inferred).toBe(false);
    expect("residentPrices" in inferred).toBe(false);
  });
});

describe("a room priced per resident is its own on every price field", () => {
  it("reads unticked for rent, utilities and deposit even when its figures equal the card's", () => {
    const r = perResident();
    expect(roomHasResidentPricing(r)).toBe(true);
    expect(roomInheritsDefault(r, defaults(), "monthlyRent")).toBe(false);
    expect(roomInheritsDefault(r, defaults(), "securityDeposit")).toBe(false);
    expect(roomInheritsDefault(r, defaults(), "utilitiesEstimate")).toBe(false);
    expect(roomOverriddenDefaults(r, defaults())).toEqual(expect.arrayContaining(["monthlyRent", "securityDeposit", "utilitiesEstimate"]));
  });

  it("still follows the card on a non-price field", () => {
    expect(roomInheritsDefault(perResident({ furnishing: "" }), defaults({ furnishing: "Furnished" }), "furnishing")).toBe(true);
  });

  it("does not take a pushed default rent", () => {
    const before = defaults();
    const after = defaults({ monthlyRent: 1100 });
    const [moved] = applyHouseDefaultsToRooms([perResident()], after, { previousDefaults: before });
    expect(moved!.monthlyRent).toBe(1050);
    expect(moved!.residentPrices?.map((p) => p.monthlyRent)).toEqual([900, 800]);
  });

  it("is judged only when the rows exist — a flag with no rows is not per-resident", () => {
    expect(roomHasResidentPricing(room({ residentPricing: "per_resident", residentPrices: [] }))).toBe(false);
    expect(roomInheritsDefault(room({ residentPricing: "per_resident", residentPrices: [] }), defaults(), "monthlyRent")).toBe(true);
  });
});

describe("Reset", () => {
  it("unticks per-resident and copies the card's figure back on a price field", () => {
    const reset = resetRoomFieldToDefault(perResident({ monthlyRent: 999 }), "monthlyRent", defaults());
    expect(reset.residentPricing).toBeUndefined();
    expect(reset.residentPrices).toBeUndefined();
    expect(reset.monthlyRent).toBe(1050);
    expect(roomInheritsDefault(reset, defaults(), "monthlyRent")).toBe(true);
  });

  it("leaves per-resident alone when resetting a non-price field", () => {
    const reset = resetRoomFieldToDefault(perResident({ floor: "3rd floor" }), "floor", defaults({ floor: "2nd floor" }));
    expect(reset.residentPricing).toBe("per_resident");
    expect(reset.floor).toBe("2nd floor");
  });

  it("clearRoomResidentPricing drops both fields and nothing else", () => {
    const cleared = clearRoomResidentPricing(perResident());
    expect("residentPricing" in cleared).toBe(false);
    expect("residentPrices" in cleared).toBe(false);
    expect(cleared.monthlyRent).toBe(1050);
    expect(cleared.occupancyCapacity).toBe(2);
    const plain = room();
    expect(clearRoomResidentPricing(plain)).toBe(plain);
  });
});

describe("on another lease type", () => {
  const withTerm = perResident({
    termPricing: {
      "Month-to-Month": { residentPricing: "per_resident", residentPrices: [{ monthlyRent: 1000 }, { monthlyRent: 950 }] },
      "Custom": { residentPricing: "same", monthlyRent: 1200 },
    },
  });

  it("a term with its own rows is the room's own on that term", () => {
    expect(roomHasResidentPricing(withTerm, "Month-to-Month")).toBe(true);
    expect(roomFollowsTermDefault(withTerm, "Month-to-Month", "monthlyRent", { "Month-to-Month": { monthlyRent: 1000 } })).toBe(false);
  });

  it("a term that says 'same' follows the term card again", () => {
    expect(roomHasResidentPricing(withTerm, "Custom")).toBe(false);
    expect(roomFollowsTermDefault(withTerm, "Custom", "monthlyRent", { Custom: { monthlyRent: 1200 } })).toBe(true);
  });

  it("a term that says nothing follows the room's long-term answer", () => {
    expect(roomHasResidentPricing(withTerm, "Short-Term Stay")).toBe(true);
  });

  it("a pushed term default never reaches a per-resident term", () => {
    const [moved] = applyHouseTermPricingToRooms([withTerm], "Month-to-Month", "monthlyRent", { "Month-to-Month": { monthlyRent: 1300 } }, undefined);
    expect(moved!.termPricing?.["Month-to-Month"]?.monthlyRent).toBeUndefined();
  });

  it("clearRoomResidentPricing with a term drops only that term's fields", () => {
    const cleared = clearRoomResidentPricing(withTerm, "Month-to-Month");
    expect(cleared.termPricing?.["Month-to-Month"]).toBeUndefined();
    expect(cleared.termPricing?.["Custom"]).toEqual({ residentPricing: "same", monthlyRent: 1200 });
    expect(cleared.residentPricing).toBe("per_resident");
  });
});
