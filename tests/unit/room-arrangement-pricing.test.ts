import { describe, expect, it } from "vitest";
import {
  arrangementSummaryLine,
  offeredResidentCountsFor,
  roomPriceForResidentCount,
  roomSharingOptions,
} from "@/lib/room-arrangement-pricing";

const room = {
  monthlyRent: 1000,
  utilitiesEstimate: "80",
  securityDeposit: "500",
  occupancyCapacity: 3,
  offeredResidentCounts: [1, 2, 3],
  occupancyPrices: [
    { count: 1, monthlyRent: 1000, utilitiesEstimate: "80", securityDeposit: "500" },
    { count: 2, monthlyRent: 900, utilitiesEstimate: "80", securityDeposit: "500" },
    { count: 3, sameAs: 2 },
  ],
};

describe("room arrangement pricing", () => {
  it("resolves Same as to the smaller arrangement", () => {
    expect(roomPriceForResidentCount(room, 3).monthlyRent).toBe(900);
    expect(roomPriceForResidentCount(room, 2).monthlyRent).toBe(900);
    expect(roomPriceForResidentCount(room, 1).monthlyRent).toBe(1000);
  });

  it("falls back to the room rent when no occupancy rows exist", () => {
    expect(roomPriceForResidentCount({ monthlyRent: 750, occupancyCapacity: 2 }, 2).monthlyRent).toBe(750);
  });

  it("offers every count through capacity when the list is absent", () => {
    expect(offeredResidentCountsFor({ occupancyCapacity: 3 })).toEqual([1, 2, 3]);
  });

  it("hides counts already filled by people living there", () => {
    expect(roomSharingOptions(room, 1)).toEqual([2, 3]);
    expect(roomSharingOptions(room, 3)).toEqual([]);
  });

  it("summarizes each offered arrangement", () => {
    expect(arrangementSummaryLine(room)).toContain("Private $1,000");
    expect(arrangementSummaryLine(room)).toContain("Shared by 2 $900 each");
    expect(arrangementSummaryLine(room)).toContain("Shared by 3 $900 each");
  });
});

// N082: each arrangement's own Partial months answer — the same `sameAs`
// inheritance rent/utilities/deposit already use, extended to
// `prorateMethod` / `dailyRentRate` / `dailyUtilitiesRate`.
describe("room arrangement pricing — partial months per arrangement (N082)", () => {
  it("resolves an arrangement's own per-day rate when it set one", () => {
    const withProrate = {
      ...room,
      occupancyPrices: [
        { count: 1, monthlyRent: 1000, utilitiesEstimate: "80", securityDeposit: "500" },
        {
          count: 2,
          monthlyRent: 900,
          utilitiesEstimate: "80",
          securityDeposit: "500",
          prorateMethod: "daily_rate" as const,
          dailyRentRate: 32,
          dailyUtilitiesRate: 4,
        },
        { count: 3, sameAs: 2 },
      ],
    };
    const resolved = roomPriceForResidentCount(withProrate, 2);
    expect(resolved.prorateMethod).toBe("daily_rate");
    expect(resolved.dailyRentRate).toBe(32);
    expect(resolved.dailyUtilitiesRate).toBe(4);
  });

  it("a Same-as arrangement inherits the target's partial-months answer, not the room's", () => {
    const withProrate = {
      ...room,
      // The room itself is "auto" (no prorateMethod), but count 2 set its own per-day rate.
      occupancyPrices: [
        { count: 1, monthlyRent: 1000, utilitiesEstimate: "80", securityDeposit: "500" },
        {
          count: 2,
          monthlyRent: 900,
          utilitiesEstimate: "80",
          securityDeposit: "500",
          prorateMethod: "daily_rate" as const,
          dailyRentRate: 32,
        },
        { count: 3, sameAs: 2 },
      ],
    };
    // count 3 is "Same as 2" — it must resolve to count 2's answer, not the room default.
    const resolved = roomPriceForResidentCount(withProrate, 3);
    expect(resolved.prorateMethod).toBe("daily_rate");
    expect(resolved.dailyRentRate).toBe(32);
  });

  it("defaults to automatic partial months when nothing is set anywhere", () => {
    const resolved = roomPriceForResidentCount(room, 2);
    expect(resolved.prorateMethod).toBe("auto");
    expect(resolved.dailyRentRate).toBeUndefined();
    expect(resolved.dailyUtilitiesRate).toBeUndefined();
  });

  it("falls back to the room's own top-level prorate fields when no occupancy row is set", () => {
    const resolved = roomPriceForResidentCount(
      { monthlyRent: 750, occupancyCapacity: 2, prorateMethod: "daily_rate" as const, dailyRentRate: 25 },
      2,
    );
    expect(resolved.prorateMethod).toBe("daily_rate");
    expect(resolved.dailyRentRate).toBe(25);
  });
});
