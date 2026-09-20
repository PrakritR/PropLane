/**
 * Rent per resident on a shared room (PLAN-0920-0631): the headline is the LOWEST
 * slot's rent printed "from $X/mo", every slot is readable by number, a room that
 * does not price per resident still yields one entry per bed built from its own
 * figures, and a daily or weekly basis ignores the rows entirely.
 */
import { describe, expect, it } from "vitest";
import {
  roomAdvertisedPriceLabel,
  roomHeadlineAmount,
  roomHeadlinePriceIsFrom,
  roomHeadlinePriceLabel,
  roomLowestResidentRent,
  roomMonthlyEquivalent,
  roomPricesPerResident,
  roomResidentPriceForSlot,
  roomResidentPrices,
  roomResidentRentLines,
  type RoomPricingLike,
} from "@/lib/room-pricing";

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

describe("roomPricesPerResident", () => {
  it("is on only with the flag, a capacity of 2 or more and a priced row", () => {
    expect(roomPricesPerResident(sharedRoom())).toBe(true);
    expect(roomPricesPerResident(sharedRoom({ residentPricing: "same" }))).toBe(false);
    expect(roomPricesPerResident(sharedRoom({ residentPricing: undefined }))).toBe(false);
    expect(roomPricesPerResident(sharedRoom({ occupancyCapacity: 1 }))).toBe(false);
    expect(roomPricesPerResident(sharedRoom({ residentPrices: [] }))).toBe(false);
    expect(roomPricesPerResident(sharedRoom({ residentPrices: [{ monthlyRent: 0 }] }))).toBe(false);
    expect(roomPricesPerResident(null)).toBe(false);
  });

  it("is never on for a daily- or weekly-priced room — per-resident is monthly only", () => {
    expect(roomPricesPerResident(sharedRoom({ rentBasis: "daily", dailyRentPrice: 40 }))).toBe(false);
    expect(roomPricesPerResident(sharedRoom({ rentBasis: "weekly", weeklyRentPrice: 300 }))).toBe(false);
    // A basis with no rate behind it is monthly, so the rows apply again.
    expect(roomPricesPerResident(sharedRoom({ rentBasis: "daily" }))).toBe(true);
  });
});

describe("headline for a room priced per resident", () => {
  it("is the LOWEST resident rent, prefixed 'from'", () => {
    const room = sharedRoom();
    expect(roomHeadlineAmount(room)).toBe(800);
    expect(roomHeadlinePriceIsFrom(room)).toBe(true);
    expect(roomHeadlinePriceLabel(room)).toBe("from $800/mo");
    expect(roomLowestResidentRent(room)).toBe(800);
  });

  it("ranks, filters and ranges on the lowest rent", () => {
    expect(roomMonthlyEquivalent(sharedRoom())).toBe(800);
    expect(roomMonthlyEquivalent(sharedRoom({ residentPrices: [{ monthlyRent: 950 }, { monthlyRent: 1200 }] }))).toBe(950);
  });

  it("keeps 'from' under the Flexible suffix", () => {
    expect(roomAdvertisedPriceLabel(sharedRoom({ pricingMode: "flexible" }))).toBe("from $800/mo · Flexible");
  });

  it("leaves a room that does not price per resident exactly as before", () => {
    const room = sharedRoom({ residentPricing: undefined, residentPrices: undefined });
    expect(roomHeadlineAmount(room)).toBe(1000);
    expect(roomHeadlinePriceIsFrom(room)).toBe(false);
    expect(roomHeadlinePriceLabel(room)).toBe("$1,000/mo");
    expect(roomMonthlyEquivalent(room)).toBe(1000);
    expect(roomLowestResidentRent(room)).toBeUndefined();
  });

  it("prints the daily rate, not 'from', on a daily room that still stores rows", () => {
    const room = sharedRoom({ rentBasis: "daily", dailyRentPrice: 40 });
    expect(roomHeadlinePriceLabel(room)).toBe("$40/day");
    expect(roomHeadlineAmount(room)).toBe(40);
    expect(roomResidentRentLines(room)).toEqual([]);
  });
});

describe("roomResidentPrices", () => {
  it("resolves one entry per slot, 1-based, with blanks filled from the room", () => {
    const rows = roomResidentPrices(sharedRoom({ residentPrices: [{ monthlyRent: 900, securityDeposit: "300" }, { monthlyRent: 800 }] }));
    expect(rows).toEqual([
      { slot: 1, monthlyRent: 900, utilitiesEstimate: "75", securityDeposit: "300" },
      { slot: 2, monthlyRent: 800, utilitiesEstimate: "75", securityDeposit: "250" },
    ]);
  });

  it("fills a missing or zero rent from the room's rent and pads short lists from the last row", () => {
    const rows = roomResidentPrices(sharedRoom({ occupancyCapacity: 3, residentPrices: [{ monthlyRent: 0 }, { monthlyRent: 800 }] }));
    expect(rows.map((r) => [r.slot, r.monthlyRent])).toEqual([
      [1, 1000],
      [2, 800],
      [3, 800],
    ]);
  });

  it("falls back to one entry per bed from the room's own figures when per-resident is off", () => {
    const rows = roomResidentPrices(sharedRoom({ residentPricing: undefined, residentPrices: undefined }));
    expect(rows).toEqual([
      { slot: 1, monthlyRent: 1000, utilitiesEstimate: "75", securityDeposit: "250" },
      { slot: 2, monthlyRent: 1000, utilitiesEstimate: "75", securityDeposit: "250" },
    ]);
    expect(roomResidentPrices({ monthlyRent: 950 })).toEqual([{ slot: 1, monthlyRent: 950 }]);
    expect(roomResidentPrices(null)).toEqual([]);
  });

  it("looks a slot up by number", () => {
    expect(roomResidentPriceForSlot(sharedRoom(), 2)).toMatchObject({ slot: 2, monthlyRent: 800 });
    expect(roomResidentPriceForSlot(sharedRoom(), 3)).toBeUndefined();
    expect(roomResidentPriceForSlot(sharedRoom(), 0)).toBeUndefined();
  });

  it("prints one line per slot for the public room detail", () => {
    expect(roomResidentRentLines(sharedRoom())).toEqual(["Resident 1 · $900/mo", "Resident 2 · $800/mo"]);
    expect(roomResidentRentLines(sharedRoom({ residentPricing: undefined }))).toEqual([]);
  });
});

describe("per-term resident pricing", () => {
  const withTerm = sharedRoom({
    termPricing: {
      "Month-to-Month": {
        monthlyRent: 1100,
        residentPricing: "per_resident",
        residentPrices: [{ monthlyRent: 1000 }, { monthlyRent: 950 }],
      },
      "Short-Term Stay": { residentPricing: "same" },
    },
  });

  it("reads the term's own rows when the term carries them", () => {
    expect(roomPricesPerResident(withTerm, "Month-to-Month")).toBe(true);
    expect(roomLowestResidentRent(withTerm, "Month-to-Month")).toBe(950);
    expect(roomResidentPriceForSlot(withTerm, 1, "Month-to-Month")).toMatchObject({ monthlyRent: 1000 });
  });

  it("follows long-term on a term that says nothing", () => {
    expect(roomPricesPerResident(withTerm, "Custom")).toBe(true);
    expect(roomResidentPrices(withTerm, "Custom").map((r) => r.monthlyRent)).toEqual([900, 800]);
  });

  it("turns off on a term that says 'same', falling back to that term's one rent", () => {
    expect(roomPricesPerResident(withTerm, "Short-Term Stay")).toBe(false);
    const rows = roomResidentPrices(withTerm, "Short-Term Stay");
    expect(rows.map((r) => r.monthlyRent)).toEqual([1000, 1000]);
  });

  it("fills a blank term rent from the term's rent before the room's", () => {
    const room = sharedRoom({
      termPricing: { "Month-to-Month": { monthlyRent: 1100, residentPricing: "per_resident", residentPrices: [{ monthlyRent: 0 }, { monthlyRent: 0 }] } },
    });
    expect(roomResidentPrices(room, "Month-to-Month").map((r) => r.monthlyRent)).toEqual([1100, 1100]);
  });
});
