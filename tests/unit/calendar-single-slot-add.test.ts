/**
 * Single-cell Add on the manager calendar must paint only the clicked slot
 * without silently dropping that day's implicit default band — and, when the
 * band is OFF, without silently publishing it (PRP-397).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_TOUR_END_SLOT_EXCLUSIVE,
  DEFAULT_TOUR_START_SLOT,
  addExplicitTourSlotKeys,
  resolveDefaultTourAvailabilityConfig,
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
  const bandOn = resolveDefaultTourAvailabilityConfig({ enabled: true });
  /** What both manager calendars pass, and what the public route reads for a manager who never opted in. */
  const bandOff = resolveDefaultTourAvailabilityConfig({ enabled: false });

  it("keeps the 9-5 default when adding an evening slot on a default-only day", () => {
    const painted = addExplicitTourSlotKeys([], date, eveningSlot, bandOn, now);
    const offered = new Set(resolveTourOfferingSlots(painted, now, bandOn));

    expect(offered.has(`${date}:${eveningSlot}`)).toBe(true);
    expect(offered.has(`${date}:${DEFAULT_TOUR_START_SLOT}`)).toBe(true);
    expect(offered.has(`${date}:${DEFAULT_TOUR_END_SLOT_EXCLUSIVE - 1}`)).toBe(true);
  });

  it("adds only one more slot when the day already has explicit availability", () => {
    const painted = [`${date}:${DEFAULT_TOUR_START_SLOT + 5}`];
    const next = addExplicitTourSlotKeys(painted, date, DEFAULT_TOUR_START_SLOT + 6, bandOn, now);

    expect(next).toContain(`${date}:${DEFAULT_TOUR_START_SLOT + 5}`);
    expect(next).toContain(`${date}:${DEFAULT_TOUR_START_SLOT + 6}`);
    expect(next.filter((key) => key.startsWith(`${date}:`)).length).toBe(2);
  });

  it("writes exactly the clicked slotKey when the default band is off (PRP-397)", () => {
    // The band was materialised regardless of the switch, so one click on an
    // empty day published sixteen windows the public grid was never offering.
    const next = addExplicitTourSlotKeys([], date, eveningSlot, bandOff, now);
    expect(next).toEqual([`${date}:${eveningSlot}`]);

    // And the public grid agrees: only the clicked window is on offer.
    expect(resolveTourOfferingSlots(next, now, bandOff)).toEqual([`${date}:${eveningSlot}`]);
  });

  it("with the band off, a second click still adds just one more key", () => {
    const painted = [`${date}:${eveningSlot}`];
    const next = addExplicitTourSlotKeys(painted, date, eveningSlot + 1, bandOff, now);
    expect(next.sort()).toEqual([`${date}:${eveningSlot}`, `${date}:${eveningSlot + 1}`].sort());
  });

  it("the resolver's own default config keeps the band off, matching the public route", () => {
    // `resolveDefaultTourAvailabilityConfig()` without an explicit `enabled: true`
    // is the band-off shape, so a caller that forgets the config cannot publish
    // a day it did not mean to.
    const next = addExplicitTourSlotKeys([], date, eveningSlot, undefined, now);
    expect(next).toEqual([`${date}:${eveningSlot}`]);
  });
});
