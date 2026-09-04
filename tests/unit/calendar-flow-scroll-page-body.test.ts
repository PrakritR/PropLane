/**
 * Manager calendar week grid scrolls with the page (flowScroll). The page body
 * must not cap height to the viewport or the last time slots sit under the
 * pinned availability footer with no way to scroll further.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync("src/app/globals.css", "utf8");

describe("calendar flow-scroll page body", () => {
  it("lets portal-calendar-page-body grow when flow-scroll grid is present", () => {
    expect(globals).toMatch(
      /\.portal-calendar-page-body:has\(\.portal-calendar-flow-scroll\)[\s\S]*flex:\s*none/,
    );
    expect(globals).toMatch(
      /\.portal-calendar-page-body:has\(\.portal-calendar-flow-scroll\)[\s\S]*min-height:\s*auto/,
    );
    expect(globals).toMatch(
      /\.portal-calendar-page-body:has\(\.portal-calendar-flow-scroll\)\s*>\s*\*[\s\S]*flex:\s*none/,
    );
  });
});
