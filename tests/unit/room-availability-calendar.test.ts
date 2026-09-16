import { describe, expect, it } from "vitest";
import {
  buildMonthDayCells,
  clipPaintRange,
  dayIsUnavailable,
  mergePaintedOccupiedRanges,
  monthAvailabilityTone,
  monthToneLabel,
  resolveAvailabilityMonthRange,
  resizeOccupiedDateRange,
} from "@/lib/room-availability-calendar";

describe("room-availability-calendar", () => {
  const today = new Date(2026, 7, 8); // Aug 8, 2026

  it("marks days inside an unavailability window as blocked", () => {
    const windows = [{ start: new Date(2026, 7, 10), end: new Date(2026, 7, 15) }];
    expect(dayIsUnavailable(new Date(2026, 7, 9), windows)).toBe(false);
    expect(dayIsUnavailable(new Date(2026, 7, 12), windows)).toBe(true);
    expect(dayIsUnavailable(new Date(2026, 7, 16), windows)).toBe(false);
  });

  it("builds a month grid with leading blanks", () => {
    const cells = buildMonthDayCells(new Date(2026, 7, 1));
    expect(cells[0]).toBeNull();
    expect(cells.filter(Boolean)).toHaveLength(31);
  });

  it("classifies a fully open month as available", () => {
    expect(monthAvailabilityTone(new Date(2026, 9, 1), [], today)).toBe("available");
  });

  it("classifies a fully blocked future month as unavailable", () => {
    const windows = [{ start: new Date(2026, 9, 1), end: new Date(2026, 9, 31) }];
    expect(monthAvailabilityTone(new Date(2026, 9, 1), windows, today)).toBe("unavailable");
  });

  it("classifies partial-month blocks as mixed", () => {
    const windows = [{ start: new Date(2026, 7, 20), end: new Date(2026, 7, 25) }];
    expect(monthAvailabilityTone(new Date(2026, 7, 1), windows, today)).toBe("mixed");
  });

  it("extends the range when windows reach beyond the default horizon", () => {
    const windows = [{ start: new Date(2027, 8, 1), end: new Date(2027, 8, 30) }];
    const { monthCount } = resolveAvailabilityMonthRange(windows, { today, horizonMonths: 12 });
    expect(monthCount).toBeGreaterThan(12);
  });

  it("labels month tones for the calendar legend", () => {
    expect(monthToneLabel("available")).toBe("Open");
    expect(monthToneLabel("unavailable")).toBe("Unavailable");
    expect(monthToneLabel("mixed")).toBe("Mixed");
  });
});

describe("clipPaintRange / merge / resize", () => {
  const booked = (keys: string[]) => (day: string) => keys.includes(day);

  it("clips a paint before a booked day and refuses a booked origin", () => {
    expect(clipPaintRange("2026-09-20", "2026-09-25", booked(["2026-09-23"]))).toEqual({
      start: "2026-09-20",
      end: "2026-09-22",
    });
    expect(clipPaintRange("2026-09-23", "2026-09-25", booked(["2026-09-23"]))).toBeNull();
  });

  it("merges overlapping and adjacent occupied rows", () => {
    const merged = mergePaintedOccupiedRanges(
      [{ id: "a", start: "2026-09-01", end: "2026-09-03" }],
      "2026-09-04",
      "2026-09-05",
      "new",
    );
    expect(merged).toEqual([{ id: "a", start: "2026-09-01", end: "2026-09-05" }]);
  });

  it("resizes a span and refuses covering a booked day", () => {
    const ranges = [{ id: "a", start: "2026-09-16", end: "2026-09-16" }];
    expect(resizeOccupiedDateRange(ranges, "a", "end", "2026-09-18", booked([]))).toEqual([
      { id: "a", start: "2026-09-16", end: "2026-09-18" },
    ]);
    expect(resizeOccupiedDateRange(ranges, "a", "end", "2026-09-18", booked(["2026-09-17"]))).toBeNull();
  });
});

