/**
 * AXI-136 — "for rooms when choosing furnsihing options there should be an other
 * option and you select the checkbox and then can write in other checkbox."
 *
 * Room amenities already worked this way via PresetCheckboxGroup's own "Other"
 * toggle. Furnishing did not: it showed a permanently-visible "Other furnishing
 * notes" input with no checkbox, so it read as a stray field rather than as one
 * more furnishing choice.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "src/components/portal/pro-add-listing-form.tsx"),
  "utf8",
);

describe("room furnishing has an Other write-in", () => {
  it("adds an Other checkbox beside the furniture presets", () => {
    expect(source).toContain("otherFurnishingOpenRooms");
    expect(source).toContain("listing-room-furnishing-other-");
  });

  it("treats an existing note as open, so a saved value is never hidden", () => {
    const block = source.split("const otherOn =")[1]?.slice(0, 200) ?? "";
    expect(block).toContain("otherFurnishingOpenRooms.has(room.id)");
    expect(block).toContain('room.detail.trim() !== ""');
  });

  it("clears the note when Other is unticked", () => {
    // Otherwise `detail` keeps the value, `otherOn` recomputes true, and the box
    // ticks itself straight back on.
    const block = source.split("listing-room-furnishing-other-")[1]?.slice(0, 600) ?? "";
    expect(block).toContain("setRoom(i, { detail: \"\" })");
  });

  it("only shows the input while Other is ticked", () => {
    const block = source.split("listing-room-furnishing-other-")[1]?.slice(0, 1200) ?? "";
    expect(block).toContain("otherOn ? (");
    expect(block).toContain("Other furnishing, comma-separated");
  });

  it("mirrors the amenities toggle rather than inventing a second pattern", () => {
    expect(source).toContain("otherAmenitiesOpenRooms");
    expect(source).toContain("toggleOtherFurnishingOpen");
  });
});
