import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/portal/pro-properties.tsx", "utf8");

describe("Properties settings gear", () => {
  it("opens Property settings, not Applications", () => {
    expect(src).toContain('getSettingsEntryPoint("properties")');
    expect(src).not.toContain('getSettingsEntryPoint("applications")');
    expect(src).toContain('initialTab="properties"');
    expect(src).not.toMatch(/initialTab=["']applications["']/);
  });

  it("uses the properties data-attr, not a leftover applications gear", () => {
    expect(src).toContain("propertiesSettingsEntry");
    expect(src).toContain("settingsDialogTitlePrefix(propertiesSettingsEntry)");
  });

  it("opens Create through CreateWorkspace only — no leftover add-listing form", () => {
    expect(src).toContain("CreateWorkspace");
    expect(src).not.toContain("ManagerAddListingForm");
    expect(src).not.toContain("wizard=v1");
    expect(src).toContain('get("wizard") === "v2"');
  });
});
