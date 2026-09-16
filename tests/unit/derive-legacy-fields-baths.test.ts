import { describe, expect, it } from "vitest";
import { deriveLegacyFields } from "@/lib/demo-property-pipeline";
import { createDefaultListingSubmission, listingBathroomCountForDisplay } from "@/lib/manager-listing-submission";

describe("deriveLegacyFields bathroom count", () => {
  it("writes baths from the Basics bathroom id even when bathroom cards were never created", () => {
    const sub = createDefaultListingSubmission();
    sub.listingTotalBathroomsId = "3";
    sub.bathrooms = [];
    sub.rooms = Array.from({ length: 9 }, (_, i) => ({
      ...sub.rooms[0]!,
      id: `r${i + 1}`,
      name: `Room ${i + 1}`,
    }));
    expect(deriveLegacyFields(sub).baths).toBe(3);
    expect(deriveLegacyFields(sub).beds).toBe(9);
  });

  it("keeps half baths as 1.5 rather than the two-card count", () => {
    const sub = createDefaultListingSubmission();
    sub.listingTotalBathroomsId = "1.5";
    expect(listingBathroomCountForDisplay(sub)).toBe(1.5);
    expect(deriveLegacyFields(sub).baths).toBe(1.5);
  });

  it("falls back to 1 when Basics never set a bathroom count", () => {
    const sub = createDefaultListingSubmission();
    expect(listingBathroomCountForDisplay(sub)).toBe(1);
    expect(deriveLegacyFields(sub).baths).toBe(1);
  });
});
