// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { seedDemoManagerProperties } from "@/lib/demo-property-pipeline";
import { getPropertyById, getRoomOptionsForProperty } from "@/lib/rental-application/data";
import { propertyRooms } from "@/components/portal/bookings-portfolio-timeline";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";

/**
 * Properties counts `submission.rooms.length`; Bookings must read the same
 * saved record, even when a static copy of the id (no listingSubmission) sits
 * in another extras bucket and is found first.
 */
const ID = "demo-prop-maple";
const base: MockProperty = {
  id: ID, title: "Maple Duplex", tagline: "", address: "88 Maple Ave", zip: "98107", neighborhood: "",
  beds: 2, baths: 1, rentLabel: "$1,850/mo", available: "Now", petFriendly: false,
  buildingId: ID, buildingName: "Maple Duplex", unitLabel: "Unit A",
};

function saved(rooms: ReturnType<typeof emptyRoom>[], category = "private_room"): MockProperty {
  const submission = { ...createDefaultListingSubmission(), listingPlaceCategoryId: category, rooms };
  return { ...base, unitLabel: "", listingSubmission: submission } as MockProperty;
}
function fiveRooms() {
  return Array.from({ length: 5 }, (_, i) => ({ ...emptyRoom(i), id: `r${i + 1}`, name: `Bedroom ${i + 1}` }));
}

describe("Bookings rooms come from the saved record", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.pushState({}, "", "/portal/bookings/calendar");
  });

  it("5-room property: the saved record beats the static copy, 5 rows, 5 picker options", () => {
    // Static/seeded copy FIRST (no submission), saved record in a later bucket.
    seedDemoManagerProperties("a-seed", [base]);
    seedDemoManagerProperties("z-manager", [saved(fiveRooms())]);
    expect(getPropertyById(ID)?.listingSubmission?.rooms).toHaveLength(5);
    const rows = propertyRooms(ID, []);
    expect(rows.map((r) => r.id)).toEqual(["r1", "r2", "r3", "r4", "r5"]);
    expect(rows[0]!.label).toContain("Bedroom 1");
    expect(getRoomOptionsForProperty(ID, { includeUnavailable: true })).toHaveLength(5);
    expect(getRoomOptionsForProperty(ID)).toHaveLength(5);
    // Every room is named here, so the public applicant surfaces see all 5 too.
    expect(getRoomOptionsForProperty(ID, { includeUnnamed: true })).toHaveLength(5);
  });

  it("a blank room name reads Room n, in the rows and in the booking picker", () => {
    const rooms = fiveRooms();
    rooms[2] = { ...rooms[2]!, name: "   " };
    seedDemoManagerProperties("z-manager", [saved(rooms)]);
    expect(propertyRooms(ID, [])).toHaveLength(5);
    expect(propertyRooms(ID, [])[2]!.label).toBe("Room 3");
    const booking = getRoomOptionsForProperty(ID, { includeUnavailable: true, includeUnnamed: true });
    expect(booking).toHaveLength(5);
    expect(booking[2]!.label.startsWith("Room 3")).toBe(true);
  });

  // The placeholder name is manager-side Bookings only: a prospect or a
  // lead-share link is never offered a room the manager never named.
  it("without includeUnnamed an unnamed room is still left out", () => {
    const rooms = fiveRooms();
    rooms[2] = { ...rooms[2]!, name: "   " };
    seedDemoManagerProperties("z-manager", [saved(rooms)]);
    const prospect = getRoomOptionsForProperty(ID, { includeUnavailable: true });
    expect(prospect).toHaveLength(4);
    expect(prospect.some((option) => option.label.startsWith("Room 3"))).toBe(false);
  });

  it("a listing whose rooms are all unnamed keeps its old shape off Bookings", () => {
    const rooms = fiveRooms().map((room) => ({ ...room, name: "" }));
    seedDemoManagerProperties("z-manager", [saved(rooms)]);
    // No room options at all → the public surfaces fall through to the
    // whole-home/building branch, exactly as before this change.
    expect(getRoomOptionsForProperty(ID, { includeUnavailable: true }).some((o) => o.value.includes("::"))).toBe(false);
    expect(getRoomOptionsForProperty(ID, { includeUnavailable: true, includeUnnamed: true })).toHaveLength(5);
    expect(propertyRooms(ID, [])).toHaveLength(5);
  });

  it("an unavailable room still gets its row", () => {
    const rooms = fiveRooms();
    rooms[1] = { ...rooms[1]!, availability: "Not available" };
    seedDemoManagerProperties("z-manager", [saved(rooms)]);
    expect(propertyRooms(ID, [])).toHaveLength(5);
  });

  it("an entire-home listing stays one row", () => {
    seedDemoManagerProperties("z-manager", [saved(fiveRooms(), "entire_home")]);
    expect(propertyRooms(ID, [])).toHaveLength(1);
  });

  it("with no saved rooms and no bookings the house is one Whole home row", () => {
    expect(propertyRooms("unknown-house", [])).toEqual([{ id: "", label: "Whole home", rent: "" }]);
  });

  it("/demo keeps resolving its own seeded copy first", () => {
    window.history.pushState({}, "", "/demo");
    seedDemoManagerProperties("a-seed", [base]);
    seedDemoManagerProperties("z-manager", [saved(fiveRooms())]);
    expect(getPropertyById(ID)?.listingSubmission).toBeUndefined();
  });
});
