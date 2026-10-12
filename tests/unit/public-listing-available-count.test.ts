import { describe, expect, it } from "vitest";
import { deriveListingKeyFacts } from "@/components/marketing/listing-key-facts";
import type { ListingRichContent, ListingRoomRow } from "@/data/listing-rich-content";
import { countRoomsAvailableNow, findPublicRoomOccupancy } from "@/lib/public-listing-available-count";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

const TODAY = "2026-10-11";
const PROP = "prop-1";

function room(id: string, availability = "Available now", occupancyCapacity?: number): ListingRoomRow {
  return {
    id,
    name: id,
    detail: "",
    price: "$1,000/month",
    availability,
    occupancyCapacity,
    modal: { setupLine: "", tourEyebrow: "", tourTitle: "", tourSubtitle: "", includedTags: [] },
  };
}

function occ(roomId: string, spans: PublicRoomOccupancy["spans"]): PublicRoomOccupancy {
  return { roomChoice: `${PROP}::${roomId}`, spans };
}

describe("countRoomsAvailableNow", () => {
  it("does not count a room that is full today", () => {
    const rows = [occ("a", [{ start: "2026-01-01", end: "2026-12-31", count: 1 }])];
    expect(countRoomsAvailableNow([room("a")], rows, TODAY, PROP)).toBe(0);
  });

  it("counts a room whose span ended yesterday", () => {
    const rows = [occ("a", [{ start: "2026-01-01", end: "2026-10-10", count: 1 }])];
    expect(countRoomsAvailableNow([room("a")], rows, TODAY, PROP)).toBe(1);
  });

  it("counts a 2-bed room with one occupant", () => {
    const rows = [occ("a", [{ start: "2026-01-01", end: "2026-12-31", count: 1 }])];
    expect(countRoomsAvailableNow([room("a", "Available now", 2)], rows, TODAY, PROP)).toBe(1);
  });

  it("does not count a 2-bed room with two occupants", () => {
    const rows = [occ("a", [{ start: "2026-01-01", end: "2026-12-31", count: 2 }])];
    expect(countRoomsAvailableNow([room("a", "Available now", 2)], rows, TODAY, PROP)).toBe(0);
  });

  it("does not count a dated-later room even when it is empty", () => {
    expect(countRoomsAvailableNow([room("a", "Available Nov 1, 2099")], [], TODAY, PROP)).toBe(0);
  });

  it("does not count a room with an open-ended span", () => {
    const rows = [occ("a", [{ start: "2026-01-01", end: null, count: 1 }])];
    expect(countRoomsAvailableNow([room("a")], rows, TODAY, PROP)).toBe(0);
  });

  it("falls back to the static count with no occupancy rows", () => {
    expect(countRoomsAvailableNow([room("a"), room("b"), room("c", "Available after Oct 1, 2099")], [], TODAY, PROP)).toBe(2);
  });

  it("matches rows by exact choice, then by '::roomId' suffix", () => {
    const rows = [{ roomChoice: "other::a", spans: [{ start: "2026-01-01", end: null, count: 1 }] }];
    expect(findPublicRoomOccupancy(rows, PROP, "a")).toBe(rows[0]);
    expect(findPublicRoomOccupancy(rows, PROP, "b")).toBeUndefined();
  });
});

describe("tile and bar share one number", () => {
  it("the key-facts tile reads the same count the bar line is built from", () => {
    const rooms = [room("a"), room("b"), room("c")];
    const rows = [occ("a", [{ start: "2026-01-01", end: null, count: 1 }])];
    const n = countRoomsAvailableNow(rooms, rows, TODAY, PROP);
    const rich = {
      priceRangeLabel: "$1,000/mo",
      startingRentLabel: "$1,000/mo",
      floorPlans: [{ floorLabel: "F", fromPrice: "", roomCount: 3, rooms }],
      bathrooms: [],
    } as unknown as ListingRichContent;
    const property = { beds: 3, baths: 1, petFriendly: false };
    expect(n).toBe(2);
    expect(deriveListingKeyFacts(rich, property, n).find((f) => f.id === "rooms")?.label).toBe(`${n} available now`);
    // Loading: no sublabel at all, never a stale static number.
    expect(deriveListingKeyFacts(rich, property, null).find((f) => f.id === "rooms")?.label).toBeUndefined();
    // No override: existing static behavior.
    expect(deriveListingKeyFacts(rich, property).find((f) => f.id === "rooms")?.label).toBe("3 available now");
  });
});
