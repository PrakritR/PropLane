/**
 * Clicking Add on the manager availability grid should paint exactly one slot.
 * The recurring-block modal stays for toolbar / multi-slot drag; single-cell Add
 * is a direct write.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  DEFAULT_TOUR_START_SLOT,
  resolveTourOfferingSlots,
} from "@/lib/tour-slot-math";

beforeAll(() => {
  process.env.TZ = "UTC";
});

function addSingleSlot(painted: string[], dateStr: string, slotIdx: number): string[] {
  const key = `${dateStr}:${slotIdx}`;
  if (painted.includes(key)) return painted;
  return [...painted, key];
}

describe("single-slot availability add", () => {
  const date = "2026-08-20";
  const now = Date.parse("2026-08-18T12:00:00Z");
  const targetSlot = DEFAULT_TOUR_START_SLOT + 2;

  it("adds only the clicked slot on an otherwise-default day", () => {
    const painted = addSingleSlot([], date, targetSlot);
    const offered = new Set(resolveTourOfferingSlots(painted, now));
    const daySlots = [...offered].filter((key) => key.startsWith(`${date}:`));

    expect(daySlots).toEqual([`${date}:${targetSlot}`]);
    expect(offered.has(`${date}:${DEFAULT_TOUR_START_SLOT}`)).toBe(false);
    expect(offered.has(`${date}:${DEFAULT_TOUR_END_SLOT_EXCLUSIVE - 1}`)).toBe(false);
  });

  it("does not materialize the rest of the default band", () => {
    const painted = addSingleSlot([], date, targetSlot);
    const offered = resolveTourOfferingSlots(painted, now).filter((key) => key.startsWith(`${date}:`));
    expect(offered.length).toBe(1);
  });
});
