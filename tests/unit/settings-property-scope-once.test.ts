import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panels = readFileSync("src/components/portal/pro-portal-settings-panels.tsx", "utf8");
const scope = readFileSync("src/components/portal/settings-property-scope.tsx", "utf8");
const hub = readFileSync("src/components/portal/portal-profile-client.tsx", "utf8");
const section = readFileSync("src/components/portal/portal-settings-section-client.tsx", "utf8");
const modal = readFileSync("src/components/portal/pro-portal-settings-modal.tsx", "utf8");

describe("Settings keeps one property picker in the module title", () => {
  it("does not export a per-section Echo picker", () => {
    expect(scope).not.toContain("SettingsPropertyScopeEcho");
    expect(scope).not.toContain("settings-property-scope-echo");
    expect(scope).toContain("SettingsPropertyScopeTitleRow");
    expect(scope).not.toContain("sticky top-0");
  });

  it("section headers do not repeat the property control or No properties selected", () => {
    expect(panels).not.toContain("SettingsPropertyScopeEcho");
    expect(panels).not.toContain("No properties selected");
    expect(panels).not.toContain("propertyScopeTagLabel");
  });

  it("hub, section route, and modal still mount the one picker", () => {
    expect(hub).toContain("SettingsPropertyScopeTitleRow");
    expect(hub).toContain('"messaging"');
    expect(section).toContain("SettingsPropertyScopeBar");
    expect(section).toContain("SettingsPropertyScopeProvider");
    expect(modal).toContain("SettingsPropertyScopeBar");
    expect(modal).toContain("SettingsPropertyScopeProvider");
  });
});
