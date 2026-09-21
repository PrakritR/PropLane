import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scope = readFileSync("src/components/portal/settings-property-scope.tsx", "utf8");
const panels = readFileSync("src/components/portal/pro-portal-settings-panels.tsx", "utf8");
const hub = readFileSync("src/components/portal/portal-profile-client.tsx", "utf8");
const modal = readFileSync("src/components/portal/pro-portal-settings-modal.tsx", "utf8");

describe("Settings property scope appears once", () => {
  it("deletes SettingsPropertyScopeEcho", () => {
    expect(scope).not.toMatch(/export function SettingsPropertyScopeEcho/);
    expect(scope).not.toContain("settings-property-scope-echo");
    expect(panels).not.toContain("SettingsPropertyScopeEcho");
  });

  it("does not repeat the property PICKER on section titles — an informational scope tag is not the picker", () => {
    expect(panels).not.toContain("No properties selected");
    // PLAN-0920-0845 phase D: a group's own read-only source tag
    // (`SettingsGroupSourceTag` / `PortalSettingsScopeTag`) is allowed on a
    // section title now — it states what that group already resolved to, it
    // never lets a manager change scope from there. The picker itself
    // (`SettingsScopeBar`/`SettingsPropertyScopePicker`) must still never
    // appear per section — only once, in module chrome.
    expect(panels).not.toMatch(/<PortalSettingsSection[^>]*action=\{<SettingsScopeBar/);
    expect(panels).not.toMatch(/<PortalSettingsSection[^>]*action=\{<SettingsPropertyScopePicker/);
  });

  it("mounts the one picker in module chrome, not a sticky card", () => {
    expect(scope).not.toContain("sticky top-0");
    expect(hub).toContain("SettingsScopeBar");
    expect(modal).toContain("SettingsScopeBar");
  });
});
