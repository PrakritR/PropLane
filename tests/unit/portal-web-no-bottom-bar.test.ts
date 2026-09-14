/**
 * Nothing is pinned to the bottom of the WEB, on any viewport.
 *
 * A phone-width browser used to get the native app's fixed tab bar plus the
 * content clearance reserved for it and for the Ask PropLane button — the
 * bottom ~140px of every portal page, on every tab of every portal — and the
 * section chip strip that is the web's own phone navigation was hidden to make
 * room for it. The captain wants no bar anywhere on the website (14 Sep). The
 * native app keeps its tab bar; these read the source so the bar cannot creep
 * back onto the web through either the component or the stylesheet.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
const sidebar = readFileSync(join(process.cwd(), "src/components/portal/portal-sidebar.tsx"), "utf8");

describe("the fixed bottom tab bar is native-only", () => {
  it("the sidebar renders the bar under the native chrome, never for a small viewport", () => {
    expect(sidebar).toMatch(/const showMobileNav = showNativeChrome;/);
    expect(sidebar).not.toContain("useIsSmallPortalViewport");
  });

  it("the web zeroes the bar inset and the Ask PropLane clearance", () => {
    expect(css).toMatch(
      /html:not\(\[data-native\]\)\s*\{[^}]*--portal-native-bottom-nav-inset:\s*0px;[^}]*--portal-assistant-fab-clearance:\s*0px;/,
    );
  });

  it("the web never hides the section chip strip that is the phone's navigation", () => {
    // Only the native app may hide `.portal-mobile-chrome` (it has the bar instead).
    const hides = [...css.matchAll(/([^{}]*)\.portal-mobile-chrome[^{]*\{[^}]*display:\s*none/g)];
    for (const match of hides) {
      expect(match[0]).toContain("html[data-native]");
    }
  });
});
