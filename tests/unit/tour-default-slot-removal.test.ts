/**
 * The manager calendar shows the implicit 9-5 default as removable windows.
 *
 * Removing one has to write the REST of that day back explicitly, because
 * painting anything on a day takes it off the default
 * (`resolveTourOfferingSlots`). Without that, dropping a single window would
 * silently close the whole day to prospects — the opposite of what the manager
 * asked for.
 *
 * Pinned in UTC: slot keys are Pacific wall time, and a Pacific dev box cannot
 * see the class of bug this guards.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  DEFAULT_TOUR_START_SLOT,
  defaultTourSlotKeysForDate,
  resolveTourOfferingSlots,
} from "@/lib/tour-slot-math";

beforeAll(() => {
  process.env.TZ = "UTC";
});

/** Mirrors the calendar's removeDefaultSlot: materialize the day, drop one. */
function removeOneDefaultWindow(dateStr: string, slotIdx: number): string[] {
  const removed = `${dateStr}:${slotIdx}`;
  return defaultTourSlotKeysForDate(dateStr).filter((key) => key !== removed);
}

describe("defaultTourSlotKeysForDate", () => {
  it("covers the whole 9-5 default band for one date", () => {
    const keys = defaultTourSlotKeysForDate("2026-09-15");
    expect(keys.length).toBe(DEFAULT_TOUR_END_SLOT_EXCLUSIVE - DEFAULT_TOUR_START_SLOT);
    expect(keys[0]).toBe(`2026-09-15:${DEFAULT_TOUR_START_SLOT}`);
    expect(keys.at(-1)).toBe(`2026-09-15:${DEFAULT_TOUR_END_SLOT_EXCLUSIVE - 1}`);
  });

  it("returns nothing for a malformed date rather than throwing", () => {
    expect(defaultTourSlotKeysForDate("nonsense")).toEqual([]);
    expect(defaultTourSlotKeysForDate("")).toEqual([]);
  });
});

describe("removing one default window", () => {
  // Far enough ahead to stay inside the offering horizon and never be "past".
  const date = "2026-08-20";
  const now = Date.parse("2026-08-18T12:00:00Z");

  it("keeps the rest of the day bookable", () => {
    const painted = removeOneDefaultWindow(date, DEFAULT_TOUR_START_SLOT);
    const offered = new Set(resolveTourOfferingSlots(painted, now));

    // The removed 9am window is gone...
    expect(offered.has(`${date}:${DEFAULT_TOUR_START_SLOT}`)).toBe(false);
    // ...and every other window that day survives.
    for (let slot = DEFAULT_TOUR_START_SLOT + 1; slot < DEFAULT_TOUR_END_SLOT_EXCLUSIVE; slot += 1) {
      expect(offered.has(`${date}:${slot}`)).toBe(true);
    }
  });

  it("does not close the day — the failure mode this guards against", () => {
    const painted = removeOneDefaultWindow(date, DEFAULT_TOUR_START_SLOT);
    const offered = resolveTourOfferingSlots(painted, now).filter((k) => k.startsWith(`${date}:`));
    expect(offered.length).toBe(DEFAULT_TOUR_END_SLOT_EXCLUSIVE - DEFAULT_TOUR_START_SLOT - 1);
  });

  it("leaves other days on the untouched default", () => {
    const painted = removeOneDefaultWindow(date, DEFAULT_TOUR_START_SLOT);
    const offered = new Set(resolveTourOfferingSlots(painted, now));
    const otherDay = "2026-08-21";
    expect(offered.has(`${otherDay}:${DEFAULT_TOUR_START_SLOT}`)).toBe(true);
  });

  it("removing with NO explicit write would have closed the day (why we materialize)", () => {
    // Painting nothing leaves the day implicit, so the default returns in full —
    // which is why a naive "just delete the slot" could never work.
    const offered = new Set(resolveTourOfferingSlots([], now));
    expect(offered.has(`${date}:${DEFAULT_TOUR_START_SLOT}`)).toBe(true);
  });
});
