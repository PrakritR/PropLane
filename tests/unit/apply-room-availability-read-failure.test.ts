/**
 * @vitest-environment jsdom
 *
 * The Apply room picker always stands. With a landed public occupancy read it offers exactly the rooms that read
 * verifies; with none (refused, never loaded, or the 60s snapshot lapsed) it falls back to the listing's OWN
 * availability, so a room the manager marked "Not available" is still never offered, and the live check at
 * Continue is what judges the applicant's dates. A local application write must not cost the picker its read.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { clearPublicRoomOccupancy, replacePublicRoomOccupancyForProperty } from "@/lib/public-room-occupancy-client";
import { replaceManagerApplicationRowInCache } from "@/lib/manager-applications-storage";
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
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { MockProperty } from "@/data/types";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";

const HOUSE = "mgr-apply-read-failure";
const DATES = { leaseStart: "2030-03-01", leaseEnd: "2031-02-28" };

/** The snapshot the route returns for this house: a row for EVERY room, "Room A" taken from before today. */
const LOADED: PublicRoomOccupancy[] = [
  { roomChoice: `${HOUSE}::a`, spans: [{ start: "2026-01-01", end: "2031-12-31", count: 1 }] },
  { roomChoice: `${HOUSE}::b`, spans: [] },
  { roomChoice: `${HOUSE}::c`, spans: [] },
];

function seedHouse(): void {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    { ...sub.rooms[0]!, id: "a", name: "Room A", monthlyRent: 1000, availability: "Available now" },
    { ...sub.rooms[0]!, id: "b", name: "Room B", monthlyRent: 1000, availability: "Available now" },
    { ...sub.rooms[0]!, id: "c", name: "Room C", monthlyRent: 1000, availability: "Not available" },
  ];
  const property: MockProperty = {
    id: HOUSE,
    title: "Read Failure House",
    tagline: "Test",
    address: "2 Test St, Spokane, WA",
    zip: "99201",
    neighborhood: "Test",
    beds: 3,
    baths: 1,
    rentLabel: "$1,000/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Read Failure House",
    unitLabel: "3 rooms",
    adminPublishLive: true,
    managerUserId: "mgr-apply",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
}

beforeEach(() => {
  // Not "/" — that path is the public demo surface, where the loaded occupancy is deliberately ignored.
  window.history.replaceState(null, "", "/rent/apply");
  window.sessionStorage.clear();
  seedHouse();
  clearPublicRoomOccupancy();
});

const offered = () => getRoomOptionsForProperty(HOUSE, { ...DATES, listingOnly: true }).map((o) => o.label.split(" · ")[0]);

describe("the Apply room picker and the public occupancy read", () => {
  it("keeps offering the listing's own available rooms when no read has landed", () => {
    expect(listingRoomAvailabilityUnknown(HOUSE)).toBe(true);
    // Oracle: the listing's own availability wording for each room ("Not available" on Room C), which
    // `publicRoomPickFromRows` reads with no spans. Plausible wrong behaviour: offering Room C, or offering none.
    const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
    const staticPick = (id: string, availability: string) =>
      publicRoomPickFromRows({ ...sub.rooms[0]!, id, availability }, [], HOUSE, pacificTodayKey());
    expect(staticPick("c", "Not available").applicable).toBe(false);
    expect(staticPick("b", "Available now").applicable).toBe(true);
    expect(offered()).toEqual(["Room A", "Room B"]);
    expect(listingRoomAvailabilityLabel(roomChoiceValue(HOUSE, "b"))).toBe("Open now");
    expect(APPLY_ROOM_AVAILABILITY_UNKNOWN).toContain("the listing's own dates");
  });

  it("offers exactly the rooms the loaded snapshot verifies once the read lands", () => {
    replacePublicRoomOccupancyForProperty(HOUSE, LOADED);
    expect(listingRoomAvailabilityUnknown(HOUSE)).toBe(false);
    // Oracle: the listing page's own decision over the same spans, which calls the open-ended span on Room A
    // "Leased until ..." and Room B open.
    const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
    const pick = (id: string, availability: string) =>
      publicRoomPickFromRows({ ...sub.rooms[0]!, id, availability }, LOADED, HOUSE, pacificTodayKey());
    expect(pick("a", "Available now").applicable).toBe(false);
    expect(pick("b", "Available now").applicable).toBe(true);
    expect(offered()).toEqual(["Room B"]);
    // A link may preselect the room the listing verified as open, never the one it verified as taken.
    expect(listingRoomMayPreselect(roomChoiceValue(HOUSE, "b"))).toBe(true);
    expect(listingRoomMayPreselect(roomChoiceValue(HOUSE, "a"))).toBe(false);
  });

  it("keeps the landed read through a local application write (the wizard's draft autosave)", () => {
    replacePublicRoomOccupancyForProperty(HOUSE, LOADED);
    // What the debounced draft save does on every keystroke of step 1.
    replaceManagerApplicationRowInCache({ id: "AXIS-DRAFT-1", bucket: "pending" } as DemoApplicantRow);
    expect(listingRoomAvailabilityUnknown(HOUSE)).toBe(false);
    expect(offered()).toEqual(["Room B"]);
  });
});
