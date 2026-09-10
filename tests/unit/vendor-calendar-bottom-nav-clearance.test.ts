/**
 * PRP-371: nested calendar slot grid must clear the fixed bottom nav via the
 * shared --portal-mobile-scroll-bottom-inset knob (not a per-panel bottom).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("vendor calendar bottom-nav clearance (PRP-371)", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("pads nested (non-flowScroll) calendar compact body with the shared mobile inset", () => {
    expect(css).toMatch(
      /\.portal-calendar-compact:not\(\.portal-calendar-flow-scroll\)[^{]*\.portal-calendar-compact-body/,
    );
    expect(css).toMatch(
      /portal-calendar-compact:not\(\.portal-calendar-flow-scroll\)[\s\S]*?padding-bottom:\s*var\(--portal-mobile-scroll-bottom-inset\)/,
    );
    expect(css).toMatch(
      /portal-calendar-compact:not\(\.portal-calendar-flow-scroll\)[\s\S]*?scroll-padding-bottom:\s*var\(--portal-mobile-scroll-bottom-inset\)/,
    );
  });

  /**
   * That inset clears page chrome (phone nav + assistant FAB). A calendar inside
   * a modal scrolls in its own panel above both, where the padding was only dead
   * space below the last hour — the tour-availability grid kept scrolling into it.
   */
  it("skips the inset for a calendar embedded in a modal", () => {
    expect(css).toMatch(
      /\.portal-calendar-compact:not\(\.portal-calendar-flow-scroll\):not\(\.portal-calendar-in-modal\)/,
    );
  });
});
