// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PORTAL_FILTER_POPOVER_MAX_FIELDS,
  PORTAL_FILTER_POPOVER_MIN_SPACE_BELOW_PX,
  resolveMobileFilterPopover,
} from "@/components/portal/portal-filter-sort-sheet";

function makeTrigger({ bottom = 200, width = 100, height = 40 }: { bottom?: number; width?: number; height?: number } = {}) {
  const trigger = document.createElement("button");
  vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
    bottom,
    width,
    height,
    top: bottom - height,
    left: 0,
    right: width,
    x: 0,
    y: bottom - height,
    toJSON() {
      return this;
    },
  } as DOMRect);
  return trigger;
}

const baseArgs = () => ({
  trigger: makeTrigger(),
  desktopPresentation: "dropdown" as const,
  compactPanel: true,
  filterFieldCount: 1,
  hasExtraModalContent: false,
  insets: { bottom: 0, bottomNav: 0 },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("resolveMobileFilterPopover", () => {
  it("chooses the anchored popover when every condition is satisfied", () => {
    window.innerHeight = 844;
    expect(resolveMobileFilterPopover(baseArgs())).toBe(true);
  });

  it("falls back to the sheet when desktopPresentation is panel", () => {
    window.innerHeight = 844;
    expect(resolveMobileFilterPopover({ ...baseArgs(), desktopPresentation: "panel" })).toBe(false);
  });

  it("falls back to the sheet when desktopPresentation is inline", () => {
    window.innerHeight = 844;
    expect(resolveMobileFilterPopover({ ...baseArgs(), desktopPresentation: "inline" })).toBe(false);
  });

  it("falls back to the sheet when compactPanel is false", () => {
    window.innerHeight = 844;
    expect(resolveMobileFilterPopover({ ...baseArgs(), compactPanel: false })).toBe(false);
  });

  it("falls back to the sheet just past the max field count, and still pops over at exactly the max", () => {
    window.innerHeight = 844;
    expect(
      resolveMobileFilterPopover({ ...baseArgs(), filterFieldCount: PORTAL_FILTER_POPOVER_MAX_FIELDS + 1 }),
    ).toBe(false);
    expect(
      resolveMobileFilterPopover({ ...baseArgs(), filterFieldCount: PORTAL_FILTER_POPOVER_MAX_FIELDS }),
    ).toBe(true);
  });

  it("falls back to the sheet when there is extra modal content", () => {
    window.innerHeight = 844;
    expect(resolveMobileFilterPopover({ ...baseArgs(), hasExtraModalContent: true })).toBe(false);
  });

  it("fails safe to the sheet when the trigger is null", () => {
    window.innerHeight = 844;
    expect(resolveMobileFilterPopover({ ...baseArgs(), trigger: null })).toBe(false);
  });

  it("fails safe to the sheet when the trigger's rect is 0x0 (unmeasurable)", () => {
    window.innerHeight = 844;
    expect(
      resolveMobileFilterPopover({ ...baseArgs(), trigger: makeTrigger({ width: 0, height: 0 }) }),
    ).toBe(false);
  });

  describe("the space-below boundary", () => {
    // spaceBelow = viewportHeight - rect.bottom - 12 - insets.bottom - insets.bottomNav
    it("chooses the popover at exactly the minimum required space, and the sheet one pixel short", () => {
      const viewportHeight = 1000;
      window.innerHeight = viewportHeight;
      // spaceBelow = viewportHeight - rect.bottom - 12 (zero insets); solve for rect.bottom
      // that lands spaceBelow exactly on the threshold.
      const bottomForExactThreshold = viewportHeight - 12 - PORTAL_FILTER_POPOVER_MIN_SPACE_BELOW_PX;
      expect(
        resolveMobileFilterPopover({
          ...baseArgs(),
          trigger: makeTrigger({ bottom: bottomForExactThreshold }),
          insets: { bottom: 0, bottomNav: 0 },
        }),
      ).toBe(true);
      expect(
        resolveMobileFilterPopover({
          ...baseArgs(),
          trigger: makeTrigger({ bottom: bottomForExactThreshold + 1 }),
          insets: { bottom: 0, bottomNav: 0 },
        }),
      ).toBe(false);
    });

    it("a large bottom-nav inset eats the same room that otherwise would have given a popover", () => {
      const viewportHeight = 1000;
      window.innerHeight = viewportHeight;
      const bottomForExactThreshold = viewportHeight - 12 - PORTAL_FILTER_POPOVER_MIN_SPACE_BELOW_PX;
      // With zero insets this geometry is exactly at the popover threshold.
      expect(
        resolveMobileFilterPopover({
          ...baseArgs(),
          trigger: makeTrigger({ bottom: bottomForExactThreshold }),
          insets: { bottom: 0, bottomNav: 0 },
        }),
      ).toBe(true);
      // The same geometry with a real bottom-nav inset eats the room and forces the sheet.
      expect(
        resolveMobileFilterPopover({
          ...baseArgs(),
          trigger: makeTrigger({ bottom: bottomForExactThreshold }),
          insets: { bottom: 0, bottomNav: 40 },
        }),
      ).toBe(false);
    });
  });
});
