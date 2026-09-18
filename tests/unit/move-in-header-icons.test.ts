import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/portal/pro-property-room-move-in-panel.tsx", "utf8");
const house = readFileSync("src/components/portal/house-info-sections.tsx", "utf8");

describe("Move-in house card uses header icons", () => {
  it("Copy and Share are PortalIconAction on the expandable header", () => {
    expect(panel).toContain("PortalIconAction");
    expect(panel).toContain('label="Copy to rooms"');
    expect(panel).toContain('label="Share"');
    expect(panel).toContain("actions={");
    expect(panel).not.toMatch(/>\s*Copy to rooms\s*</);
    expect(panel).not.toMatch(/>\s*Share\s*</);
  });

  it("the expandable summary accepts an actions slot", () => {
    expect(house).toContain("actions?: ReactNode");
    expect(house).toContain("event.preventDefault()");
  });
});
