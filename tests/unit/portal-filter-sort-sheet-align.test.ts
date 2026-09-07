/**
 * Manager filter dropdowns default to start-align so the panel does not cover the sidebar.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sheet = readFileSync("src/components/portal/portal-filter-sort-sheet.tsx", "utf8");

describe("portal filter sort sheet dropdown alignment", () => {
  it("start-aligns the desktop filter panel by default", () => {
    expect(sheet).toContain('dropdownAlign = "start"');
    expect(sheet).not.toContain('dropdownAlign = "end"');
  });
});
