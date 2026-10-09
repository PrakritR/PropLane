import { describe, expect, it } from "vitest";
import { buildAirbnbListingPackFromSubmission } from "@/lib/channel-calendar/listing-pack";

const sub = {
  buildingName: "Maple House",
  address: "12 Maple St",
  city: "Seattle",
  neighborhood: "University District Northeast",
  houseOverview: "A bright coliving house.",
  houseRulesText: "Quiet hours 10pm.",
  petFriendly: true,
  housePhotoDataUrls: ["https://x/h1.jpg"],
  rooms: [{ id: "r1", name: "Room 1", monthlyRent: 900, roomAmenitiesText: "Desk\nWi-Fi, Closet", photoDataUrls: ["https://x/r1.jpg"] }],
} as unknown as Parameters<typeof buildAirbnbListingPackFromSubmission>[0];

describe("buildAirbnbListingPackFromSubmission", () => {
  const pack = buildAirbnbListingPackFromSubmission(sub, "r1");
  it("caps the title at 32 chars", () => {
    expect(pack.title.length).toBeLessThanOrEqual(32);
    expect(pack.title.startsWith("Private room · University")).toBe(true);
  });
  it("prices nightly from monthly rent", () => {
    expect(pack.pricing).toContain("Nightly $36");
    expect(pack.pricing).toContain("28-night discount to match $900/month");
  });
  it("lists room photos before house photos", () => {
    expect(pack.photoUrls).toEqual(["https://x/r1.jpg", "https://x/h1.jpg"]);
    expect(pack.text).toContain("1. https://x/r1.jpg");
  });
  it("splits amenities and adds pets", () => {
    expect(pack.amenities).toEqual(["Desk", "Wi-Fi", "Closet", "Pets allowed"]);
    expect(pack.text).toContain("Title: ");
  });
  it("survives a missing listing", () => {
    expect(buildAirbnbListingPackFromSubmission(undefined, "x").title).toBe("Private room");
  });
});
