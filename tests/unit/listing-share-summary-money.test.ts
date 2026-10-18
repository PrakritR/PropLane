import { describe, expect, it } from "vitest";
import type { MockProperty } from "@/data/types";
import { buildListingShareSummary } from "@/lib/listing-share-summary";
import { emptyRoom } from "@/lib/manager-listing-submission";

function property(over: Partial<MockProperty>): MockProperty {
  return {
    id: "p1",
    title: "Ballard House",
    address: "1 Ballard Ave",
    neighborhood: "Ballard",
    beds: 0,
    baths: 0,
    petFriendly: false,
    ...over,
  } as MockProperty;
}

describe("Send listing preview money", () => {
  it("prints the rent through the one money format", () => {
    const summary = buildListingShareSummary(property({ rentLabel: "$1000" }));
    expect(summary.detailLines).toContain("Rent: $1,000");
    const cents = buildListingShareSummary(property({ rentLabel: "$1000.00/mo" }));
    expect(cents.detailLines).toContain("Rent: $1,000/mo");
  });

  it("names a chosen room by its one monthly figure, a daily room by its 30-day amount", () => {
    const sub = {
      v: 1,
      bathrooms: [],
      sharedSpaces: [],
      rooms: [{ ...emptyRoom(0), id: "r3", name: "Room 3", monthlyRent: 1050, rentBasis: "daily", dailyRentPrice: 45 }],
    } as unknown as MockProperty["listingSubmission"];
    const summary = buildListingShareSummary(property({ listingSubmission: sub, rentLabel: "" }), { roomId: "r3" });
    expect(summary.detailLines).toContain("Room 3 · $1,350/mo");
  });
});
