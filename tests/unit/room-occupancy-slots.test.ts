/**
 * Which resident slot a placement holds on a room priced per resident
 * (PLAN-0920-0631) — the decision the approval picker and the approval route
 * both read through `openResidentSlots`, so a stale client picker can never
 * write a rent the server would refuse.
 */
import { describe, expect, it } from "vitest";
import { openResidentSlots, type RoomResidentSlotPlacement } from "@/lib/rental-application/room-occupancy";
import type { RoomPricingLike } from "@/lib/room-pricing";

function d(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day);
}

function sharedRoom(over: Partial<RoomPricingLike> = {}): RoomPricingLike {
  return {
    monthlyRent: 1000,
    utilitiesEstimate: "75",
    securityDeposit: "250",
    occupancyCapacity: 2,
    residentPricing: "per_resident",
    residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }],
    ...over,
  };
}

function holder(over: Partial<RoomResidentSlotPlacement> & { id: string; start: Date }): RoomResidentSlotPlacement {
  return { end: null, ...over };
}

describe("openResidentSlots", () => {
  it("is empty only for a one-resident room; capacity ≥ 2 always expands beds", () => {
    expect(openResidentSlots({ room: sharedRoom({ occupancyCapacity: 1 }), placements: [] })).toEqual([]);
    const withoutFlag = openResidentSlots({
      room: sharedRoom({ residentPricing: undefined, residentPrices: undefined }),
      placements: [],
    });
    expect(withoutFlag).toHaveLength(2);
    expect(withoutFlag.map((s) => s.price.monthlyRent)).toEqual([1000, 1000]);
  });

  it("every slot is open, with its price, when no one holds the room yet", () => {
    const slots = openResidentSlots({ room: sharedRoom(), placements: [], at: d(2026, 9, 1) });
    expect(slots).toEqual([
      { slot: 1, price: { slot: 1, monthlyRent: 900, utilitiesEstimate: "75", securityDeposit: "250" }, holder: null },
      { slot: 2, price: { slot: 2, monthlyRent: 800, utilitiesEstimate: "75", securityDeposit: "250" }, holder: null },
    ]);
  });

  it("a placement's OWN stored slot wins, whatever order it is given in", () => {
    const aaron = holder({ id: "aaron", start: d(2026, 9, 1), residentSlot: 1, holderName: "Aaron" });
    const grace = holder({ id: "grace", start: d(2026, 9, 5), residentSlot: 2, holderName: "Grace" });
    const slots = openResidentSlots({ room: sharedRoom(), placements: [grace, aaron], at: d(2026, 9, 10) });
    expect(slots[0]!.holder).toEqual({ name: "Aaron", since: d(2026, 9, 1) });
    expect(slots[1]!.holder).toEqual({ name: "Grace", since: d(2026, 9, 5) });
  });

  it("a placement with no stored slot takes the lowest FREE slot in approval order", () => {
    // Aaron approved first with no stored slot (an older row, before the slot was
    // stamped) takes slot 1; Grace, approved after, takes the next free one.
    const aaron = holder({ id: "aaron", start: d(2026, 9, 1), holderName: "Aaron" });
    const grace = holder({ id: "grace", start: d(2026, 9, 5), holderName: "Grace" });
    const slots = openResidentSlots({ room: sharedRoom(), placements: [aaron, grace], at: d(2026, 9, 10) });
    expect(slots[0]!.holder?.name).toBe("Aaron");
    expect(slots[1]!.holder?.name).toBe("Grace");
  });

  it("an inferred slot never steps on one another placement explicitly stores", () => {
    // Grace has no stored slot but is listed FIRST; Aaron stores slot 1 explicitly.
    // Grace must not grab slot 1 out from under Aaron's own record.
    const grace = holder({ id: "grace", start: d(2026, 9, 1), holderName: "Grace" });
    const aaron = holder({ id: "aaron", start: d(2026, 9, 5), residentSlot: 1, holderName: "Aaron" });
    const slots = openResidentSlots({ room: sharedRoom(), placements: [grace, aaron], at: d(2026, 9, 10) });
    expect(slots[0]!.holder?.name).toBe("Aaron");
    expect(slots[1]!.holder?.name).toBe("Grace");
  });

  it("a moved-out placement frees its slot again as of `at`", () => {
    const aaron = holder({ id: "aaron", start: d(2026, 1, 1), end: d(2026, 8, 31), residentSlot: 1, holderName: "Aaron" });
    const slots = openResidentSlots({ room: sharedRoom(), placements: [aaron], at: d(2026, 9, 10) });
    expect(slots[0]!.holder).toBeNull();
  });

  it("an open-ended stay holds its slot forever", () => {
    const aaron = holder({ id: "aaron", start: d(2026, 1, 1), end: null, residentSlot: 1, holderName: "Aaron" });
    const slots = openResidentSlots({ room: sharedRoom(), placements: [aaron], at: d(2030, 1, 1) });
    expect(slots[0]!.holder?.name).toBe("Aaron");
  });

  it("an UPCOMING stay (not yet started) still counts as a holder, same as the bed guard", () => {
    const aaron = holder({ id: "aaron", start: d(2026, 12, 1), end: null, residentSlot: 1, holderName: "Aaron" });
    const slots = openResidentSlots({ room: sharedRoom(), placements: [aaron], at: d(2026, 9, 10) });
    expect(slots[0]!.holder?.name).toBe("Aaron");
  });

  it("every slot taken leaves no open row, matching the room's arbitrated last bed", () => {
    const aaron = holder({ id: "aaron", start: d(2026, 9, 1), residentSlot: 1, holderName: "Aaron" });
    const grace = holder({ id: "grace", start: d(2026, 9, 5), residentSlot: 2, holderName: "Grace" });
    const slots = openResidentSlots({ room: sharedRoom(), placements: [aaron, grace], at: d(2026, 9, 10) });
    expect(slots.every((s) => s.holder !== null)).toBe(true);
  });
});
