import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/portal/pro-properties.tsx", "utf8");

describe("Properties settings gear", () => {
  it("does not open a Properties settings module — house rules live on the listing", () => {
    expect(src).not.toContain('getSettingsEntryPoint("properties")');
    expect(src).not.toContain("propertiesSettingsEntry");
    expect(src).not.toContain('initialTab="properties"');
  });

  it("opens Create through CreateWorkspace only — no leftover add-listing form", () => {
    expect(src).toContain("CreateWorkspace");
    expect(src).not.toContain("ManagerAddListingForm");
    expect(src).not.toContain("wizard=v1");
    expect(src).toContain('get("wizard") === "v2"');
  });
});
