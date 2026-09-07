/**
 * PRP-383: screening test-mode toggle must live in the header actions, not a
 * fixed left-4 pill under the sidebar (Finances link stole clicks).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("screening test-mode toggle placement (PRP-383)", () => {
  const bg = readFileSync(join(process.cwd(), "src/components/portal/pro-background-checks.tsx"), "utf8");
  const screenings = readFileSync(join(process.cwd(), "src/components/portal/pro-screenings.tsx"), "utf8");
  const toggle = readFileSync(
    join(process.cwd(), "src/components/portal/screening-test-mode-toggle.tsx"),
    "utf8",
  );

  it("keeps the shared control out of a fixed left-4 overlay", () => {
    expect(toggle).toContain('data-attr="screening-test-mode-toggle"');
    expect(toggle).not.toMatch(/fixed[^"]*left-4/);
  });

  it("uses ScreeningTestModeToggle in Background checks and Screenings headers", () => {
    expect(bg).toContain("ScreeningTestModeToggle");
    expect(screenings).toContain("ScreeningTestModeToggle");
    expect(bg).not.toMatch(/fixed[^;]*screening-test-mode-toggle/);
    expect(screenings).not.toMatch(/fixed[^;]*screening-test-mode-toggle/);
  });
});
