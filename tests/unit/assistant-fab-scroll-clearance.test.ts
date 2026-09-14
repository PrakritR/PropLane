/**
 * PRP-377: main portal scroll must reserve FAB clearance so Needs-attention
 * actions are not covered by Ask PropLane.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("assistant FAB scroll clearance (PRP-377)", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("folds --portal-assistant-fab-clearance into the mobile scroll bottom inset", () => {
    expect(css).toMatch(/--portal-assistant-fab-clearance:\s*3\.75rem/);
    expect(css).toMatch(
      /--portal-mobile-scroll-bottom-inset:\s*calc\(\s*var\(--portal-native-bottom-nav-inset\)\s*\+\s*0\.75rem\s*\+\s*var\(--portal-assistant-fab-clearance\)/,
    );
  });

  /**
   * The desktop half of PRP-377 is deliberately gone. Padding #portal-main-content
   * only helps a page that scrolls in main; almost every portal tab is a clipped
   * fixed-height surface with its own inner scroller, where that padding could
   * never scroll away and was an 80px band of dead canvas under the cards on
   * every tab of every portal (captain, 14 Sep). A rule that pads
   * #portal-main-content by the FAB clearance must not come back.
   */
  it("never pads desktop #portal-main-content for the FAB", () => {
    const desktop = css.slice(css.indexOf("@media (min-width: 1024px)"));
    const padsMain =
      /#portal-main-content\s*\{[^}]*padding-bottom:\s*calc\(var\(--portal-assistant-fab-clearance\)/;
    expect(desktop).not.toMatch(padsMain);
    expect(css).not.toMatch(padsMain);
  });
});
