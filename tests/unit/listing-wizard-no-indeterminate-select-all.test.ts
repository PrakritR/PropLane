/**
 * The create-listing wizard's "Select all" boxes never paint the dashed
 * indeterminate state.
 *
 * Manager QA reported it twice on the same day — once on Building &
 * neighborhood amenities, once on Room amenities. Ticking a single amenity
 * turned "Select all" into a dash, which reads as "something is wrong with my
 * selection" rather than "some are selected". The partial state is already
 * legible from the item boxes themselves.
 *
 * This asserts the GUARANTEE (the wizard paints no indeterminate checkbox), not
 * a line number, so it survives the boxes moving. Other surfaces — household
 * screening, document download, bulk message — still use the dash deliberately
 * and are out of scope here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WIZARD = path.join(process.cwd(), "src/components/portal/pro-add-listing-form.tsx");

describe("create-listing wizard select-all", () => {
  it("never assigns indeterminate to a checkbox", () => {
    const source = readFileSync(WIZARD, "utf8");
    const assignments = source
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter((row) => /\.indeterminate\s*=/.test(row.line));
    expect(
      assignments,
      `the wizard must not paint a dashed select-all: ${assignments.map((a) => `line ${a.n}`).join(", ")}`,
    ).toEqual([]);
  });

  it("still announces a partial selection, through the multi-select", () => {
    // Removing the dash was a VISUAL decision, and PRP-463 then replaced every one of
    // these select-all grids with `CheckboxMultiSelect`. A partial selection must still be
    // announced or the change trades a cosmetic complaint for a real a11y loss — that now
    // comes from the listbox's per-option `aria-selected`, which is asserted where the
    // component lives.
    const source = readFileSync(WIZARD, "utf8");
    expect(source).toContain("CheckboxMultiSelect");
    expect(source).not.toContain("SelectAllCheckbox");

    const component = readFileSync(
      path.join(process.cwd(), "src/components/ui/checkbox-multi-select.tsx"),
      "utf8",
    );
    expect(component).toContain('aria-multiselectable="true"');
    expect(component).toContain("aria-selected={checked}");
  });
});
