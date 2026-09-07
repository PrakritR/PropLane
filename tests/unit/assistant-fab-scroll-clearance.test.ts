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

  it("pads desktop #portal-main-content when the FAB is visible", () => {
    expect(css).toMatch(
      /min-width:\s*1024px[\s\S]*#portal-main-content[\s\S]*portal-assistant-fab-clearance/,
    );
  });
});
