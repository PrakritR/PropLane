import { describe, expect, it } from "vitest";
import type { MockProperty } from "@/data/types";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { buildListingShareSummary } from "@/lib/listing-share-summary";

function house(roomCount: number): MockProperty {
  const submission = createDefaultListingSubmission();
  submission.rooms = Array.from({ length: roomCount }, (_, i) => ({ ...submission.rooms[0]!, id: `r${i}`, name: `Room ${i + 1}` }));
  return {
    id: "h", title: "House", tagline: "", address: "1 Main St", zip: "98105", neighborhood: "", beds: roomCount, baths: 1,
    rentLabel: "", available: "", petFriendly: false, buildingId: "b", buildingName: "House", unitLabel: "", adminPublishLive: true,
    listingSubmission: submission,
  } as MockProperty;
}

describe("share summary room line", () => {
  it("with an open-now read: 'N of M rooms open now'", () => {
    const lines = buildListingShareSummary(house(9), { openNow: 2 }).detailLines;
    expect(lines).toContain("2 of 9 rooms open now");
    expect(lines.join("\n")).not.toMatch(/9 rooms available/);
  });
  it("zero open is stated, not hidden", () => {
    expect(buildListingShareSummary(house(3), { openNow: 0 }).detailLines).toContain("0 of 3 rooms open now");
  });
  it("without a read: the room count and no availability claim", () => {
    for (const options of [undefined, {}, { openNow: null }]) {
      const lines = buildListingShareSummary(house(9), options).detailLines;
      expect(lines).toContain("9 rooms");
      expect(lines.join("\n")).not.toMatch(/available|open now/i);
    }
  });
});
