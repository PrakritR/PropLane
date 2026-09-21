/**
 * Normalization of rent per resident on a shared room (PLAN-0920-0631): rows are
 * clamped to the room's capacity, padded from the last row or the room's figures,
 * a blank rent falls back to the room's, both fields drop at capacity 1, and the
 * per-term block follows the same rules with the term's rent as its fallback.
 */
import { describe, expect, it } from "vitest";
import {
  clampRoomResidentPrices,
  createDefaultListingSubmission,
  duplicateRoomEntry,
  normalizeManagerListingSubmissionV1,
  reconcileRoomResidentPricing,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

function listingWith(room: Partial<ManagerRoomSubmission>): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  const first = base.rooms[0]!;
  return {
    ...base,
    rooms: [{ ...first, monthlyRent: 1000, utilitiesEstimate: "75", securityDeposit: "250", occupancyCapacity: 2, ...room }],
  };
}

function normalizedRoom(room: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  return normalizeManagerListingSubmissionV1(listingWith(room)).rooms[0]!;
}

describe("normalizing residentPricing / residentPrices", () => {
  it("keeps the rows on a shared room ticked per resident", () => {
    const room = normalizedRoom({
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800, securityDeposit: "$300" }],
    });
    expect(room.residentPricing).toBe("per_resident");
    expect(room.residentPrices).toEqual([{ monthlyRent: 900 }, { monthlyRent: 800, securityDeposit: "300" }]);
  });

  it("leaves a room that never had the fields byte-identical (no keys added)", () => {
    const room = normalizedRoom({});
    expect("residentPricing" in room).toBe(false);
    expect("residentPrices" in room).toBe(false);
  });

  it("drops both fields when the room holds one resident, keeping the room's own figures", () => {
    const room = normalizedRoom({
      occupancyCapacity: 1,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }],
    });
    expect(room.residentPricing).toBeUndefined();
    expect(room.residentPrices).toBeUndefined();
    expect(room.monthlyRent).toBe(1000);
    expect(room.securityDeposit).toBe("250");
  });

  it("never stores 'same' on the room, and drops rows saved under it", () => {
    const room = normalizedRoom({ residentPricing: "same", residentPrices: [{ monthlyRent: 900 }] });
    expect(room.residentPricing).toBeUndefined();
    expect(room.residentPrices).toBeUndefined();
  });

  it("truncates rows beyond the capacity", () => {
    const room = normalizedRoom({
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }, { monthlyRent: 700 }],
    });
    expect(room.residentPrices?.map((r) => r.monthlyRent)).toEqual([900, 800]);
  });

  it("pads missing rows from the last row", () => {
    const room = normalizedRoom({
      occupancyCapacity: 3,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800, utilitiesEstimate: "60" }],
    });
    expect(room.residentPrices).toEqual([
      { monthlyRent: 900 },
      { monthlyRent: 800, utilitiesEstimate: "60" },
      { monthlyRent: 800, utilitiesEstimate: "60" },
    ]);
  });

  it("pads from the room's own figures when there are no rows at all", () => {
    const room = normalizedRoom({ residentPricing: "per_resident", residentPrices: [] });
    expect(room.residentPrices).toEqual([
      { monthlyRent: 1000, utilitiesEstimate: "75", securityDeposit: "250", pricingMode: "fixed" },
      { monthlyRent: 1000, utilitiesEstimate: "75", securityDeposit: "250", pricingMode: "fixed" },
    ]);
  });

  it("falls a blank or zero resident rent back to the room's rent — never a $0 lease", () => {
    const room = normalizedRoom({
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 0 }, { monthlyRent: "abc" as unknown as number }],
    });
    expect(room.residentPrices?.map((r) => r.monthlyRent)).toEqual([1000, 1000]);
  });

  it("drops junk entries and strips a leading $ from money strings", () => {
    const room = normalizedRoom({
      residentPricing: "per_resident",
      residentPrices: [null as unknown as { monthlyRent: number }, { monthlyRent: "$1,200" as unknown as number, utilitiesEstimate: "$80", pricingMode: "flexible" }],
    });
    expect(room.residentPrices).toEqual([
      { monthlyRent: 1200, utilitiesEstimate: "80", pricingMode: "flexible" },
      { monthlyRent: 1200, utilitiesEstimate: "80", pricingMode: "flexible" },
    ]);
  });
});

describe("the per-term block", () => {
  it("clamps a term's rows to capacity with the term's rent as the fallback", () => {
    const room = normalizedRoom({
      occupancyCapacity: 3,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }],
      termPricing: {
        "Month-to-Month": {
          monthlyRent: 1100,
          residentPricing: "per_resident",
          residentPrices: [{ monthlyRent: 0 }, { monthlyRent: 950 }, { monthlyRent: 940 }, { monthlyRent: 1 }],
        },
      },
    });
    expect(room.termPricing?.["Month-to-Month"]).toEqual({
      monthlyRent: 1100,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 1100 }, { monthlyRent: 950 }, { monthlyRent: 940 }],
    });
  });

  it("keeps a term's 'same' only while the room prices per resident", () => {
    const on = normalizedRoom({
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }],
      termPricing: { "Month-to-Month": { residentPricing: "same", residentPrices: [{ monthlyRent: 1 }] } },
    });
    expect(on.termPricing?.["Month-to-Month"]).toEqual({ residentPricing: "same" });

    const off = normalizedRoom({
      termPricing: { "Month-to-Month": { monthlyRent: 1100, residentPricing: "same" } },
    });
    expect(off.termPricing?.["Month-to-Month"]).toEqual({ monthlyRent: 1100 });
  });

  it("drops a term's rows when the room holds one resident, and an entry left empty with them", () => {
    const room = normalizedRoom({
      occupancyCapacity: 1,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }],
      termPricing: { "Month-to-Month": { residentPricing: "per_resident", residentPrices: [{ monthlyRent: 950 }] } },
    });
    expect(room.termPricing).toBeUndefined();
  });

  it("keeps a term's per_resident rows while the room itself does not price per resident", () => {
    const room = normalizedRoom({
      occupancyCapacity: 2,
      termPricing: {
        "Month-to-Month": {
          monthlyRent: 1300,
          residentPricing: "per_resident",
          residentPrices: [{ monthlyRent: 0 }],
        },
      },
    });
    expect(room.termPricing?.["Month-to-Month"]).toEqual({
      monthlyRent: 1300,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 1300 }, { monthlyRent: 1300 }],
    });
    expect(room.residentPricing).toBeUndefined();
  });
});

describe("clampRoomResidentPrices / reconcileRoomResidentPricing (pure, for the Pricing card)", () => {
  it("returns undefined below a capacity of 2", () => {
    expect(clampRoomResidentPrices([{ monthlyRent: 900 }], 1, { monthlyRent: 1000 })).toBeUndefined();
    expect(clampRoomResidentPrices([{ monthlyRent: 900 }], 0, { monthlyRent: 1000 })).toBeUndefined();
  });

  it("raising a capacity adds a row prefilled from the last row", () => {
    expect(clampRoomResidentPrices([{ monthlyRent: 900 }, { monthlyRent: 800 }], 3, { monthlyRent: 1000 })).toEqual([
      { monthlyRent: 900 },
      { monthlyRent: 800 },
      { monthlyRent: 800 },
    ]);
  });

  it("reconciles a wizard-edited room the same way the normalizer does", () => {
    const base = createDefaultListingSubmission().rooms[0]!;
    const room: ManagerRoomSubmission = {
      ...base,
      monthlyRent: 1000,
      occupancyCapacity: 2,
      residentPricing: "per_resident",
      residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }, { monthlyRent: 700 }],
    };
    expect(reconcileRoomResidentPricing(room).residentPrices?.map((r) => r.monthlyRent)).toEqual([900, 800]);
    expect(reconcileRoomResidentPricing({ ...room, occupancyCapacity: 1 }).residentPricing).toBeUndefined();
  });
});

describe("duplicateRoomEntry", () => {
  it("copies the resident rows so the duplicate can be edited on its own", () => {
    const source = normalizedRoom({ residentPricing: "per_resident", residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }] });
    const copy = duplicateRoomEntry(source);
    expect(copy.residentPrices).toEqual(source.residentPrices);
    expect(copy.residentPrices).not.toBe(source.residentPrices);
    expect(copy.residentPrices![0]).not.toBe(source.residentPrices![0]);
  });
});
