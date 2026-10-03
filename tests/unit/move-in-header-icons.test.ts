import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/portal/pro-property-room-move-in-panel.tsx", "utf8");
const house = readFileSync("src/components/portal/house-info-sections.tsx", "utf8");

describe("House details Copy/Share are header icons", () => {
  it("does not render labeled Copy to rooms / Share buttons", () => {
    expect(panel).not.toMatch(/>\s*Copy to rooms\s*</);
    expect(panel).not.toMatch(/>\s*Share\s*</);
    expect(panel).toContain("PortalIconAction");
    expect(panel).toMatch(/icon=\{Copy\}/);
    expect(panel).toMatch(/icon=\{Share2\}/);
  });

  it("uses the house-header actions slot so icon clicks do not toggle", () => {
    expect(house).toMatch(/actions\?: ReactNode/);
    expect(house).toContain("event.preventDefault()");
    expect(panel).toMatch(/title="The whole house"/);
    expect(panel).toMatch(/actions=\{/);
  });

  /**
   * studio-redesign(property-tabs): the per-room-row Copy/Share pair went away
   * with the inline room cards; Copy and Share are now header-card icons beside
   * the Settings gear, in the same single command bar as the tabs and search.
   */
  it("Copy / Share / Settings sit in the one header card, never in a floating row", () => {
    expect(panel).toContain('data-attr="property-move-in-copy"');
    expect(panel).toContain('data-attr="property-move-in-share"');
    expect(panel).toContain('data-attr="property-move-in-settings-open"');
    expect(panel).not.toMatch(/>\s*Copy\s*</);
    expect(panel).not.toContain("<PortalPropertySectionToolbar");
    expect(panel).not.toContain("justify-end gap-1 px-0.5");
    expect(panel).toMatch(/<PortalListControlStack[\s\S]*?actions=\{[\s\S]*?icon=\{Copy\}[\s\S]*?icon=\{Share2\}[\s\S]*?icon=\{Settings\}/);
  });
});
