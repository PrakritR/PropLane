import { describe, expect, it } from "vitest";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import {
  createDefaultListingSubmission,
  duplicateRoomEntry,
  emptyRoom,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";

/**
 * Rooms live in a JSON blob on `manager_property_records.row_data`, so a field is
 * only durable if the normalizer knows about it — otherwise it survives in memory
 * and vanishes on the next save/reload cycle.
 */
function submissionWithRoom(room: Partial<ManagerRoomSubmission>): ManagerListingSubmissionV1 {
  const base = createDefaultListingSubmission();
  return {
    ...base,
    rooms: [{ ...base.rooms[0]!, id: "r1", name: "Room A", monthlyRent: 700, ...room }],
  };
}

function normalizedRoom(room: Partial<ManagerRoomSubmission>): ManagerRoomSubmission {
  return normalizeManagerListingSubmissionV1(submissionWithRoom(room)).rooms[0]!;
}

describe("occupancyCapacity survives normalization", () => {
  it("defaults an existing room with no capacity to a single resident", () => {
    // Every room that predates per-bed rentals must behave exactly as before.
    expect(normalizedRoom({}).occupancyCapacity).toBe(1);
  });

  it("keeps an explicit capacity of 2 through a save/reload cycle", () => {
    expect(normalizedRoom({ occupancyCapacity: 2 }).occupancyCapacity).toBe(2);
  });

  it("survives a SECOND normalization, which is what a real reload does", () => {
    const once = normalizeManagerListingSubmissionV1(submissionWithRoom({ occupancyCapacity: 3 }));
    const twice = normalizeManagerListingSubmissionV1(once);
    expect(twice.rooms[0]!.occupancyCapacity).toBe(3);
  });

  it("reads a malformed stored capacity as 1 rather than trusting it", () => {
    for (const bad of [0, -1, 2.5, 21, Number.NaN, "many", {}, []]) {
      expect(normalizedRoom({ occupancyCapacity: bad as number }).occupancyCapacity).toBe(1);
    }
  });

  it("carries capacity onto a duplicated room", () => {
    // duplicateRoomEntry spreads the source today, so this passes by construction —
    // it is here so converting that spread to an explicit field list cannot silently
    // drop capacity and turn a copied shared room back into a single.
    const source = normalizedRoom({ occupancyCapacity: 4 });
    expect(duplicateRoomEntry(source).occupancyCapacity).toBe(4);
  });

  it("gives a brand-new room a single resident", () => {
    expect(normalizeRoomOccupancyCapacity(emptyRoom(0).occupancyCapacity)).toBe(1);
  });

  it("does not disturb the room's pricing fields", () => {
    // Capacity decides how many people may hold the room; it never changes the rate.
    // Each resident pays the room's own rent in full, so nothing here is divided.
    const room = normalizedRoom({ occupancyCapacity: 2, monthlyRent: 700 });
    expect(room.monthlyRent).toBe(700);
    expect(room.rentBasis).toBe("monthly");
  });
});
