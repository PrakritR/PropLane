import { describe, expect, it } from "vitest";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  bookedBedNights,
  combineOccupancyEntries,
  dayStayDisplayName,
  exportBlockedRanges,
  occupancyForDay,
} from "@/lib/occupancy/snapshot";

const capacities = {
  bedsTotal: (propertyId: string) => (propertyId === "p1" ? 3 : 1),
  roomCapacity: (_propertyId: string, roomId: string) => (roomId === "r3" ? 2 : 1),
};

const entry = (over: Partial<PropertyBookingEntry>): PropertyBookingEntry => ({
  source: "proplane",
  propertyId: "p1",
  propertyLabel: "4709A",
  roomId: "r1",
  roomLabel: "Room 1",
  summary: "Vedel",
  start: "2026-09-15",
  end: "2026-09-30",
  ...over,
});

describe("occupancyForDay", () => {
  it("Sep 29 cell matches the day header — one bed of three", () => {
    const cell = occupancyForDay([entry({})], "2026-09-29", ["p1"], capacities);
    expect(cell).toEqual({ occupied: 1, total: 3, checkIns: 0, checkOuts: 0 });
  });

  it("does not add a bed when Not available overlaps a guest stay in the same room", () => {
    const guest = entry({
      source: "airbnb",
      roomId: "r3",
      roomLabel: "Room 3",
      summary: "Vedel",
      start: "2026-09-15",
      end: "2026-09-30",
    });
    const blocked = entry({
      source: "airbnb",
      roomId: "r3",
      roomLabel: "Room 3",
      summary: "Not available",
      start: "2026-09-15",
      end: "2026-09-30",
    });
    const cell = occupancyForDay([guest, blocked], "2026-09-29", ["p1"], capacities);
    expect(cell.occupied).toBe(1);
  });

  it("two stays in one room count as one bed unless capacity is 2", () => {
    const a = entry({ roomId: "r1", summary: "Ada" });
    const b = entry({ roomId: "r1", summary: "Grace" });
    expect(occupancyForDay([a, b], "2026-09-29", ["p1"], capacities).occupied).toBe(1);

    const c = entry({ roomId: "r3", summary: "Ada" });
    const d = entry({ roomId: "r3", summary: "Grace" });
    expect(occupancyForDay([c, d], "2026-09-29", ["p1"], capacities).occupied).toBe(2);
  });

  it("booked nights never exceed beds × days in the month", () => {
    const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    const nights = bookedBedNights([entry({ start: "2026-01-01", end: "2026-12-31" })], days, ["p1"], capacities);
    expect(nights).toBeLessThanOrEqual(3 * 30);
    expect(nights).toBe(30);
  });
});

describe("combineOccupancyEntries", () => {
  it("drops a duplicate iCal + imported-block stay so a 2-bed room stays one bed", () => {
    const guest = entry({ source: "airbnb", roomId: "r3", summary: "Vedel" });
    const copy = entry({ source: "airbnb", roomId: "r3", summary: "Vedel" });
    const combined = combineOccupancyEntries([guest], [copy]);
    expect(combined).toHaveLength(1);
    expect(occupancyForDay(combined, "2026-09-29", ["p1"], capacities).occupied).toBe(1);
  });
});

describe("dayStayDisplayName", () => {
  it("labels a Not available import Blocked, not a guest", () => {
    expect(dayStayDisplayName({ source: "airbnb", summary: "Not available" })).toBe("Blocked");
  });
});

describe("exportBlockedRanges", () => {
  it("merges leases, holds and typed blocks and never needs an imported iCal row", () => {
    expect(
      exportBlockedRanges({
        leases: [{ start: "2026-09-15", end: "2026-09-20" }],
        holds: [{ start: "2026-09-21", end: "2026-09-22" }],
        typedBlocks: [{ start: "2026-09-23", end: "2026-09-23" }],
      }),
    ).toEqual([{ start: "2026-09-15", end: "2026-09-23" }]);
  });
});
