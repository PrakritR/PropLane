/**
 * Single-cell Add on the manager calendar must paint only the clicked slot
 * without silently dropping that day's implicit default band.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  DEFAULT_TOUR_START_SLOT,
  addExplicitTourSlotKeys,
  resolveTourOfferingSlots,
} from "@/lib/tour-slot-math";

beforeAll(() => {
  process.env.TZ = "UTC";
});

describe("addExplicitTourSlotKeys", () => {
  const date = "2026-08-20";
  const now = Date.parse("2026-08-18T12:00:00Z");
  // 6:00 PM Pacific — outside the 9-5 default band, renders as empty Add cells.
  const eveningSlot = 36;

  it("keeps the 9-5 default when adding an evening slot on a default-only day", () => {
    const painted = addExplicitTourSlotKeys([], date, eveningSlot, undefined, now);
    const offered = new Set(resolveTourOfferingSlots(painted, now));

    expect(offered.has(`${date}:${eveningSlot}`)).toBe(true);
    expect(offered.has(`${date}:${DEFAULT_TOUR_START_SLOT}`)).toBe(true);
    expect(offered.has(`${date}:${DEFAULT_TOUR_END_SLOT_EXCLUSIVE - 1}`)).toBe(true);
  });

  it("adds only one more slot when the day already has explicit availability", () => {
    const painted = [`${date}:${DEFAULT_TOUR_START_SLOT + 5}`];
    const next = addExplicitTourSlotKeys(painted, date, DEFAULT_TOUR_START_SLOT + 6, undefined, now);

    expect(next).toContain(`${date}:${DEFAULT_TOUR_START_SLOT + 5}`);
    expect(next).toContain(`${date}:${DEFAULT_TOUR_START_SLOT + 6}`);
    expect(next.filter((key) => key.startsWith(`${date}:`)).length).toBe(2);
  });
});
