import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve("src/components/portal/pro-vendors-panel.tsx"), "utf8");
const settings = readFileSync(resolve("src/components/portal/portal-profile-client.tsx"), "utf8");

describe("vendor adding is not in Settings", () => {
  it("omits the Add vendor primary when the panel is bare (Settings)", () => {
    expect(src).toContain("primary={bare ? undefined : addVendorAction}");
    expect(src).toContain("settings-vendors-empty-open");
    expect(src).toContain("vendors-empty-add");
  });

  it("points Settings Vendors at the operations list instead of an in-place add", () => {
    expect(settings).toContain("settings-vendors-open-section");
    expect(settings).toContain('href="/portal/vendors"');
  });
});
