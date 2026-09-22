/**
 * Per-door billing, step 1: how many doors one listing counts as
 * (docs/agents/plan-entitlements.md). Pure decision, no database:
 * - a room-partitioned listing sums each room's `occupancyCapacity`;
 * - a whole-home listing (`listingPlaceCategoryId === "entire_home"`) is 1;
 * - a listing with NO rooms recorded is 1 — never 0, and never the
 *   manager-typed bedroom field, which ~44% of live listings never set.
 */
import { describe, expect, it } from "vitest";
import { doorCountForListing } from "@/lib/billing/door-count";

describe("doorCountForListing", () => {
  it("sums each room's occupancyCapacity for a room-partitioned listing", () => {
    expect(
      doorCountForListing({
        listingPlaceCategoryId: "shared_home",
        rooms: [
          { occupancyCapacity: 1 },
          { occupancyCapacity: 1 },
          { occupancyCapacity: 1 },
          { occupancyCapacity: 1 },
        ],
      }),
    ).toEqual({ doors: 4, basis: "rooms" });
  });

  it("counts a room's CAPACITY, not the number of rooms, when a room sleeps more than one", () => {
    expect(
      doorCountForListing({
        listingPlaceCategoryId: "shared_home",
        rooms: [{ occupancyCapacity: 1 }, { occupancyCapacity: 1 }, { occupancyCapacity: 2 }],
      }),
    ).toEqual({ doors: 4, basis: "rooms" });
  });

  it("counts a whole-home listing as 1 door regardless of any rooms array", () => {
    expect(
      doorCountForListing({
        listingPlaceCategoryId: "entire_home",
        rooms: [{ occupancyCapacity: 3 }, { occupancyCapacity: 5 }],
      }),
    ).toEqual({ doors: 1, basis: "whole-home" });
  });

  it("counts a listing with no rooms recorded as 1, basis unrecorded, even when a typed bedroom field says otherwise", () => {
    expect(
      doorCountForListing({
        listingPlaceCategoryId: "shared_home",
        beds: 3, // the manager-typed field — must never be read for billing
        rooms: [],
      }),
    ).toEqual({ doors: 1, basis: "unrecorded" });

    expect(
      doorCountForListing({
        listingPlaceCategoryId: "shared_home",
        beds: 3,
        // rooms key entirely absent
      }),
    ).toEqual({ doors: 1, basis: "unrecorded" });
  });

  it("never returns 0 or NaN for malformed or missing input", () => {
    expect(doorCountForListing(null)).toEqual({ doors: 1, basis: "unrecorded" });
    expect(doorCountForListing(undefined)).toEqual({ doors: 1, basis: "unrecorded" });
    expect(doorCountForListing("garbage")).toEqual({ doors: 1, basis: "unrecorded" });
    expect(doorCountForListing(42)).toEqual({ doors: 1, basis: "unrecorded" });
    expect(doorCountForListing({ rooms: "not-an-array" })).toEqual({ doors: 1, basis: "unrecorded" });
    expect(doorCountForListing({ rooms: [{ occupancyCapacity: -5 }, { occupancyCapacity: "abc" }] })).toEqual({
      // Each malformed capacity reads back as the default of 1 via
      // normalizeRoomOccupancyCapacity, never 0 or NaN.
      doors: 2,
      basis: "rooms",
    });
  });

  it("reads capacity through normalizeRoomOccupancyCapacity, so a room's own out-of-range value reads back as the default rather than exploding the total", () => {
    // normalizeRoomOccupancyCapacity deliberately does not clamp an out-of-range
    // value into range (that would invent a capacity the manager never chose);
    // an unreadable value reads back as the default of 1, same as an absent one.
    expect(doorCountForListing({ rooms: [{ occupancyCapacity: 999 }] })).toEqual({
      doors: 1,
      basis: "rooms",
    });
  });
});
