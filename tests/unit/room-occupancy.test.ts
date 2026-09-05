import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROOM_OCCUPANCY_CAPACITY,
  MAX_ROOM_OCCUPANCY_CAPACITY,
  evaluateRoomOccupancy,
  isValidRoomOccupancyCapacityInput,
  normalizeRoomOccupancyCapacity,
  type RoomOccupancyPlacement,
} from "@/lib/rental-application/room-occupancy";

/** Local midnight, matching parseFlexibleLocalDate's output. */
function d(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, day);
}

function placement(id: string, start: Date, end: Date | null): RoomOccupancyPlacement {
  return { id, start, end };
}

describe("normalizeRoomOccupancyCapacity — legacy rows read as 1, never as 'unlimited'", () => {
  it("defaults a missing capacity to 1 so every existing room behaves exactly as today", () => {
    expect(DEFAULT_ROOM_OCCUPANCY_CAPACITY).toBe(1);
    expect(normalizeRoomOccupancyCapacity(undefined)).toBe(1);
    expect(normalizeRoomOccupancyCapacity(null)).toBe(1);
  });

  it("accepts whole numbers from 1 to the documented ceiling", () => {
    expect(MAX_ROOM_OCCUPANCY_CAPACITY).toBe(20);
    expect(normalizeRoomOccupancyCapacity(1)).toBe(1);
    expect(normalizeRoomOccupancyCapacity(2)).toBe(2);
    expect(normalizeRoomOccupancyCapacity(20)).toBe(20);
  });

  it("reads a stored numeric string, because the wizard persists money-ish fields as strings", () => {
    expect(normalizeRoomOccupancyCapacity("3")).toBe(3);
    expect(normalizeRoomOccupancyCapacity(" 3 ")).toBe(3);
  });

  it("FAILS CLOSED to 1 on any invalid stored value — never clamps 21 down to 20", () => {
    // Reading 21 as 20 would silently invent a capacity the manager never chose.
    // Reading it as 1 can only ever under-sell, which is the safe direction.
    expect(normalizeRoomOccupancyCapacity(21)).toBe(1);
    expect(normalizeRoomOccupancyCapacity(0)).toBe(1);
    expect(normalizeRoomOccupancyCapacity(-2)).toBe(1);
    expect(normalizeRoomOccupancyCapacity(2.5)).toBe(1);
    expect(normalizeRoomOccupancyCapacity(Number.NaN)).toBe(1);
    expect(normalizeRoomOccupancyCapacity(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizeRoomOccupancyCapacity("many")).toBe(1);
    expect(normalizeRoomOccupancyCapacity({})).toBe(1);
  });

  it("separates 'valid to save' from 'how to read what is stored'", () => {
    // Save boundaries reject explicit junk instead of silently rewriting it to 1.
    expect(isValidRoomOccupancyCapacityInput(2)).toBe(true);
    expect(isValidRoomOccupancyCapacityInput(20)).toBe(true);
    expect(isValidRoomOccupancyCapacityInput(21)).toBe(false);
    expect(isValidRoomOccupancyCapacityInput(0)).toBe(false);
    expect(isValidRoomOccupancyCapacityInput(2.5)).toBe(false);
    expect(isValidRoomOccupancyCapacityInput("many")).toBe(false);
    // Absent is valid input — it just means "leave it at the default".
    expect(isValidRoomOccupancyCapacityInput(undefined)).toBe(true);
    expect(isValidRoomOccupancyCapacityInput(null)).toBe(true);
  });
});

describe("evaluateRoomOccupancy — capacity is PEAK SIMULTANEOUS occupancy", () => {
  it("reports a free room as fully available", () => {
    const result = evaluateRoomOccupancy({
      capacity: 2,
      placements: [],
      windowStart: d(2026, 3, 1),
      windowEnd: d(2026, 3, 31),
    });
    expect(result.capacity).toBe(2);
    expect(result.peakOccupancy).toBe(0);
    expect(result.remaining).toBe(2);
    expect(result.hasRoom).toBe(true);
    expect(result.fullyBookedIntervals).toEqual([]);
  });

  it("leaves a bed free when one of two is taken", () => {
    const result = evaluateRoomOccupancy({
      capacity: 2,
      placements: [placement("app-1", d(2026, 3, 1), d(2026, 6, 30))],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
    });
    expect(result.peakOccupancy).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.hasRoom).toBe(true);
  });

  it("refuses a third resident in a two-bed room", () => {
    const result = evaluateRoomOccupancy({
      capacity: 2,
      placements: [
        placement("app-1", d(2026, 3, 1), d(2026, 6, 30)),
        placement("app-2", d(2026, 3, 15), d(2026, 8, 31)),
      ],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
    });
    expect(result.peakOccupancy).toBe(2);
    expect(result.remaining).toBe(0);
    expect(result.hasRoom).toBe(false);
  });

  it("preserves single-occupancy behaviour exactly at the default capacity", () => {
    const result = evaluateRoomOccupancy({
      capacity: undefined,
      placements: [placement("app-1", d(2026, 3, 1), d(2026, 6, 30))],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
    });
    expect(result.capacity).toBe(1);
    expect(result.hasRoom).toBe(false);
  });

  it("counts PEAK, not total: two disjoint stays across a long span use ONE bed", () => {
    // The whole point of the sweep. Summing every intersecting lease would say 2
    // and wrongly refuse a second resident in a capacity-2 room.
    const result = evaluateRoomOccupancy({
      capacity: 2,
      placements: [
        placement("app-1", d(2026, 1, 1), d(2026, 3, 31)),
        placement("app-2", d(2026, 6, 1), d(2026, 9, 30)),
      ],
      windowStart: d(2026, 1, 1),
      windowEnd: d(2026, 12, 31),
    });
    expect(result.peakOccupancy).toBe(1);
    expect(result.remaining).toBe(1);
    expect(result.hasRoom).toBe(true);
  });

  it("treats an inclusive same-day turnover as an overlap, matching today's rule", () => {
    // A leaves Mar 31, B arrives Mar 31 — both occupy that day.
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [
        placement("app-1", d(2026, 1, 1), d(2026, 3, 31)),
        placement("app-2", d(2026, 3, 31), d(2026, 6, 30)),
      ],
      windowStart: d(2026, 1, 1),
      windowEnd: d(2026, 12, 31),
    });
    expect(result.peakOccupancy).toBe(2);
    expect(result.hasRoom).toBe(false);
  });

  it("frees the bed the day after an inclusive end date", () => {
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [placement("app-1", d(2026, 1, 1), d(2026, 3, 31))],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
    });
    expect(result.peakOccupancy).toBe(0);
    expect(result.hasRoom).toBe(true);
  });

  it("treats an open-ended placement as occupying through infinity", () => {
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [placement("app-1", d(2026, 1, 1), null)],
      windowStart: d(2030, 1, 1),
      windowEnd: d(2030, 12, 31),
    });
    expect(result.peakOccupancy).toBe(1);
    expect(result.hasRoom).toBe(false);
  });

  it("supports an open-ended REQUEST without falling over", () => {
    const result = evaluateRoomOccupancy({
      capacity: 2,
      placements: [
        placement("app-1", d(2026, 1, 1), d(2026, 3, 31)),
        placement("app-2", d(2026, 6, 1), null),
      ],
      windowStart: d(2026, 1, 1),
      windowEnd: null,
    });
    expect(result.peakOccupancy).toBe(1);
    expect(result.hasRoom).toBe(true);
  });

  it("ignores placements entirely outside the requested window", () => {
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [placement("app-1", d(2025, 1, 1), d(2025, 2, 1))],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
    });
    expect(result.peakOccupancy).toBe(0);
    expect(result.hasRoom).toBe(true);
  });
});

describe("evaluateRoomOccupancy — identity handling", () => {
  it("excludes the application being edited, so a resident never blocks themselves", () => {
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [placement("app-1", d(2026, 1, 1), d(2026, 12, 31))],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
      excludeId: "app-1",
    });
    expect(result.peakOccupancy).toBe(0);
    expect(result.hasRoom).toBe(true);
  });

  it("deduplicates aliases of ONE application rather than double-counting it", () => {
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [
        placement("app-1", d(2026, 1, 1), d(2026, 12, 31)),
        placement("app-1", d(2026, 1, 1), d(2026, 12, 31)),
      ],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
    });
    expect(result.peakOccupancy).toBe(1);
  });

  it("does NOT collapse two different residents who happen to share identical dates", () => {
    // The mirror of the test above, and the one that would silently oversell the room.
    const result = evaluateRoomOccupancy({
      capacity: 2,
      placements: [
        placement("app-1", d(2026, 1, 1), d(2026, 12, 31)),
        placement("app-2", d(2026, 1, 1), d(2026, 12, 31)),
      ],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
    });
    expect(result.peakOccupancy).toBe(2);
    expect(result.hasRoom).toBe(false);
  });

  it("matches ids case- and whitespace-insensitively when excluding", () => {
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [placement(" APP-1 ", d(2026, 1, 1), d(2026, 12, 31))],
      windowStart: d(2026, 4, 1),
      windowEnd: d(2026, 4, 30),
      excludeId: "app-1",
    });
    expect(result.hasRoom).toBe(true);
  });
});

describe("evaluateRoomOccupancy — fully booked intervals drive the calendar", () => {
  it("reports only the stretch where the room actually reaches capacity", () => {
    const result = evaluateRoomOccupancy({
      capacity: 2,
      placements: [
        placement("app-1", d(2026, 1, 1), d(2026, 6, 30)),
        placement("app-2", d(2026, 4, 1), d(2026, 9, 30)),
      ],
      windowStart: d(2026, 1, 1),
      windowEnd: d(2026, 12, 31),
    });
    // Both present only from Apr 1 through Jun 30; either side has a free bed.
    expect(result.fullyBookedIntervals).toHaveLength(1);
    expect(result.fullyBookedIntervals[0]!.start).toEqual(d(2026, 4, 1));
    expect(result.fullyBookedIntervals[0]!.end).toEqual(d(2026, 6, 30));
  });

  it("leaves the end open when the room is full with no known release date", () => {
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [placement("app-1", d(2026, 1, 1), null)],
      windowStart: d(2026, 1, 1),
      windowEnd: null,
    });
    expect(result.fullyBookedIntervals).toHaveLength(1);
    expect(result.fullyBookedIntervals[0]!.start).toEqual(d(2026, 1, 1));
    expect(result.fullyBookedIntervals[0]!.end).toBeNull();
  });

  it("keeps a capacity-1 room's full window identical to today's single-occupancy block", () => {
    const result = evaluateRoomOccupancy({
      capacity: 1,
      placements: [placement("app-1", d(2026, 2, 1), d(2026, 5, 31))],
      windowStart: d(2026, 1, 1),
      windowEnd: d(2026, 12, 31),
    });
    expect(result.fullyBookedIntervals).toEqual([{ start: d(2026, 2, 1), end: d(2026, 5, 31) }]);
  });
});
