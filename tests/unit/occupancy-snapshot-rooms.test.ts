import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { occupancySnapshotForManager } from "@/lib/occupancy/snapshot.server";
import { UNASSIGNED_ROOM_LABEL } from "@/lib/channel-calendar/property-bookings";

/**
 * The Bookings calendar draws a row per saved room. A viewer whose listing store lacks the house
 * (PropLane service staff, a fresh device) gets them from the occupancy snapshot, in saved order,
 * and a stay on an id nobody saved reads "Unassigned room", never a bare "Room".
 */
const OWNER = "owner-1";
const HOUSE = "maple-1";

function listing(names: string[], category?: string) {
  const submission = createDefaultListingSubmission();
  submission.rentalStyle = "rooms";
  if (category) submission.listingPlaceCategoryId = category;
  submission.rooms = names.map((name, i) => ({ ...submission.rooms[0]!, id: `room-${i + 1}`, name, occupancyCapacity: 1 }));
  return submission;
}

const resident = (id: string, name: string, roomChoice: string) => ({
  id,
  manager_user_id: OWNER,
  property_id: HOUSE,
  assigned_property_id: HOUSE,
  row_data: {
    bucket: "approved",
    manuallyAdded: true,
    name,
    email: `${name.toLowerCase()}@example.test`,
    assignedPropertyId: HOUSE,
    assignedRoomChoice: roomChoice,
    manualResidentDetails: { moveInDate: "2026-09-01", moveOutDate: "2027-08-31", monthlyRent: 900, securityDeposit: 500, leaseTerm: "long_term" },
  },
});

function fakeDb(submission: ReturnType<typeof listing>, applications: unknown[]) {
  return {
    from(table: string) {
      const query = {
        select() { return this; },
        in() { return this; },
        eq() { return this; },
        neq() { return this; },
        or() { return this; },
        is() { return this; },
        like() { return this; },
        order() { return this; },
        limit() { return this; },
        maybeSingle() {
          return Promise.resolve({
            data: table === "manager_property_records" ? { id: HOUSE, manager_user_id: OWNER, property_data: { buildingName: "Maple Duplex", listingSubmission: submission } } : null,
            error: null,
          });
        },
        range(start: number) {
          return Promise.resolve({ data: table === "manager_application_records" ? applications.slice(start) : [], error: null });
        },
        then(resolve: (value: unknown) => unknown) {
          const data = table === "manager_property_records" ? [{ id: HOUSE, manager_user_id: OWNER, property_data: { listingSubmission: submission } }] : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return query;
    },
  } as never;
}

const snapshot = (submission: ReturnType<typeof listing>, applications: unknown[] = []) =>
  occupancySnapshotForManager(fakeDb(submission, applications), OWNER, { propertyIds: [HOUSE], from: "2026-10-01", to: "2026-10-31" });

describe("the occupancy snapshot carries each property's saved rooms", () => {
  it("returns every room in saved order, empty ones included, a blank name reading Room n", async () => {
    const result = await snapshot(listing(["Bedroom A", "   ", "Bedroom C", ""]));
    expect(result.rooms[HOUSE]).toEqual([
      { id: "room-1", label: "Bedroom A" },
      { id: "room-2", label: "Room 2" },
      { id: "room-3", label: "Bedroom C" },
      { id: "room-4", label: "Room 4" },
    ]);
    expect(result.stays).toHaveLength(0);
  });

  it("an entire-home listing has no room list", async () => {
    const result = await snapshot(listing(["A", "B"], "entire_home"));
    expect(result.rooms[HOUSE]).toEqual([]);
  });

  it("a resident stay lands on its saved room's label; an id nobody saved reads Unassigned room, never a bare Room", async () => {
    const result = await snapshot(listing(["Bedroom A", "   ", "Bedroom C"]), [
      resident("AXIS-1", "Akshaya", `${HOUSE}::room-2`),
      resident("AXIS-2", "Riko", `${HOUSE}::room-gone`),
    ]);
    const byName = Object.fromEntries(result.stays.map((stay) => [stay.name, stay.roomLabel]));
    expect(byName.Akshaya).toBe("Room 2");
    expect(byName.Riko).toBe(UNASSIGNED_ROOM_LABEL);
    expect(UNASSIGNED_ROOM_LABEL).toBe("Unassigned room");
    expect(result.stays.some((stay) => stay.roomLabel === "Room")).toBe(false);
  });
});
