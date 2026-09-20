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
});
