/**
 * @vitest-environment jsdom
 *
 * The Apply room picker offers only rooms the PUBLIC LISTING verified as available. When the anonymous occupancy
 * read is refused (rate limit, 5xx) or its 60s snapshot lapses, nothing has been verified, so the picker offers no
 * room and says why - it never degrades to "every room is open", which would offer a room the listing page itself
 * labels "Leased until ...".
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { clearPublicRoomOccupancy, replacePublicRoomOccupancyForProperty } from "@/lib/public-room-occupancy-client";
import { pacificTodayKey } from "@/lib/room-availability-range";
import { publicRoomPickFromRows } from "@/lib/public-room-pick-availability";
import {
  APPLY_ROOM_AVAILABILITY_UNKNOWN,
  getRoomOptionsForProperty,
  listingRoomAvailabilityLabel,
  listingRoomAvailabilityUnknown,
  listingRoomMayPreselect,
  roomChoiceValue,
} from "@/lib/rental-application/data";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

const HOUSE = "mgr-apply-read-failure";
const DATES = { leaseStart: "2030-03-01", leaseEnd: "2031-02-28" };

/** The snapshot the route returns for this house: a row for EVERY room, "Room A" taken from before today. */
const LOADED: PublicRoomOccupancy[] = [
  { roomChoice: `${HOUSE}::a`, spans: [{ start: "2026-01-01", end: "2031-12-31", count: 1 }] },
  { roomChoice: `${HOUSE}::b`, spans: [] },
];

function seedHouse(): void {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    { ...sub.rooms[0]!, id: "a", name: "Room A", monthlyRent: 1000, availability: "Available now" },
    { ...sub.rooms[0]!, id: "b", name: "Room B", monthlyRent: 1000, availability: "Available now" },
  ];
  const property: MockProperty = {
    id: HOUSE,
    title: "Read Failure House",
    tagline: "Test",
    address: "2 Test St, Spokane, WA",
    zip: "99201",
    neighborhood: "Test",
    beds: 2,
    baths: 1,
    rentLabel: "$1,000/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Read Failure House",
    unitLabel: "2 rooms",
    adminPublishLive: true,
    managerUserId: "mgr-apply",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

beforeEach(() => {
  // Not "/" — that path is the public demo surface, where the loaded occupancy is deliberately ignored.
  window.history.replaceState(null, "", "/rent/apply");
  seedHouse();
  clearPublicRoomOccupancy();
});

const offered = () => getRoomOptionsForProperty(HOUSE, { ...DATES, listingOnly: true }).map((o) => o.label.split(" · ")[0]);

describe("the Apply room picker when the public occupancy read has not landed", () => {
  it("offers no room, claims no availability, and has a note to show instead", () => {
    expect(listingRoomAvailabilityUnknown(HOUSE)).toBe(true);
    expect(offered()).toEqual([]);
    expect(listingRoomAvailabilityLabel(roomChoiceValue(HOUSE, "b"))).toBeNull();
    expect(APPLY_ROOM_AVAILABILITY_UNKNOWN).toContain("Couldn't check room availability");
  });

  it("offers exactly the rooms the loaded snapshot verifies once the read lands", () => {
    replacePublicRoomOccupancyForProperty(HOUSE, LOADED);
    expect(listingRoomAvailabilityUnknown(HOUSE)).toBe(false);
    // Oracle: the listing page's own decision over the same spans (`publicRoomPickFromRows`), which calls the
    // open-ended span on Room A "Leased until ..." and Room B open.
    const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
    const pick = (id: string, availability: string) =>
      publicRoomPickFromRows({ ...sub.rooms[0]!, id, availability }, LOADED, HOUSE, pacificTodayKey());
    expect(pick("a", "Available now").applicable).toBe(false);
    expect(pick("b", "Available now").applicable).toBe(true);
    expect(offered()).toEqual(["Room B"]);
    expect(listingRoomAvailabilityLabel(roomChoiceValue(HOUSE, "b"))).toBe("Open now");
    // A link may preselect the room the listing verified as open, never the one it verified as taken.
    expect(listingRoomMayPreselect(roomChoiceValue(HOUSE, "b"))).toBe(true);
    expect(listingRoomMayPreselect(roomChoiceValue(HOUSE, "a"))).toBe(false);
  });
});
