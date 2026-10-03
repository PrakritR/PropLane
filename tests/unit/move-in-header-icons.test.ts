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

  it("room rows keep Copy/Share, as items in the row's one ⋯ menu (C2-TAB2, ui-page-structure.md)", () => {
    // Rows carry exactly one ⋯ (Edit first), so a room's Copy and Share live in it rather than as
    // second per-row icon buttons.
    expect(panel).toContain('label: "Copy move-in info"');
    expect(panel).toContain('label: "Share move-in link"');
    expect(panel).toContain("roomMoveInClipboardText");
    expect(panel).toContain("roomMoveInShareUrl");
    expect(panel).not.toMatch(/>\s*Copy\s*</);
    expect(panel.indexOf('id: "edit"')).toBeLessThan(panel.indexOf('id: "preview"'));
  });
});
