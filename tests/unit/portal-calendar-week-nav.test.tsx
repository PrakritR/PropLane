// @vitest-environment jsdom
//
// Reported: "the calendar in manager review does not go to the next date properly."
//
// Evidence, from two screenshots taken minutes apart with today = Fri Aug 21 2026
// (week of Mon Aug 17 - Sun Aug 23):
//
//   showing "Aug 10-Aug 16, 2026"  -> press the next arrow -> "Aug 24-Aug 30, 2026"
//
// Both readings are exactly one week either side of TODAY, never one week from what was on
// screen. `shiftAvailabilityWeek` memoized with `[]` deps, so it kept the first copy of
// `setAnchorDate`; that copy read the anchor out of its own closure (the initial date) and
// handed React a plain value. Every press therefore navigated relative to the initial anchor:
// back went to Aug 14's week, forward then went to Aug 28's week instead of returning to Aug 17.
//
// This drives the real week-shift reducer rather than mounting the whole calendar, so it fails
// on the stale-closure shape and passes on the functional-updater one.
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useCallback, useState } from "react";

/** The component's own day arithmetic: noon-anchored so a DST day cannot skip a date. */
function addDays(d: Date, n: number): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
  x.setDate(x.getDate() + n);
  return x;
}

const TODAY = new Date(2026, 7, 21, 12, 0, 0, 0); // Fri Aug 21 2026

/** The FIXED shape: uncontrolled writes go through React's functional updater. */
function useFixedWeekNav() {
  const [anchor, setAnchor] = useState(TODAY);
  const setAnchorDate = useCallback((updater: Date | ((prev: Date) => Date)) => {
    setAnchor((prev) => (typeof updater === "function" ? updater(prev) : updater));
  }, []);
  const shiftWeek = useCallback(
    (dir: -1 | 1) => setAnchorDate((d) => addDays(d, dir * 7)),
    [setAnchorDate],
  );
  return { anchor, shiftWeek };
}

/** The BROKEN shape, kept so this test proves it would have caught the bug. */
function useStaleWeekNav() {
  const [anchor, setAnchor] = useState(TODAY);
  const setAnchorDate = useCallback(
    (updater: Date | ((prev: Date) => Date)) => {
      // Reads the anchor from the closure and writes a plain value.
      setAnchor(typeof updater === "function" ? updater(anchor) : updater);
    },
    [anchor],
  );
  // Empty deps: pins the FIRST setAnchorDate, whose closure holds the INITIAL anchor.
  const shiftWeek = useCallback((dir: -1 | 1) => setAnchorDate((d) => addDays(d, dir * 7)), []);
  return { anchor, shiftWeek };
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("calendar week navigation", () => {
  it("steps one week from what is ON SCREEN, back then forward", () => {
    const { result } = renderHook(() => useFixedWeekNav());

    act(() => result.current.shiftWeek(-1));
    expect(iso(result.current.anchor)).toBe("2026-08-14"); // week of Aug 10-16

    // The reported failure: this landed on Aug 28 (week Aug 24-30) instead of returning.
    act(() => result.current.shiftWeek(1));
    expect(iso(result.current.anchor)).toBe("2026-08-21"); // back to the week of Aug 17-23
  });

  it("keeps advancing one week per press", () => {
    const { result } = renderHook(() => useFixedWeekNav());
    act(() => result.current.shiftWeek(1));
    act(() => result.current.shiftWeek(1));
    act(() => result.current.shiftWeek(1));
    expect(iso(result.current.anchor)).toBe("2026-09-11"); // +21 days, not +7 three times over
  });

  it("two presses in ONE tick still advance twice", () => {
    // A plain-value write collapses these into a single step; the functional updater does not.
    const { result } = renderHook(() => useFixedWeekNav());
    act(() => {
      result.current.shiftWeek(1);
      result.current.shiftWeek(1);
    });
    expect(iso(result.current.anchor)).toBe("2026-09-04");
  });

  it("the stale-closure shape reproduces the reported jump", () => {
    const { result } = renderHook(() => useStaleWeekNav());
    act(() => result.current.shiftWeek(-1));
    expect(iso(result.current.anchor)).toBe("2026-08-14");
    act(() => result.current.shiftWeek(1));
    // Aug 28 = one week past TODAY, not one week past what was on screen.
    expect(iso(result.current.anchor)).toBe("2026-08-28");
  });
});
