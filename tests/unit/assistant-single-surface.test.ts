/**
 * The assistant has ONE window: the side panel on desktop, a full-screen sheet
 * (opened from the top bar) on phones. No floating button, no pop-up, no
 * Pop-up/Docked preference. Captain, Oct 7: "remove the floating AI chat, no need
 * for that at all, just have it in the side bar and at top."
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const rel = `${dir}/${name}`;
    if (statSync(join(root, rel)).isDirectory()) return sourceFiles(rel);
    return /\.(tsx?|css)$/.test(name) ? [rel] : [];
  });
}

const PORTAL_LAYOUTS = [
  ["src/app/portal/layout.tsx", "/api/agent/chat"],
  ["src/app/vendor/layout.tsx", "/api/agent/vendor-chat"],
  ["src/app/admin/layout.tsx", "/api/agent/chat"],
  ["src/app/resident/layout.tsx", "/api/agent/resident-chat"],
] as const;

describe("no floating assistant", () => {
  it("nothing in src renders the assistant FAB or the pop-up panel", () => {
    // The general (marketing-site) assistant bubble is a different product surface and is exempt.
    const offenders = sourceFiles("src")
      .filter((file) => !file.startsWith("src/components/general/"))
      .filter((file) => /axis-assistant-fab|axis-assistant-panel|AxisAssistantFixedTrigger|axis-assistant-pin-to-dock/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("no portal layout or shell renders data-attr=axis-assistant-fab", () => {
    for (const [file] of PORTAL_LAYOUTS) expect(read(file), file).not.toContain("axis-assistant-fab");
    for (const file of [
      "src/components/portal/axis-assistant.tsx",
      "src/components/portal/portal-top-bar.tsx",
      "src/components/portal/portal-mobile-nav-bar.tsx",
      "src/components/portal/portal-assistant-rail.tsx",
    ]) {
      expect(read(file), file).not.toContain("axis-assistant-fab");
    }
  });

  it("the Pop-up/Docked preference and both Settings toggles are gone", () => {
    for (const file of [
      "src/lib/assistant-display-preferences.ts",
      "src/hooks/use-assistant-display-mode.ts",
      "src/components/portal/assistant-display-setting.tsx",
      "src/components/portal/assistant-display-mode-setting.tsx",
      "src/components/portal/portal-assistant-dock-rail.tsx",
    ]) {
      expect(existsSync(join(root, file)), file).toBe(false);
    }
    expect(read("src/components/portal/portal-profile-client.tsx")).not.toContain("AssistantDisplaySetting");
    expect(read("src/components/portal/axis-assistant.tsx")).not.toMatch(/dockable|useAxisAssistantDock/);
  });
});

describe("every portal has the side panel on its own endpoint", () => {
  it.each(PORTAL_LAYOUTS)("%s mounts <PortalAssistantRail> inside its role-scoped <AxisAssistant>", (file, endpoint) => {
    const layout = read(file);
    const open = layout.indexOf("<AxisAssistant");
    const close = layout.lastIndexOf("</AxisAssistant>");
    const rail = layout.indexOf("<PortalAssistantRail");
    expect(open, file).toBeGreaterThan(-1);
    expect(rail, file).toBeGreaterThan(open);
    expect(rail, file).toBeLessThan(close);
    // The panel hides itself while closed and remembers its state per device.
    expect(layout.slice(rail, layout.indexOf("/>", rail))).toContain("initialCollapsed=");
    if (endpoint !== "/api/agent/chat") {
      // Vendor and resident name their endpoint on both the provider and the panel.
      expect(layout.split(`endpoint="${endpoint}"`).length - 1, file).toBe(2);
    }
  });

  it("the resident layout reaches only the resident endpoint, never the manager or vendor registry", () => {
    const layout = read("src/app/resident/layout.tsx");
    expect(layout).toContain('endpoint="/api/agent/resident-chat"');
    expect(layout).not.toContain("/api/agent/chat");
    expect(layout).not.toContain("/api/agent/vendor-chat");
    for (const tag of layout.match(/<(AxisAssistant|PortalAssistantRail)\b[^>]*>/g) ?? []) {
      expect(tag).toContain("endpoint=");
    }
  });
});

describe("one launcher, no pop-up branch", () => {
  it("openAxisAssistant opens the side panel on desktop and the sheet below lg", () => {
    const store = read("src/lib/axis-assistant/open-store.ts");
    expect(store).toContain("expandAssistantDock()");
    expect(store).toContain("setAxisAssistantOpen(true)");
    const launcher = read("src/components/portal/use-assistant-launcher.ts");
    expect(launcher).not.toMatch(/dockable|useAxisAssistantDock|mode === "docked"/);
  });

  it("phones reach the sheet from a top-bar button, desktop from the top strip", () => {
    expect(read("src/components/portal/portal-mobile-nav-bar.tsx")).toContain('data-attr="portal-mobile-assistant"');
    expect(read("src/components/portal/portal-top-bar.tsx")).toContain('data-attr="portal-assistant-panel"');
  });
});
