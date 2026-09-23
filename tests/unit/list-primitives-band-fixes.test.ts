/**
 * Source-grep guards for the small, scattered chrome fixes in PLAN-0920-1058
 * area 1d: the messaging setup banner is a text link (never a pill) and never
 * truncates its message, the phone "More" sheet nests a section's sub-tabs
 * under it instead of flattening them, and the assistant's desktop side
 * panel gets a real ✕ close independent of its collapse-to-strip control.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PORTAL_DIR = join(process.cwd(), "src/components/portal");
const source = (file: string) => readFileSync(join(PORTAL_DIR, file), "utf8");

describe("manager messaging setup banner", () => {
  const banner = source("messaging-setup-banner.tsx");

  it("is a text link, not a bordered pill button", () => {
    expect(banner).not.toMatch(/Set up messaging[\s\S]{0,20}rounded-full border/);
    expect(banner).toMatch(/underline/);
  });

  it("never truncates the message on a phone", () => {
    const messageLine = banner.split("\n").find((line) => line.includes("Phone number not set up"));
    expect(messageLine).toBeDefined();
    expect(messageLine).not.toContain("truncate");
  });
});

describe("phone More sheet nests a section's sub-tabs", () => {
  it("PortalMoreNavItem declares subItems instead of only a flat row", () => {
    expect(source("portal-native-more-sheet.tsx")).toMatch(/subItems\?:\s*PortalMoreNavItem\[\]/);
  });

  it("renders sub-items nested under their own section, not flattened to the top level", () => {
    const sheetSource = source("portal-native-more-sheet.tsx");
    expect(sheetSource).toMatch(/item\.subItems\.map\(\(sub\)/);
  });

  it("the sidebar hands the sheet nested subItems instead of flat-mapping them away", () => {
    const sidebarSource = source("portal-sidebar.tsx");
    // The old bug: `.flatMap` turned "Payments" + its Incoming/Outgoing
    // sub-tabs into three independent top-level rows.
    expect(sidebarSource).not.toMatch(/moreSheetItems[\s\S]{0,400}\.flatMap\(/);
  });
});

describe("assistant desktop side panel gets a real close", () => {
  it("AssistantDockPanel passes its ✕ straight to the header", () => {
    const dockPanelSource = source("assistant-dock-panel.tsx");
    expect(dockPanelSource).toMatch(/onClose\?:\s*\(\)\s*=>\s*void/);
    expect(dockPanelSource).toMatch(/onClose=\{onClose\}/);
  });

  it("both desktop rails close themselves instead of jumping to the popup", () => {
    for (const file of ["portal-assistant-rail.tsx", "portal-assistant-dock-rail.tsx"]) {
      const railSource = source(file);
      expect(railSource, file).toMatch(/onClose=\{closeRail\}/);
      expect(railSource, file).toMatch(/focusAskPropLane\(\)/);
      expect(railSource, file).not.toMatch(/openAxisAssistant/);
    }
    // The manager rail keeps its docked preference (Settings owns the switch)...
    expect(source("portal-assistant-dock-rail.tsx")).toMatch(/collapseAssistantDock\(\);/);
    // ...admin/vendor have no Settings toggle, so their ✕ leaves rail mode.
    expect(source("portal-assistant-rail.tsx")).toMatch(/undockAssistantFromRail\(\);/);
  });
});
