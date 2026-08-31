/**
 * The manager calendar shows the implicit 9-5 default as removable windows.
 *
 * Removing one stores a `!date:slot` exclusion marker so the rest of that day
 * stays on the implicit default without painting every other window explicit.
 *
 * Pinned in UTC: slot keys are Pacific wall time, and a Pacific dev box cannot
 * see the class of bug this guards.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  DEFAULT_TOUR_START_SLOT,
  defaultTourSlotExclusionKey,
  defaultTourSlotKeysForDate,
  resolveTourOfferingSlots,
} from "@/lib/tour-slot-math";

beforeAll(() => {
  process.env.TZ = "UTC";
});

/** Mirrors the calendar's removeDefaultSlot: record one exclusion marker. */
function removeOneDefaultWindow(dateStr: string, slotIdx: number, stored: string[] = []): string[] {
  return [...stored, defaultTourSlotExclusionKey(dateStr, slotIdx)];
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

  it("keeps the rest of the day bookable on the implicit default", () => {
    const stored = removeOneDefaultWindow(date, DEFAULT_TOUR_START_SLOT);
    const offered = new Set(resolveTourOfferingSlots(stored, now));

    expect(offered.has(`${date}:${DEFAULT_TOUR_START_SLOT}`)).toBe(false);
    for (let slot = DEFAULT_TOUR_START_SLOT + 1; slot < DEFAULT_TOUR_END_SLOT_EXCLUSIVE; slot += 1) {
      expect(offered.has(`${date}:${slot}`)).toBe(true);
    }
  });

  it("does not close the day — the failure mode this guards against", () => {
    const stored = removeOneDefaultWindow(date, DEFAULT_TOUR_START_SLOT);
    const offered = resolveTourOfferingSlots(stored, now).filter((k) => k.startsWith(`${date}:`));
    expect(offered.length).toBe(DEFAULT_TOUR_END_SLOT_EXCLUSIVE - DEFAULT_TOUR_START_SLOT - 1);
  });

  it("leaves other days on the untouched default", () => {
    const stored = removeOneDefaultWindow(date, DEFAULT_TOUR_START_SLOT);
    const offered = new Set(resolveTourOfferingSlots(stored, now));
    const otherDay = "2026-08-21";
    expect(offered.has(`${otherDay}:${DEFAULT_TOUR_START_SLOT}`)).toBe(true);
  });

  it("removing with NO stored write still offers the full default day", () => {
    const offered = new Set(resolveTourOfferingSlots([], now));
    expect(offered.has(`${date}:${DEFAULT_TOUR_START_SLOT}`)).toBe(true);
  });
});
