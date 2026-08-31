/**
 * Reminder timings.
 *
 * The direction is the point: a tour is reminded about before it happens, an
 * application is chased after it was submitted. Storing only a magnitude is
 * what made "15 minutes after submitted" inexpressible.
 */
import { describe, expect, it } from "vitest";
import {
  DAY,
  HOUR,
  MAX_TIMINGS,
  MAX_TIMING_MINUTES,
  MIN_TIMING_MINUTES,
  clampTimingMinutes,
  formatTiming,
  normalizeTimings,
  parseTimingKey,
  summarizeTimings,
  timingKey,
  timingOptions,
  timingSendAt,
} from "@/lib/reminders/timings";

describe("timing keys round-trip", () => {
  it("encodes and parses both directions", () => {
    expect(timingKey({ direction: "before", minutes: DAY })).toBe("before:1440");
    expect(timingKey({ direction: "after", minutes: 15 })).toBe("after:15");
    expect(parseTimingKey("before:1440")).toEqual({ direction: "before", minutes: DAY });
    expect(parseTimingKey("after:15")).toEqual({ direction: "after", minutes: 15 });
  });

  it("rejects anything that is not a timing", () => {
    for (const bad of ["", "soon", "sideways:15", "before:", "before:abc", 42, null, undefined, {}]) {
      expect(parseTimingKey(bad)).toBeNull();
    }
  });

  it("clamps out-of-range magnitudes on the way in", () => {
    expect(parseTimingKey("before:1")?.minutes).toBe(MIN_TIMING_MINUTES);
    expect(parseTimingKey("after:999999")?.minutes).toBe(MAX_TIMING_MINUTES);
    expect(clampTimingMinutes(Number.NaN)).toBe(MIN_TIMING_MINUTES);
  });
});

describe("formatting reads like a person", () => {
  it("says the unit and the direction", () => {
    expect(formatTiming({ direction: "before", minutes: DAY })).toBe("1 day before");
    expect(formatTiming({ direction: "after", minutes: 15 })).toBe("15 minutes after");
    expect(formatTiming({ direction: "before", minutes: 2 * HOUR })).toBe("2 hours before");
  });

  it("summarizes a selection, and says None when empty", () => {
    expect(summarizeTimings(["before:1440", "before:30"])).toBe("1 day before, 30 minutes before");
    expect(summarizeTimings([])).toBe("None");
    expect(summarizeTimings(["garbage"])).toBe("None");
  });
});

describe("options", () => {
  it("offers before longest-first and after shortest-first", () => {
    const before = timingOptions(["before"]);
    expect(before[0]!.label).toBe("7 days before");
    expect(before.at(-1)!.label).toBe("15 minutes before");

    const after = timingOptions(["after"]);
    expect(after[0]!.label).toBe("15 minutes after");
    expect(after.at(-1)!.label).toBe("7 days after");
  });

  it("can offer both directions together", () => {
    const both = timingOptions(["before", "after"]);
    expect(both.some((o) => o.value === "before:15")).toBe(true);
    expect(both.some((o) => o.value === "after:15")).toBe(true);
  });
});

describe("normalizeTimings", () => {
  it("keeps a stored selection in the order the manager chose", () => {
    // Re-sorting a mixed before/after selection has no correct answer and makes
    // the control feel like it is fighting the user.
    expect(normalizeTimings(["after:15", "before:1440"], [])).toEqual(["after:15", "before:1440"]);
  });

  it("drops unreadable entries and dedupes", () => {
    expect(normalizeTimings(["before:1440", "nope", "before:1440"], [])).toEqual(["before:1440"]);
  });

  it("falls back only when nothing usable was stored", () => {
    expect(normalizeTimings(undefined, ["before:30"])).toEqual(["before:30"]);
    expect(normalizeTimings(["junk"], ["before:30"])).toEqual(["before:30"]);
    expect(normalizeTimings([], ["before:30"])).toEqual(["before:30"]);
  });

  it("caps the list", () => {
    const many = ["before:15", "before:30", "before:60", "before:120", "before:240", "before:1440", "before:2880"];
    expect(normalizeTimings(many, []).length).toBe(MAX_TIMINGS);
  });
});

describe("timingSendAt", () => {
  const anchor = new Date("2026-08-31T12:00:00.000Z");

  it("subtracts for before and adds for after", () => {
    expect(timingSendAt({ direction: "before", minutes: HOUR }, anchor).toISOString()).toBe(
      "2026-08-31T11:00:00.000Z",
    );
    expect(timingSendAt({ direction: "after", minutes: HOUR }, anchor).toISOString()).toBe(
      "2026-08-31T13:00:00.000Z",
    );
  });
});
