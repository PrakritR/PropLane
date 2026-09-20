import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldMountTourSettings } from "@/lib/portal-settings-module-visibility";

const SRC = readFileSync(
  join(process.cwd(), "src/components/portal/pro-portal-settings-modal.tsx"),
  "utf8",
);
// Panel rendering (and the mount gate this first test checks) moved out of the modal into
// `SettingsModulePage` — the one component both the dialog and the standalone
// `/portal/settings/<tab>` page render. Its `active` prop is the same guard the modal used to
// apply itself under the name `open`; the modal now just forwards its own `open` state into it
// (`active={open}` in pro-portal-settings-modal.tsx) rather than gating each tab inline.
const PAGE_SRC = readFileSync(
  join(process.cwd(), "src/components/portal/settings-module-page.tsx"),
  "utf8",
);

describe("ManagerPortalSettingsModal mount gating", () => {
  it("mounts self-loading panels only while the module page is active", () => {
    expect(PAGE_SRC).toMatch(/shouldMountTourSettings\(active, tab\)/);
    expect(PAGE_SRC).toMatch(/\{active && tab === "payments" \?/);
    expect(PAGE_SRC).toMatch(/\{active && tab === "communication" \?/);
    expect(PAGE_SRC).toMatch(/\{active && tab === "automation" \?/);
    expect(PAGE_SRC).toMatch(/\{active && tab === "tasks" \?/);
    // The modal no longer decides this itself — it just forwards `open` straight through.
    expect(SRC).toMatch(/active=\{open\}/);
  });

  it("keeps tour settings unmounted while inactive", () => {
    expect(shouldMountTourSettings(false, "tours")).toBe(false);
    expect(shouldMountTourSettings(true, "tours")).toBe(true);
    expect(shouldMountTourSettings(true, "applications")).toBe(false);
  });

  it("pins Save in Modal footer so tall tab bodies scroll (PRP-334)", () => {
    expect(SRC).toMatch(/footer=\{/);
    expect(SRC).toMatch(/<ModalFooter>/);
    expect(SRC).not.toMatch(/scrollableContent=\{!inlineFooter\}/);
    expect(SRC).not.toMatch(/border-t border-border pt-3[\s\S]*SettingsPanelModalSaveButton/);
  });
});
