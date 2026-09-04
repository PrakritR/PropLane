/**
 * Week calendar day strip sits above the slot grid so sticky headers do not
 * collide with the first "Add" row or leave a blank band under the toolbar.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/portal/portal-calendar-panels.tsx", "utf8");

describe("compact calendar week day strip", () => {
  it("renders weekday headers in a dedicated sticky strip above the slot grid", () => {
    expect(src).toContain("CALENDAR_WEEK_DAY_STRIP");
    expect(src).toContain("day strip sits above slots");
    expect(src).not.toMatch(
      /grid-cols-\[64px_repeat\(7,minmax\(0,1fr\)\)\][\s\S]{0,1200}CALENDAR_STICKY_HEADER_CELL/,
    );
  });
});
