// @vitest-environment jsdom
/**
 * Application Step 1 offers the same rooms as the public listing: a room the
 * manager left unnamed is "Room n", and a room is not dropped just because the
 * applicant has not picked dates yet.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { firstChoiceRoomOptions, getRoomOptionsForProperty } from "@/lib/rental-application/data";
import { seedDemoManagerProperties } from "@/lib/demo-property-pipeline";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

const ID = "demo-prop-ten-rooms";
const UNNAMED = new Set([3, 4, 8, 9, 10]);

function tenRoomProperty(): MockProperty {
  const rooms = Array.from({ length: 10 }, (_, i) => ({
    ...emptyRoom(i),
    id: `r${i + 1}`,
    name: UNNAMED.has(i + 1) ? "" : `Bedroom ${i + 1}`,
    monthlyRent: 900,
    availability: "2099-01-01",
  }));
  return {
    id: ID, title: "Ten Rooms", tagline: "", address: "1 Main St", zip: "98107", neighborhood: "",
    beds: 10, baths: 3, rentLabel: "$900/mo", available: "Now", petFriendly: false,
    buildingId: ID, buildingName: "Ten Rooms", unitLabel: "",
    listingSubmission: { ...createDefaultListingSubmission(), listingPlaceCategoryId: "private_room", rooms },
  } as MockProperty;
}

beforeEach(() => {
  window.localStorage.clear();
  seedDemoManagerProperties("z-manager", [tenRoomProperty()]);
});

describe("applicant room picker", () => {
  it("includeUnnamed lists all ten rooms, unnamed ones as 'Room n'", () => {
    const options = getRoomOptionsForProperty(ID, { includeUnnamed: true, includeUnavailable: true });
    expect(options).toHaveLength(10);
    for (const n of UNNAMED) {
      expect(options.find((o) => o.value.endsWith(`::r${n}`))?.label.startsWith(`Room ${n}`)).toBe(true);
    }
  });

  it("without includeUnnamed the unnamed rooms are dropped (the old bug)", () => {
    expect(getRoomOptionsForProperty(ID, { includeUnavailable: true })).toHaveLength(5);
  });

  it("first-choice picker lists all ten with no dates picked", () => {
    const options = firstChoiceRoomOptions(ID, { includeUnnamed: true, includeUnavailable: true });
    const rooms = new Set(options.map((o) => o.value.split("::")[1]));
    expect(rooms.size).toBe(10);
  });
});
