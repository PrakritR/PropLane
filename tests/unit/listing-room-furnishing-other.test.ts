/**
 * AXI-136 — "for rooms when choosing furnsihing options there should be an other
 * option and you select the checkbox and then can write in other checkbox."
 *
 * PRP-463 moved that Other from a checkbox beside the list to an OPTION inside the one
 * multi-select, with the write-in beside the field — and room amenities, bathroom
 * amenities and shared-space amenities all went through the same component. What has to
 * keep holding is unchanged: there is an Other, a value already saved counts as open, and
 * unticking clears it so the box cannot re-open itself from a value the menu says is off.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  path.join(process.cwd(), "src/components/portal/pro-add-listing-form.tsx"),
  "utf8",
);

describe("room furnishing has an Other write-in", () => {
  it("offers Other inside the furnishing dropdown", () => {
    expect(source).toContain('const PRESET_OTHER_VALUE = "__other__";');
    expect(source).toContain('{ value: PRESET_OTHER_VALUE, label: "Other" }');
    // Furnishing is one of the lists that uses it.
    expect(source).toContain('dataAttr="listing-room-furnishing"');
  });

  it("treats an existing note as open, so a saved value is never hidden", () => {
    expect(source).toContain("const open = otherOpen || custom.length > 0;");
    expect(source).toContain("selected={open ? [...checked, PRESET_OTHER_VALUE] : checked}");
  });

  it("clears the write-in when Other is unticked", () => {
    // Otherwise the value survives, `open` recomputes true, and the option ticks itself
    // straight back on.
    expect(source).toContain('if (!wantsOther) setDraft("");');
    expect(source).toContain("write(picks, wantsOther ? custom : []);");
  });

  it("only shows the input while Other is ticked", () => {
    const block = source.split("const PRESET_OTHER_VALUE")[1]?.slice(0, 3600) ?? "";
    expect(block).toContain("{open ? (");
    expect(block).toContain("placeholder={otherPlaceholder}");
  });

  it("is the one component every preset list uses, not a second pattern", () => {
    for (const attr of [
      'dataAttr="listing-room-furnishing"',
      'dataAttr="listing-room-amenities"',
      'dataAttr="listing-bathroom-amenities"',
      'dataAttr="listing-shared-space-amenities"',
    ]) {
      expect(source).toContain(attr);
    }
    expect(source).toContain("function PresetMultiSelectField(");
  });
});
