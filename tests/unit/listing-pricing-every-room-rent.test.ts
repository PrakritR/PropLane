/**
 * Pricing step "Every room" band — monthly rent follows the same default pipeline
 * as utilities/deposit (onDefault → applyHouseDefaultsToRooms).
 */
import { describe, expect, it } from "vitest";
import {
  applyHouseDefaultsToRooms,
  emptyListingHouseDefaults,
  roomsFollowingDefaults,
  type ListingHouseDefaults,
} from "@/lib/listing-house-defaults";
import { createDefaultListingSubmission, type ManagerRoomSubmission } from "@/lib/manager-listing-submission";

function room(over: Partial<ManagerRoomSubmission> = {}): ManagerRoomSubmission {
  const base = createDefaultListingSubmission().rooms[0]!;
  return { ...base, id: over.id ?? "room-a", ...over };
}

describe("listing pricing every-room rent default", () => {
  it("updates following rooms when house monthlyRent changes", () => {
    const previous: ListingHouseDefaults = { ...emptyListingHouseDefaults(), monthlyRent: 1000, utilitiesEstimate: "150" };
    const rooms = [
      room({ id: "r1", monthlyRent: 1000, utilitiesEstimate: "150" }),
      room({ id: "r2", monthlyRent: 1000, utilitiesEstimate: "150" }),
      room({ id: "r3", monthlyRent: 1200, securityDeposit: "250" }),
    ];
    const next = { ...previous, monthlyRent: 1100 };
    const out = applyHouseDefaultsToRooms(rooms, next, {
      onlyFields: ["monthlyRent"],
      previousDefaults: previous,
      roomIds: roomsFollowingDefaults(rooms, previous),
    });
    expect(out.find((r) => r.id === "r1")?.monthlyRent).toBe(1100);
    expect(out.find((r) => r.id === "r2")?.monthlyRent).toBe(1100);
    expect(out.find((r) => r.id === "r3")?.monthlyRent).toBe(1200);
  });
});
