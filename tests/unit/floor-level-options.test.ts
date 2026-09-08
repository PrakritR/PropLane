import { describe, expect, it } from "vitest";
import {
  clampFloorLabelToStories,
  floorLevelLabelsFromStories,
  floorLevelSelectOptions,
  LISTING_STORIES_OPTIONS,
} from "@/data/manager-listing-presets";

describe("floor/level options derived from the Floors count", () => {
  it("offers a plain count and nothing else", () => {
    // Three kinds of answer used to share one list: a phrase ("Single level"),
    // an open range ("4+ floors") and a shape ("Split level").
    expect(LISTING_STORIES_OPTIONS.map((o) => o.label)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(LISTING_STORIES_OPTIONS.some((o) => o.id === "split")).toBe(false);
  });

  it("derives numbered floors only — no Basement/Loft/Outdoor/Custom", () => {
    expect(floorLevelLabelsFromStories("1")).toEqual(["1st floor"]);
    expect(floorLevelLabelsFromStories("2")).toEqual(["1st floor", "2nd floor"]);
    expect(floorLevelLabelsFromStories("3")).toEqual(["1st floor", "2nd floor", "3rd floor"]);
    // Floors is a plain count now, so every floor is nameable — "4+ floors"
    // could not say which floor a room was on above the fourth.
    expect(floorLevelLabelsFromStories("4")).toEqual(["1st floor", "2nd floor", "3rd floor", "4th floor"]);
    expect(floorLevelLabelsFromStories("6")).toEqual([
      "1st floor",
      "2nd floor",
      "3rd floor",
      "4th floor",
      "5th floor",
      "6th floor",
    ]);
    // "split" is no longer OFFERED, but a listing that stored it keeps its levels.
    expect(floorLevelLabelsFromStories("split")).toEqual(["Lower level", "Upper level"]);
    // None of the removed values appears anywhere.
    for (const id of ["1", "2", "3", "4", "6", "split", undefined]) {
      const labels = floorLevelLabelsFromStories(id).join("|").toLowerCase();
      expect(labels).not.toMatch(/basement|garden|loft|attic|outdoor|custom/);
    }
  });

  it("never renders an empty dropdown when floors are not set — offers at least 1st floor", () => {
    expect(floorLevelLabelsFromStories(undefined)).toEqual(["1st floor"]);
    expect(floorLevelLabelsFromStories("")).toEqual(["1st floor"]);
  });

  it("keeps a legacy/out-of-range stored value in the option list so it still displays", () => {
    // An old listing stored "Basement / garden level" — preserved, not blanked.
    expect(floorLevelSelectOptions("2", "Basement / garden level")).toEqual([
      "1st floor",
      "2nd floor",
      "Basement / garden level",
    ]);
    // A value already in the derived list is not duplicated.
    expect(floorLevelSelectOptions("2", "1st floor")).toEqual(["1st floor", "2nd floor"]);
  });

  it("clamps a numbered floor that no longer exists to the highest floor, and reports the change", () => {
    // 3rd floor assigned, then Floors reduced to 2 → clamp to 2nd floor, changed.
    expect(clampFloorLabelToStories("3rd floor", "2")).toEqual({ floor: "2nd floor", changed: true });
    // Still in range → unchanged.
    expect(clampFloorLabelToStories("2nd floor", "2")).toEqual({ floor: "2nd floor", changed: false });
    // Legacy/non-numbered value is preserved untouched (never silently corrupted).
    expect(clampFloorLabelToStories("Basement / garden level", "2")).toEqual({
      floor: "Basement / garden level",
      changed: false,
    });
  });
});
