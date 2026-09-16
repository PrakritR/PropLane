// The redesigned browse card leads with facts a renter scans for — rooms, baths,
// availability, pets, a rent range and the photo dots — every one derived from
// the listing rows the catalog already builds (PLAN-0914-2124). These pin the
// derivations so "2 available now" can never come from a loose text match and a
// home with no photo never inherits a stock URL outside the demo sandbox.
import { describe, expect, it } from "vitest";
import type { MockProperty } from "@/data/types";
import {
  aggregateRoomRowsToPropertyCards,
  buildPropertyBrowseCards,
  classifyRoomAvailability,
  shortBathHint,
  type RoomListingRow,
} from "@/lib/room-listings-catalog";

function row(overrides: Partial<RoomListingRow> & Pick<RoomListingRow, "roomId">): RoomListingRow {
  return {
    key: `p1:${overrides.roomId}`,
    propertyId: "p1",
    roomName: `Room ${overrides.roomId}`,
    floorLabel: "First floor",
    title: "Room",
    streetUpper: "510 CATANIO COURT",
    neighborhood: "Twin Creeks",
    priceLabel: "$1,000/month",
    rentNumeric: 1000,
    headlineRent: 1000,
    pricePeriod: "month",
    availabilityLabel: "1 available",
    bathroomHint: "Shared bath",
    zip: "94582",
    headlineAddress: "510 Catanio Court",
    fullAddress: "510 Catanio Court, San Ramon, CA 94582",
    propertyBeds: 4,
    propertyBaths: 2,
    petFriendly: true,
    descriptionBlurb: "",
    listingTags: [],
    priceOverlayLabel: "$1,000",
    availabilityRaw: "Available now",
    mediaSlides: [],
    ...overrides,
  };
}

describe("classifyRoomAvailability", () => {
  it("reads now / later / unavailable from the manager's own wording", () => {
    expect(classifyRoomAvailability("Available now")).toBe("now");
    expect(classifyRoomAvailability("")).toBe("now");
    expect(classifyRoomAvailability("2 of 4 beds available")).toBe("now");
    expect(classifyRoomAvailability("Available Oct 1")).toBe("later");
    expect(classifyRoomAvailability("Available after 11/15")).toBe("later");
    expect(classifyRoomAvailability("Waitlist")).toBe("later");
    expect(classifyRoomAvailability("Fully booked")).toBe("unavailable");
    expect(classifyRoomAvailability("Not available")).toBe("unavailable");
  });
});

describe("shortBathHint", () => {
  it("collapses the room's bathroom line to the two words a card can carry", () => {
    expect(shortBathHint("Private bath")).toBe("Private bath");
    expect(shortBathHint("En-suite · own shower")).toBe("Private bath");
    expect(shortBathHint("3-person shared bath")).toBe("Shared bath");
    expect(shortBathHint("Hall bath")).toBe("Shared bath");
    expect(shortBathHint("Bath setup on listing")).toBe("");
    expect(shortBathHint("")).toBe("");
  });
});

describe("aggregateRoomRowsToPropertyCards", () => {
  it("derives baths, availability, the rent range and the photo list from the rows", () => {
    const cards = aggregateRoomRowsToPropertyCards([
      row({
        roomId: "a",
        headlineRent: 1000,
        rentNumeric: 1000,
        availabilityRaw: "Available now",
        mediaSlides: [
          { roomName: "Room a", kind: "photo", src: "https://x/a1.jpg" },
          { roomName: "Room a", kind: "video", src: "https://x/a.mp4" },
        ],
      }),
      row({
        roomId: "b",
        headlineRent: 1100,
        rentNumeric: 1100,
        availabilityRaw: "Available Oct 1",
        bathroomHint: "Private bath",
        mediaSlides: [
          { roomName: "Room b", kind: "photo", src: "https://x/a1.jpg" },
          { roomName: "Room b", kind: "photo", src: "https://x/b1.jpg" },
        ],
      }),
      row({ roomId: "c", headlineRent: 1300, rentNumeric: 1300, availabilityRaw: "Available now" }),
    ]);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.roomCount).toBe(3);
    expect(card.bathCount).toBe(2);
    // The headline (cheapest) room is shared, so the card says so even though another room is private.
    expect(card.bathHint).toBe("Shared bath");
    expect(card.availabilityKind).toBe("now");
    expect(card.availabilityLabel).toBe("Available now");
    expect(card.availableNowCount).toBe(2);
    expect(card.headlineRent).toBe(1000);
    expect(card.rentMaxNumeric).toBe(1300);
    expect(card.photoUrls).toEqual(["https://x/a1.jpg", "https://x/b1.jpg"]);
    expect(card.imageUrl).toBe("https://x/a1.jpg");
  });

  it("uses the earliest later room's own wording when nothing is available now", () => {
    const [card] = aggregateRoomRowsToPropertyCards([
      row({ roomId: "a", availabilityRaw: "Available Nov 1" }),
      row({ roomId: "b", availabilityRaw: "Fully booked" }),
    ]);
    expect(card!.availabilityKind).toBe("later");
    expect(card!.availabilityLabel).toBe("Available Nov 1");
    expect(card!.availableNowCount).toBe(0);
  });

  it("leaves imageUrl empty and photoUrls empty for a home with no genuine photo", () => {
    const [card] = aggregateRoomRowsToPropertyCards([row({ roomId: "a" }), row({ roomId: "b" })]);
    expect(card!.imageUrl).toBe("");
    expect(card!.photoUrls).toEqual([]);
    expect(card!.rentMaxNumeric).toBe(card!.headlineRent);
  });

  it("ignores rooms priced by another period when computing the range", () => {
    const [card] = aggregateRoomRowsToPropertyCards([
      row({ roomId: "a", headlineRent: 900, rentNumeric: 900 }),
      row({ roomId: "d", headlineRent: 60, rentNumeric: 1800, pricePeriod: "day", priceLabel: "$60/day" }),
    ]);
    expect(card!.pricePeriod).toBe("month");
    expect(card!.rentMaxNumeric).toBe(900);
  });
});

function mockProperty(overrides: Partial<MockProperty> & Pick<MockProperty, "id">): MockProperty {
  return {
    title: "Test home",
    tagline: "Cozy room",
    address: "123 Main St, Seattle, WA",
    zip: "98101",
    neighborhood: "Capitol Hill",
    beds: 2,
    baths: 1,
    rentLabel: "$900/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Main House",
    unitLabel: "Unit A",
    adminPublishLive: true,
    ...overrides,
  };
}

describe("buildPropertyBrowseCards minBudgetNum", () => {
  it("drops homes whose every room rents below the floor and keeps them above it", () => {
    const properties = [mockProperty({ id: "home" })];
    const unfiltered = buildPropertyBrowseCards(properties);
    expect(unfiltered).toHaveLength(1);
    const cheapest = unfiltered[0]!.rentNumeric ?? 0;
    expect(cheapest).toBeGreaterThan(0);

    const aboveAll = buildPropertyBrowseCards(properties, { filters: { minBudgetNum: 100_000 } });
    expect(aboveAll).toHaveLength(0);

    const belowAll = buildPropertyBrowseCards(properties, { filters: { minBudgetNum: cheapest } });
    expect(belowAll).toHaveLength(1);

    const zeroIsNoFloor = buildPropertyBrowseCards(properties, { filters: { minBudgetNum: 0 } });
    expect(zeroIsNoFloor).toHaveLength(1);
  });
});
