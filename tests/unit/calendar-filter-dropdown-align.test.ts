/**
 * Calendar filter sits in the command strip — dropdown left edge aligns to the trigger.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const calendar = readFileSync("src/components/portal/portal-calendar.tsx", "utf8");

describe("calendar filter dropdown alignment", () => {
  it("start-aligns the desktop filter panel to the Filter button", () => {
    expect(calendar).toContain('dropdownAlign="start"');
    expect(calendar).not.toContain("constrainDropdownToTitleBand={false}");
  });
});
