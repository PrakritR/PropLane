/**
 * @vitest-environment jsdom
 *
 * The "Continue" refusal on step 1 names the other rooms that ARE free for the applicant's term. The advice has to be
 * followable: a room the manager closed is not in the picker (`listingRoomPick(...).applicable === false`, the same
 * filter `rental-wizard-steps.tsx` renders with), so it can never be suggested either.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { cachePublicExtraListings } from "@/lib/demo-property-pipeline";
import { replacePublicRoomOccupancyForProperty } from "@/lib/public-room-occupancy-client";
import { explainRoomChoiceConflict, getRoomOptionsForProperty, roomChoiceValue } from "@/lib/rental-application/data";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

const HOUSE = "mgr-conflict-house";

function seedHouse(): void {
  const sub = createDefaultListingSubmission();
  sub.rooms = [
    { ...sub.rooms[0]!, id: "a", name: "Room A", monthlyRent: 1000, availability: "Available now" },
    { ...sub.rooms[0]!, id: "b", name: "Room B", monthlyRent: 1000, availability: "Not available" },
    { ...sub.rooms[0]!, id: "c", name: "Room C", monthlyRent: 1000, availability: "Available now" },
  ];
  const property: MockProperty = {
    id: HOUSE,
    title: "Conflict House",
    tagline: "Test",
    address: "1 Test St, Seattle, WA",
    zip: "98101",
    neighborhood: "Test",
    beds: 3,
    baths: 1,
    rentLabel: "$1,000/mo",
    available: "Now",
    petFriendly: false,
    buildingId: "b1",
    buildingName: "Conflict House",
    unitLabel: "3 rooms",
    adminPublishLive: true,
    managerUserId: "mgr-conflict",
    listingSubmission: normalizeManagerListingSubmissionV1(sub),
  };
  cachePublicExtraListings([property], { silent: true });
  // Room A is taken for the whole requested term; B and C carry no occupancy at all.
  replacePublicRoomOccupancyForProperty(HOUSE, [
    { roomChoice: `${HOUSE}::a`, spans: [{ start: "2030-01-01", end: "2031-12-31", count: 1 }] },
    { roomChoice: `${HOUSE}::b`, spans: [] },
    { roomChoice: `${HOUSE}::c`, spans: [] },
  ]);
}

const DATES = { leaseStart: "2030-03-01", leaseEnd: "2031-02-28" };

beforeEach(() => {
  // Not "/" — that path is the public demo surface, where the loaded occupancy is deliberately ignored.
  window.history.replaceState(null, "", "/rent/apply");
  seedHouse();
});

describe("the room-conflict message's alternatives", () => {
  it("offers only rooms the picker offers: the closed room is left out", () => {
    const offered = getRoomOptionsForProperty(HOUSE, { ...DATES, listingOnly: true }).map((o) => o.label.split(" · ")[0]);
    expect(offered).toEqual(["Room C"]);

    const message = explainRoomChoiceConflict(roomChoiceValue(HOUSE, "a"), { propertyId: HOUSE, ...DATES });
    expect(message).toContain("Room A is booked");
    expect(message).toContain("Free for your whole term: Room C.");
    expect(message).not.toContain("Room B");
  });
});
