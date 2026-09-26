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
