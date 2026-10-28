import { describe, expect, it } from "vitest";
import {
  formatNextOpening,
  formatOpeningDate,
  formatRoomAvailability,
  roomAvailability,
} from "@/lib/room-availability";
import {
  countRoomsAvailableNow,
  nextOpeningDate,
  roomAvailabilityDisplay,
} from "@/lib/public-listing-available-count";
import { buildPropertyBrowseCards, sortPropertyBrowseCards, type PropertyBrowseCard } from "@/lib/room-listings-catalog";

const TODAY = "2026-10-13";
const room = (extra: Record<string, unknown> = {}) => ({ availability: "Available now", ...extra });

describe("roomAvailability", () => {
  it("is available now with no spans", () => {
    expect(roomAvailability(room(), [], TODAY)).toEqual({ kind: "now" });
  });

  it("a block ending today frees the room tomorrow", () => {
    expect(roomAvailability(room(), [{ start: "2026-09-01", end: TODAY, count: 1 }], TODAY)).toEqual({
      kind: "from",
      date: "2026-10-14",
    });
  });

  it("a block starting tomorrow leaves the room open today", () => {
    expect(roomAvailability(room(), [{ start: "2026-10-14", end: "2026-12-01", count: 1 }], TODAY)).toEqual({ kind: "now" });
  });

  it("skips back-to-back blocks to the first genuinely free day", () => {
    const spans = [
      { start: "2026-09-01", end: "2026-10-15", count: 1 },
      { start: "2026-10-16", end: "2026-10-25", count: 1 },
    ];
    expect(roomAvailability(room(), spans, TODAY)).toEqual({ kind: "from", date: "2026-10-26" });
  });

  it("an open-ended block never invents a date", () => {
    expect(roomAvailability(room(), [{ start: "2026-01-01", end: null, count: 1 }], TODAY)).toEqual({ kind: "unavailable" });
  });

  it("a shared room is open while beds taken are below capacity", () => {
    const spans = [{ start: "2026-01-01", end: "2026-11-30", count: 1 }];
    expect(roomAvailability(room({ occupancyCapacity: 2 }), spans, TODAY)).toEqual({ kind: "now" });
    expect(roomAvailability(room({ occupancyCapacity: 2 }), [{ ...spans[0]!, count: 2 }], TODAY)).toEqual({
      kind: "from",
      date: "2026-12-01",
    });
  });

  it("honours a dated static opening as a floor and manager closures", () => {
    expect(roomAvailability(room({ availability: "Available from Nov 20, 2099" }), [], TODAY)).toEqual({ kind: "from", date: "2099-11-20" });
    expect(roomAvailability(room({ availability: "Leased" }), [], TODAY)).toEqual({ kind: "unavailable" });
    expect(roomAvailability(room({ availability: "Waitlist" }), [], TODAY)).toEqual({ kind: "unavailable" });
  });

  it("replaces the fold's own Unavailable-until label with the spans it came from", () => {
    const spans = [{ start: "2026-09-01", end: "2026-10-14", count: 1 }];
    expect(roomAvailability(room({ availability: "Unavailable until October 14, 2026" }), spans, TODAY)).toEqual({
      kind: "from",
      date: "2026-10-15",
    });
  });
});

describe("formatting", () => {
  it("short month and day, year only when not this year, month and year past six months", () => {
    expect(formatOpeningDate("2026-10-15", TODAY)).toBe("Oct 15");
    expect(formatOpeningDate("2027-01-04", TODAY)).toBe("Jan 4, 2027");
    expect(formatOpeningDate("2027-09-12", TODAY)).toBe("Sep 2027");
    expect(formatRoomAvailability({ kind: "now" }, TODAY)).toBe("Available now");
    expect(formatRoomAvailability({ kind: "from", date: "2026-10-15" }, TODAY)).toBe("Available from Oct 15");
    expect(formatRoomAvailability({ kind: "from", date: "2027-09-12" }, TODAY)).toBe("Available Sep 2027");
    expect(formatRoomAvailability({ kind: "unavailable" }, TODAY)).toBe("Not available");
    expect(formatNextOpening("2026-10-15", TODAY)).toBe("Next opening Oct 15");
  });
});

describe("listing surfaces share the predicate", () => {
  const rooms = [1, 2, 3].map((n) => ({ id: `r${n}`, availability: "Available now", occupancyCapacity: undefined }));
  const rows = [
    { roomChoice: "p::r1", spans: [{ start: "2026-01-01", end: "2026-10-14", count: 1 }] },
    { roomChoice: "p::r2", spans: [{ start: "2026-01-01", end: "2026-10-25", count: 1 }] },
    { roomChoice: "p::r3", spans: [{ start: "2026-01-01", end: null, count: 1 }] },
  ];

  it("header count is 0 and the next opening is the earliest free day", () => {
    expect(countRoomsAvailableNow(rooms, rows, TODAY, "p")).toBe(0);
    expect(nextOpeningDate(rooms, rows, TODAY, "p")).toBe("2026-10-15");
  });

  it("loading shows nothing, a failed request keeps the static label", () => {
    expect(roomAvailabilityDisplay(rooms[0]!, { rows: [], loading: true, failed: false }, TODAY, "p")).toBeNull();
    expect(roomAvailabilityDisplay(rooms[0]!, { rows: [], loading: false, failed: true }, TODAY, "p")).toEqual({
      text: "Available now",
      tone: "available",
    });
    expect(roomAvailabilityDisplay(rooms[0]!, { rows, loading: false, failed: false }, TODAY, "p")).toEqual({
      text: "Available Oct 15",
      tone: "future",
    });
    expect(roomAvailabilityDisplay(rooms[2]!, { rows, loading: false, failed: false }, TODAY, "p")).toEqual({
      text: "Not available",
      tone: "unavailable",
    });
  });
});

describe("browse next-opening sort", () => {
  const card = (id: string, kind: PropertyBrowseCard["availabilityKind"], nextOpening: string | null) =>
    ({ propertyId: id, neighborhood: "", headlineAddress: id, rentNumeric: 1000, availabilityKind: kind, nextOpening }) as PropertyBrowseCard;

  it("puts open-now homes first, then the soonest opening, undated last", () => {
    const sorted = sortPropertyBrowseCards(
      [card("none", "unavailable", null), card("late", "later", "2026-12-01"), card("now", "now", null), card("soon", "later", "2026-10-15")],
      "next-opening",
    );
    expect(sorted.map((c) => c.propertyId)).toEqual(["now", "soon", "late", "none"]);
    expect(buildPropertyBrowseCards([], { sort: "next-opening" })).toEqual([]);
  });
});

describe("browse card next opening", () => {
  it("a home with only a dated later room carries its first opening date", async () => {
    const { aggregateRoomRowsToPropertyCards } = await import("@/lib/room-listings-catalog");
    const base = {
      propertyId: "p", roomName: "R", floorLabel: "", title: "", streetUpper: "", neighborhood: "", priceLabel: "$1,000/month",
      rentNumeric: 1000, headlineRent: 1000, pricePeriod: "month", availabilityLabel: "", bathroomHint: "", zip: "", headlineAddress: "A",
      fullAddress: "A", propertyBeds: 1, propertyBaths: 1, petFriendly: false, descriptionBlurb: "", listingTags: [], priceOverlayLabel: "",
      mediaSlides: [], leaseTypes: [],
    } as const;
    const [card] = aggregateRoomRowsToPropertyCards([
      { ...base, key: "p:a", roomId: "a", availabilityRaw: "Available from Nov 20, 2099" },
      { ...base, key: "p:b", roomId: "b", availabilityRaw: "Available from Oct 4, 2099" },
    ] as never);
    expect(card!.availabilityKind).toBe("later");
    expect(card!.nextOpening).toBe("2099-10-04");
    const [open] = aggregateRoomRowsToPropertyCards([
      { ...base, key: "p:c", roomId: "c", availabilityRaw: "Available now" },
      { ...base, key: "p:d", roomId: "d", availabilityRaw: "Available from Oct 4, 2099" },
    ] as never);
    expect(open!.nextOpening).toBeNull();
  });
});
