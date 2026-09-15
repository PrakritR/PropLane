import { describe, expect, it } from "vitest";
import {
  deriveListingKeyFacts,
  earliestAvailability,
  listingRentTileValue,
} from "@/components/marketing/listing-key-facts";
import type { ListingRichContent, ListingRoomRow } from "@/data/listing-rich-content";

function room(id: string, availability: string): ListingRoomRow {
  return {
    id,
    name: id,
    detail: "",
    price: "$1,000/month",
    availability,
    modal: { setupLine: "", tourEyebrow: "", tourTitle: "", tourSubtitle: "", includedTags: [] },
  };
}

function bathroom(id: string, usedBy: string[]) {
  return {
    id,
    name: id,
    detail: "",
    usedByLabel: usedBy.join(", "),
    shower: true,
    toilet: true,
    bathtub: false,
    availability: "—",
    modal: { eyebrow: "", setupCard: "", usedByRoomNames: usedBy, includedTags: [], photoCaptions: [] },
  };
}

function rich(overrides: Partial<ListingRichContent> = {}): ListingRichContent {
  return {
    heroTagline: "",
    priceRangeLabel: "base rent $1,000–$1,300/mo",
    startingRentLabel: "$1,000/mo",
    floorPlans: [
      { floorLabel: "First floor", fromPrice: "", roomCount: 2, rooms: [room("Room 1", "Available now"), room("Room 2", "Available now")] },
      { floorLabel: "Second floor", fromPrice: "", roomCount: 2, rooms: [room("Room 3", "Available after Oct 1, 2099"), room("Primary", "Not available")] },
    ],
    bathrooms: [bathroom("Hall bath", ["Room 1", "Room 2", "Room 3"]), bathroom("Primary bath", ["Primary"])],
    sharedSpaces: [],
    leaseBasics: [],
    amenities: [],
    bundlesText: "",
    bundleCards: [],
    quickFacts: [],
    ...overrides,
  };
}

const property = { beds: 4, baths: 2, petFriendly: true };

describe("listingRentTileValue", () => {
  it("strips the chip prefix and the period from a range", () => {
    expect(listingRentTileValue({ priceRangeLabel: "base rent $1,000–$1,300/mo", startingRentLabel: "$1,000/mo" })).toBe(
      "$1,000 – $1,300",
    );
  });
  it("falls back to the starting rent when there is no range", () => {
    expect(listingRentTileValue({ priceRangeLabel: "—", startingRentLabel: "$775/mo" })).toBe("$775");
  });
  it("adds thousands separators to amounts the label builder left bare", () => {
    expect(listingRentTileValue({ priceRangeLabel: "base rent $1050–$1300/mo", startingRentLabel: "$1050/mo" })).toBe(
      "$1,050 – $1,300",
    );
  });
  it("is null when neither label carries a number", () => {
    expect(listingRentTileValue({ priceRangeLabel: "—", startingRentLabel: "—" })).toBeNull();
  });
});

describe("earliestAvailability", () => {
  it("prefers a room open now over a future date", () => {
    expect(earliestAvailability(["Available after Oct 1, 2099", "Available now"])).toBe("Available now");
  });
  it("uses the first future opening when nothing is open now", () => {
    expect(earliestAvailability(["Not available", "Available after Oct 1, 2099"])).toBe("Available after Oct 1, 2099");
  });
  it("is null when every room is unavailable or blank", () => {
    expect(earliestAvailability(["Not available", "—", ""])).toBeNull();
  });
});

describe("deriveListingKeyFacts", () => {
  it("derives the five tiles from rooms, bathrooms and the listing", () => {
    const facts = deriveListingKeyFacts(rich(), property);
    expect(facts.map((f) => f.id)).toEqual(["rent", "rooms", "baths", "availability", "pets"]);
    expect(facts.find((f) => f.id === "rent")).toEqual({ id: "rent", value: "$1,000 – $1,300", label: "base rent / mo" });
    expect(facts.find((f) => f.id === "rooms")).toEqual({ id: "rooms", value: "4 rooms", label: "2 available now" });
    expect(facts.find((f) => f.id === "baths")).toEqual({ id: "baths", value: "2 baths", label: "1 private" });
    expect(facts.find((f) => f.id === "availability")).toEqual({ id: "availability", value: "Available now" });
  });

  it("never counts a future-dated room as available now", () => {
    const facts = deriveListingKeyFacts(
      rich({ floorPlans: [{ floorLabel: "First", fromPrice: "", roomCount: 1, rooms: [room("Room 1", "Available after Oct 1, 2099")] }] }),
      property,
    );
    expect(facts.find((f) => f.id === "rooms")?.label).toBe("0 available now");
    expect(facts.find((f) => f.id === "availability")?.value).toBe("Available after Oct 1, 2099");
  });

  it("hides pets when the listing does not allow them and baths when unknown", () => {
    const facts = deriveListingKeyFacts(rich({ bathrooms: [] }), { beds: 0, baths: 0, petFriendly: false });
    expect(facts.map((f) => f.id)).toEqual(["rent", "rooms", "availability"]);
  });

  it("falls back to the property counts when the submission lists no rooms", () => {
    const facts = deriveListingKeyFacts(rich({ floorPlans: [], bathrooms: [] }), { beds: 3, baths: 1.5, petFriendly: false });
    expect(facts.find((f) => f.id === "rooms")).toEqual({ id: "rooms", value: "3 rooms", label: undefined });
    expect(facts.find((f) => f.id === "baths")).toEqual({ id: "baths", value: "1.5 baths", label: undefined });
    expect(facts.find((f) => f.id === "availability")).toBeUndefined();
  });

  it("does not count the builder's fallback bathroom row", () => {
    const facts = deriveListingKeyFacts(rich({ bathrooms: [bathroom("b-fallback", [])] }), { beds: 4, baths: 0, petFriendly: false });
    expect(facts.find((f) => f.id === "baths")).toBeUndefined();
  });

  it("adds the photo tile only for the manager variant", () => {
    expect(deriveListingKeyFacts(rich(), property).some((f) => f.id === "photos")).toBe(false);
    const withPhotos = deriveListingKeyFacts(rich(), property, { photoCount: 0 });
    expect(withPhotos.find((f) => f.id === "photos")).toEqual({ id: "photos", value: "0 photos", label: "add to publish" });
  });
});
