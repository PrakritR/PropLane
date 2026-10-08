/**
 * The floating Ask PropLane button is gone (the assistant is the side panel on
 * desktop and a sheet opened from the top bar on phones), so nothing reserves
 * scroll room for it any more.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("no assistant button clearance", () => {
  const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

  it("does not fold a floating-button clearance into the mobile scroll bottom inset", () => {
    expect(css).not.toContain("--portal-assistant-fab-clearance");
    expect(css).toMatch(
      /--portal-mobile-scroll-bottom-inset:\s*calc\(var\(--portal-native-bottom-nav-inset\)\s*\+\s*0\.75rem\)/,
    );
  });
});
