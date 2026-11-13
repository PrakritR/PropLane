import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("src/components/portal/pro-property-room-move-in-panel.tsx", "utf8");
const sections = readFileSync("src/components/portal/house-info-sections.tsx", "utf8");
const card = panel.slice(panel.indexOf("function InternalHouseCard"), panel.indexOf("export function ManagerPropertyRoomMoveInPanel"));

describe("staff-only Internal card uses the standard section card", () => {
  it("has no amber/yellow styling or monospace values", () => {
    expect(card).not.toMatch(/amber|yellow|font-mono/);
    expect(card).toContain("bg-card");
    expect(card).toContain("text-foreground");
    expect(card).toContain("Lock");
    expect(card).toContain("PortalIconAction");
  });
  it("the editor marks staff-only with a lock, not an amber pill", () => {
    expect(sections).not.toMatch(/amber/);
    expect(sections).toContain("Lock");
  });
});
