import { describe, expect, it } from "vitest";
import { buildListingSubmissionFromDraftInput } from "@/lib/listing-draft-agent.server";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

describe("buildListingSubmissionFromDraftInput", () => {
  it("builds a normalized submission with rent, beds, and photos", () => {
    const sub = buildListingSubmissionFromDraftInput({
      buildingName: "Oak House",
      address: "123 Main St",
      zip: "94102",
      beds: 3,
      baths: 2,
      monthlyRentUsd: 3200,
      tagline: "Sunny rooms near transit",
      houseOverview: "Bright shared home with yard.",
      amenitiesText: "Laundry\nParking",
      petFriendly: true,
      housePhotoUrls: ["https://example.com/storage/v1/object/public/listing-photos/u/1.jpg"],
    });

    expect(sub.buildingName).toBe("Oak House");
    expect(sub.address).toBe("123 Main St");
    expect(sub.listingBedroomSlots).toBe(3);
    expect(sub.listingTotalBathroomsId).toBe("2");
    expect(sub.bathrooms).toHaveLength(2);
    expect(sub.rooms[0]?.monthlyRent).toBe(3200);
    expect(sub.petFriendly).toBe(true);
    expect(sub.housePhotoDataUrls).toHaveLength(1);
    expect(sub.amenitiesText).toContain("Laundry");
  });

  it("merges new photos onto an existing draft", () => {
    const existing = createDefaultListingSubmission();
    existing.housePhotoDataUrls = ["https://example.com/storage/v1/object/public/listing-photos/u/a.jpg"];

    const sub = buildListingSubmissionFromDraftInput(
      {
        buildingName: "Oak House",
        address: "123 Main St",
        beds: 2,
        baths: 1,
        monthlyRentUsd: 900,
        housePhotoUrls: ["https://example.com/storage/v1/object/public/listing-photos/u/b.jpg"],
      },
      existing,
    );

    expect(sub.housePhotoDataUrls).toEqual([
      "https://example.com/storage/v1/object/public/listing-photos/u/a.jpg",
      "https://example.com/storage/v1/object/public/listing-photos/u/b.jpg",
    ]);
  });
});
