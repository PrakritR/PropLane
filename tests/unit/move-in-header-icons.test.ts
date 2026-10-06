import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/portal/pro-property-room-move-in-panel.tsx", "utf8");
const settings = readFileSync("src/components/portal/property-move-in-settings.tsx", "utf8");
const house = readFileSync("src/components/portal/house-info-sections.tsx", "utf8");

describe("House details Copy/Share are header icons", () => {
  it("does not render labeled Copy to rooms / Share buttons", () => {
    expect(panel).not.toMatch(/>\s*Copy to rooms\s*</);
    expect(panel).not.toMatch(/>\s*Share\s*</);
    expect(settings).toContain("PortalIconAction");
  });

  it("uses the house-header actions slot so icon clicks do not toggle", () => {
    expect(house).toMatch(/actions\?: ReactNode/);
    expect(house).toContain("event.preventDefault()");
    expect(panel).toMatch(/title="The whole house"/);
    expect(panel).toMatch(/actions=\{/);
  });

  /**
   * Studio (captain, Oct 3): the Move-in header card holds only the Settings gear
   * and the round +; the house-wide Copy and Share live in the whole-house row's ⋯.
   */
  it("the header holds only the gear; Copy / Share sit in the whole-house row ⋯", () => {
    expect(settings).toContain('data-attr="property-move-in-settings-open"');
    expect(panel).toContain("actions={settings.gear}");
    expect(panel).toContain('dataAttr: "property-move-in-copy"');
    expect(panel).toContain('dataAttr: "property-move-in-share"');
    expect(panel).not.toMatch(/icon=\{Copy\}|icon=\{Share2\}/);
    expect(panel).not.toContain("<PortalPropertySectionToolbar");
  });
});
