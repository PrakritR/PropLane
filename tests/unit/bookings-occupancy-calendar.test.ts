import { describe, expect, it } from "vitest";
import {
  dayOccupancy,
  monthOccupancyPercent,
  occupancyHeatBucket,
  occupancyPercent,
  rangeOccupancyPercent,
  OCCUPANCY_HEAT_BUCKETS,
} from "@/lib/channel-calendar/bookings-occupancy";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const entry = (over: Partial<PropertyBookingEntry>): PropertyBookingEntry => ({
  source: "proplane",
  propertyId: "p1",
  propertyLabel: "Brooklyn House",
  roomId: "r1",
  roomLabel: "Room 1",
  summary: "Ada Lovelace",
  start: "2026-09-01",
  end: "2026-09-05",
  ...over,
});

const rooms3 = (propertyId: string) => (propertyId === "p1" ? 3 : 1);

describe("dayOccupancy", () => {
  it("counts a room-scoped stay as one occupied room out of the property's total", () => {
    const stats = dayOccupancy([entry({})], "2026-09-02", ["p1"], rooms3);
    expect(stats).toEqual({ occupied: 1, rooms: 3, checkIns: 0, checkOuts: 0 });
  });

  it("counts a whole-home entry (no roomId) as every room occupied", () => {
    const stats = dayOccupancy([entry({ roomId: "" })], "2026-09-02", ["p1"], rooms3);
    expect(stats.occupied).toBe(3);
  });

  it("never double-counts two entries in the same room", () => {
    const stats = dayOccupancy(
      [entry({ roomId: "r1" }), entry({ roomId: "r1", summary: "Second" })],
      "2026-09-02",
      ["p1"],
      rooms3,
    );
    expect(stats.occupied).toBe(1);
  });

  it("counts distinct rooms across several bookings, capped at the property total", () => {
    const stats = dayOccupancy(
      [
        entry({ roomId: "r1" }),
        entry({ roomId: "r2", summary: "Second" }),
        entry({ roomId: "r3", summary: "Third" }),
        entry({ roomId: "r4", summary: "Fourth" }),
      ],
      "2026-09-02",
      ["p1"],
      rooms3,
    );
    expect(stats.occupied).toBe(3); // capped at the property's 3 rooms even though 4 room ids appear
  });

  it("counts a check-in on the start date and a check-out the day after the last night", () => {
    const stayStart = dayOccupancy([entry({ start: "2026-09-02", end: "2026-09-05" })], "2026-09-02", ["p1"], rooms3);
    expect(stayStart.checkIns).toBe(1);
    expect(stayStart.checkOuts).toBe(0);

    const stayEnd = dayOccupancy([entry({ start: "2026-09-02", end: "2026-09-05" })], "2026-09-06", ["p1"], rooms3);
    expect(stayEnd.checkOuts).toBe(1);
    expect(stayEnd.checkIns).toBe(0);
  });

  it("never counts a check-out for an open-ended stay", () => {
    const stats = dayOccupancy(
      [entry({ start: "2026-01-01", end: "2028-01-01", openEnded: true })],
      "2026-09-06",
      ["p1"],
      rooms3,
    );
    expect(stats.checkOuts).toBe(0);
  });

  it("sums occupancy across every property in scope", () => {
    const stats = dayOccupancy(
      [entry({ propertyId: "p1", roomId: "r1" }), entry({ propertyId: "p2", roomId: "", summary: "House 2" })],
      "2026-09-02",
      ["p1", "p2"],
      rooms3,
    );
    // p1: 1 of 3, p2 (whole home, 1 room by the resolver): 1 of 1 -> 2 of 4
    expect(stats).toEqual({ occupied: 2, rooms: 4, checkIns: 0, checkOuts: 0 });
  });
});

describe("occupancyPercent", () => {
  it("rounds to the nearest percent and never exceeds 100", () => {
    expect(occupancyPercent({ occupied: 1, rooms: 3 })).toBe(33);
    expect(occupancyPercent({ occupied: 3, rooms: 3 })).toBe(100);
    expect(occupancyPercent({ occupied: 0, rooms: 0 })).toBe(0);
  });
});

describe("monthOccupancyPercent / rangeOccupancyPercent agree with the grid", () => {
  it("a month's percent equals the range percent over that month's own day keys — the KPI strip and the grid can never disagree", () => {
    const entries = [entry({ start: "2026-09-01", end: "2026-09-10" })];
    const monthPercent = monthOccupancyPercent(entries, 2026, 8, ["p1"], rooms3);
    const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    const rangePercent = rangeOccupancyPercent(entries, days, ["p1"], rooms3);
    expect(monthPercent).toBe(rangePercent);
    // 10 occupied nights (1 room) over 30 days * 3 rooms = 90 room-nights.
    expect(monthPercent).toBe(Math.round((10 / 90) * 100));
  });

  it("an empty month is 0%, never NaN or a divide-by-zero artifact", () => {
    expect(monthOccupancyPercent([], 2026, 8, ["p1"], rooms3)).toBe(0);
    expect(rangeOccupancyPercent([], [], ["p1"], rooms3)).toBe(0);
  });
});

describe("occupancyHeatBucket — four steps, one legend", () => {
  it("has exactly four buckets", () => {
    expect(OCCUPANCY_HEAT_BUCKETS.map((b) => b.id)).toEqual(["empty", "under-half", "mostly-full", "full"]);
  });

  it("buckets a percent into the right step", () => {
    expect(occupancyHeatBucket(0)).toBe("empty");
    expect(occupancyHeatBucket(1)).toBe("under-half");
    expect(occupancyHeatBucket(49)).toBe("under-half");
    expect(occupancyHeatBucket(50)).toBe("mostly-full");
    expect(occupancyHeatBucket(99)).toBe("mostly-full");
    expect(occupancyHeatBucket(100)).toBe("full");
  });
});
