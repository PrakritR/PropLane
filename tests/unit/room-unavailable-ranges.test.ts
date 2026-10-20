import { describe, expect, it } from "vitest";
import { roomAvailability, roomUnavailableRanges } from "@/lib/room-availability";
import { nextDayKey } from "@/lib/room-occupancy-rule";

const TODAY = "2026-10-13";
const room = (extra: Record<string, unknown> = {}) => ({ availability: "Available now", ...extra });

/** The first day on or after today the ranges leave open, scanning forward. */
function firstOpenDay(ranges: ReturnType<typeof roomUnavailableRanges>): string | null {
  let day = TODAY;
  for (let i = 0; i < 400; i += 1) {
    const red = ranges.some((r) => r.start <= day && (r.end === null || day <= r.end));
    if (!red) return day;
    day = nextDayKey(day);
  }
  return null;
}

describe("roomUnavailableRanges", () => {
  it("draws nothing for an open room", () => {
    expect(roomUnavailableRanges(room(), [], TODAY)).toEqual([]);
  });

  it("draws a room the status calls Not available as red from today with no end", () => {
    const leased = room({ availability: "Leased" });
    expect(roomAvailability(leased, [], TODAY)).toEqual({ kind: "unavailable" });
    expect(roomUnavailableRanges(leased, [], TODAY)).toEqual([{ start: TODAY, end: null }]);
  });

  it("draws a span that covers today through its last day", () => {
    const spans = [{ start: "2026-09-01", end: "2026-10-31", count: 1 }];
    expect(roomUnavailableRanges(room(), spans, TODAY)).toEqual([{ start: TODAY, end: "2026-10-31" }]);
  });

  it("draws a future booking and leaves today open", () => {
    const spans = [{ start: "2026-11-05", end: "2026-11-08", count: 1 }];
    expect(roomUnavailableRanges(room(), spans, TODAY)).toEqual([{ start: "2026-11-05", end: "2026-11-08" }]);
  });

  it("draws an open-ended span as red with no end, matching Not available", () => {
    const spans = [{ start: "2026-08-01", end: null, count: 1 }];
    expect(roomAvailability(room(), spans, TODAY)).toEqual({ kind: "unavailable" });
    expect(roomUnavailableRanges(room(), spans, TODAY)).toEqual([{ start: TODAY, end: null }]);
  });

  it("merges back-to-back spans into one red range", () => {
    const spans = [
      { start: "2026-09-01", end: "2026-10-15", count: 1 },
      { start: "2026-10-16", end: "2026-10-25", count: 1 },
    ];
    expect(roomUnavailableRanges(room(), spans, TODAY)).toEqual([{ start: TODAY, end: "2026-10-25" }]);
  });

  it("leaves a shared room open until every bed is taken", () => {
    const shared = room({ occupancyCapacity: 2 });
    expect(roomUnavailableRanges(shared, [{ start: "2026-09-01", end: "2026-12-01", count: 1 }], TODAY)).toEqual([]);
    expect(roomUnavailableRanges(shared, [{ start: "2026-09-01", end: "2026-12-01", count: 2 }], TODAY)).toEqual([
      { start: TODAY, end: "2026-12-01" },
    ]);
    // Two overlapping one-bed spans fill it only where they overlap.
    const spans = [
      { start: "2026-10-01", end: "2026-10-20", count: 1 },
      { start: "2026-10-15", end: "2026-11-10", count: 1 },
    ];
    expect(roomUnavailableRanges(shared, spans, TODAY)).toEqual([{ start: "2026-10-15", end: "2026-10-20" }]);
  });

  it("holds the room red until a dated opening in the room's own copy", () => {
    const later = room({ availability: "Available from Dec 1, 2026" });
    const status = roomAvailability(later, [], TODAY);
    expect(status).toEqual({ kind: "from", date: "2026-12-01" });
    expect(roomUnavailableRanges(later, [], TODAY)).toEqual([{ start: TODAY, end: "2026-11-30" }]);
  });

  it("agrees with the status line: the first open day is the status's own date", () => {
    const cases: Array<[Record<string, unknown>, Array<{ start: string; end: string | null; count: number }>]> = [
      [room(), []],
      [room(), [{ start: "2026-09-01", end: TODAY, count: 1 }]],
      [room(), [{ start: "2026-10-14", end: "2026-12-01", count: 1 }]],
      [room(), [
        { start: "2026-09-01", end: "2026-10-15", count: 1 },
        { start: "2026-10-16", end: "2026-10-25", count: 1 },
        { start: "2026-11-30", end: "2026-12-05", count: 1 },
      ]],
      [room({ occupancyCapacity: 3 }), [{ start: "2026-09-01", end: "2026-11-01", count: 2 }]],
      [room({ occupancyCapacity: 2 }), [{ start: "2026-09-01", end: "2026-11-01", count: 2 }]],
      [room({ availability: "Available from Dec 1, 2026" }), [{ start: "2026-09-01", end: "2026-12-10", count: 1 }]],
      [room({ availability: "Leased" }), []],
      [room(), [{ start: "2026-08-01", end: null, count: 1 }]],
    ];
    for (const [r, spans] of cases) {
      const status = roomAvailability(r, spans, TODAY);
      const open = firstOpenDay(roomUnavailableRanges(r, spans, TODAY));
      if (status.kind === "now") expect(open).toBe(TODAY);
      else if (status.kind === "from") expect(open).toBe(status.date);
      else expect(open).toBeNull();
    }
  });
});
