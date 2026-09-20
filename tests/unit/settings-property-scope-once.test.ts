import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scope = readFileSync("src/components/portal/settings-property-scope.tsx", "utf8");
const panels = readFileSync("src/components/portal/pro-portal-settings-panels.tsx", "utf8");
const hub = readFileSync("src/components/portal/portal-profile-client.tsx", "utf8");
const standalone = readFileSync("src/components/portal/portal-settings-section-client.tsx", "utf8");
const modal = readFileSync("src/components/portal/pro-portal-settings-modal.tsx", "utf8");

describe("Settings property scope appears once", () => {
  it("deletes SettingsPropertyScopeEcho", () => {
    expect(scope).not.toMatch(/export function SettingsPropertyScopeEcho/);
    expect(scope).not.toContain("settings-property-scope-echo");
    expect(panels).not.toContain("SettingsPropertyScopeEcho");
  });

  it("does not pass a property action on section titles", () => {
    expect(panels).not.toContain("No properties selected");
    expect(panels).not.toMatch(/<PortalSettingsSection[^>]*action=\{/);
    expect(panels).not.toMatch(/action=\{<PortalSettingsScopeTag/);
    expect(panels).not.toMatch(/action=\{<SettingsPropertyScope/);
  });

  it("mounts the one picker in module chrome, not a sticky card", () => {
    expect(scope).not.toContain("sticky top-0");
    expect(hub).toContain("SettingsPropertyScopeBar");
    expect(standalone).toContain("SettingsPropertyScopeBar");
    expect(modal).toContain("SettingsPropertyScopeBar");
    expect(standalone).toMatch(/action=\{\s*<div className="flex items-center gap-2">/);
  });
});
