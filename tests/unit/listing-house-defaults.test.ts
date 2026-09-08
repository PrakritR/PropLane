/**
 * House defaults and per-room inheritance — the core of the redesigned wizard.
 *
 * The safety rule that matters most: inheritance must never set a room's billing
 * basis. Per docs/agents/rent-basis.md a daily basis changes how every rent
 * charge is computed and may only be set by an explicit act on that room.
 */
import { describe, expect, it } from "vitest";
import {
  applyHouseDefaultsToRooms,
  emptyListingHouseDefaults,
  inferHouseDefaultsFromRooms,
  roomInheritsDefault,
  roomOverriddenDefaults,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import { createDefaultListingSubmission, type ManagerRoomSubmission } from "@/lib/manager-listing-submission";

function room(over: Partial<ManagerRoomSubmission> = {}): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: over.id ?? `room-${Math.random().toString(36).slice(2, 8)}`, ...over };
}

function defaults(over: Partial<ListingHouseDefaults> = {}): ListingHouseDefaults {
  return { ...emptyListingHouseDefaults(), monthlyRent: 1050, securityDeposit: "500", furnishing: "Furnished", ...over };
}

describe("roomInheritsDefault", () => {
  it("treats a matching value as inherited", () => {
    expect(roomInheritsDefault(room({ monthlyRent: 1050 }), defaults(), "monthlyRent")).toBe(true);
  });

  it("treats a blank value as inherited, so editing the default fills it in", () => {
    expect(roomInheritsDefault(room({ monthlyRent: 0 }), defaults(), "monthlyRent")).toBe(true);
    expect(roomInheritsDefault(room({ securityDeposit: "" }), defaults(), "securityDeposit")).toBe(true);
  });

  it("treats a different value as an override", () => {
    expect(roomInheritsDefault(room({ monthlyRent: 1200 }), defaults(), "monthlyRent")).toBe(false);
  });

  it("compares booleans exactly, since false is a real answer not a blank", () => {
    const d = defaults({ moveInInspectionRequired: true });
    expect(roomInheritsDefault(room({ moveInInspectionRequired: false }), d, "moveInInspectionRequired")).toBe(false);
    expect(roomInheritsDefault(room({ moveInInspectionRequired: true }), d, "moveInInspectionRequired")).toBe(true);
  });
});

describe("applyHouseDefaultsToRooms", () => {
  it("fills every room that was following the default", () => {
    const rooms = [room({ id: "a", monthlyRent: 0 }), room({ id: "b", monthlyRent: 1050 })];
    const out = applyHouseDefaultsToRooms(rooms, defaults({ monthlyRent: 1100 }), {
      previousDefaults: defaults({ monthlyRent: 1050 }),
    });
    expect(out.map((r) => r.monthlyRent)).toEqual([1100, 1100]);
  });

  it("leaves a room that had diverged alone", () => {
    const rooms = [room({ id: "a", monthlyRent: 1200 }), room({ id: "b", monthlyRent: 1050 })];
    const out = applyHouseDefaultsToRooms(rooms, defaults({ monthlyRent: 1100 }), {
      previousDefaults: defaults({ monthlyRent: 1050 }),
    });
    expect(out.map((r) => r.monthlyRent)).toEqual([1200, 1100]);
  });

  it("judges inheritance against the OLD default, never the new one", () => {
    // Without previousDefaults every room reads as diverged and nothing moves.
    const rooms = [room({ id: "a", monthlyRent: 1050 })];
    const frozen = applyHouseDefaultsToRooms(rooms, defaults({ monthlyRent: 1100 }));
    expect(frozen[0]!.monthlyRent).toBe(1050);
    const moved = applyHouseDefaultsToRooms(rooms, defaults({ monthlyRent: 1100 }), {
      previousDefaults: defaults({ monthlyRent: 1050 }),
    });
    expect(moved[0]!.monthlyRent).toBe(1100);
  });

  it("overriding one field does not freeze the others", () => {
    // Room A set its own rent. Changing the house furnishing must still reach it.
    const rooms = [room({ id: "a", monthlyRent: 1200, furnishing: "" })];
    const out = applyHouseDefaultsToRooms(rooms, defaults({ furnishing: "Unfurnished" }), {
      previousDefaults: defaults(),
    });
    expect(out[0]!.monthlyRent).toBe(1200);
    expect(out[0]!.furnishing).toBe("Unfurnished");
  });

  it("an explicit apply-to-these-rooms overwrites even an override", () => {
    const rooms = [room({ id: "a", monthlyRent: 1200 }), room({ id: "b", monthlyRent: 900 })];
    const out = applyHouseDefaultsToRooms(rooms, defaults({ monthlyRent: 1100 }), {
      onlyFields: ["monthlyRent"],
      roomIds: ["a"],
    });
    expect(out.map((r) => r.monthlyRent)).toEqual([1100, 900]);
  });

  it("NEVER sets a billing basis or a daily price", () => {
    // The whole point: a default may carry the monthly figure and nothing that
    // changes how the room is billed.
    const rooms = [room({ id: "a", monthlyRent: 0, rentBasis: undefined, dailyRentPrice: undefined })];
    const out = applyHouseDefaultsToRooms(rooms, defaults({ monthlyRent: 1100 }));
    expect(out[0]!.rentBasis).toBeUndefined();
    expect(out[0]!.dailyRentPrice).toBeUndefined();
  });

  it("keeps a room's own daily basis untouched while still updating its monthly figure", () => {
    const rooms = [room({ id: "a", monthlyRent: 0, rentBasis: "daily", dailyRentPrice: 60 })];
    const out = applyHouseDefaultsToRooms(rooms, defaults({ monthlyRent: 1100 }));
    expect(out[0]!.rentBasis).toBe("daily");
    expect(out[0]!.dailyRentPrice).toBe(60);
    expect(out[0]!.monthlyRent).toBe(1100);
  });
});

describe("roomOverriddenDefaults", () => {
  it("names exactly the fields that differ", () => {
    const d = defaults();
    const r = room({ monthlyRent: 1200, securityDeposit: "500", furnishing: "Unfurnished" });
    expect(roomOverriddenDefaults(r, d).sort()).toEqual(["furnishing", "monthlyRent"]);
  });

  it("a field the house never set can never read as an override", () => {
    // The default utilities model is blank, so a room carrying the seeded
    // "manager_billed" is not diverging from anything.
    const d = defaults();
    expect(d.utilitiesPaymentModel).toBe("");
    expect(roomOverriddenDefaults(room({ utilitiesPaymentModel: "manager_billed" }), d)).toEqual([]);
  });

  it("is empty for a room that matches the house", () => {
    const d = defaults();
    expect(roomOverriddenDefaults(room({ monthlyRent: 1050, securityDeposit: "500", furnishing: "Furnished" }), d)).toEqual([]);
  });
});

describe("inferHouseDefaultsFromRooms", () => {
  it("picks the most common value so an existing listing opens with a sensible band", () => {
    const rooms = [
      room({ monthlyRent: 1050 }),
      room({ monthlyRent: 1050 }),
      room({ monthlyRent: 1400 }),
    ];
    expect(inferHouseDefaultsFromRooms(rooms).monthlyRent).toBe(1050);
  });

  it("ignores blank rooms rather than defaulting the house to nothing", () => {
    const rooms = [room({ monthlyRent: 0 }), room({ monthlyRent: 0 }), room({ monthlyRent: 1200 })];
    expect(inferHouseDefaultsFromRooms(rooms).monthlyRent).toBe(1200);
  });

  it("returns empty defaults for a listing with no rooms", () => {
    expect(inferHouseDefaultsFromRooms([])).toEqual(emptyListingHouseDefaults());
  });
});
