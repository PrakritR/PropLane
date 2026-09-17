import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function src(rel: string) {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Application / Lease Bookings chrome", () => {
  it("property pages use the Form | Automation command bar and drop the footer Settings word", () => {
    const application = src("src/components/portal/pro-property-application-questions-panel.tsx");
    const lease = src("src/components/portal/pro-property-lease-panel.tsx");

    for (const file of [application, lease]) {
      expect(file).toContain("PropertyFormAutomationCommandBar");
      expect(file).toContain("SettingsModulePage");
      expect(file).toContain('initialPane="automation"');
      expect(file).not.toContain("PropertyDetailFooterActions");
      expect(file).not.toMatch(/>\s*Settings\s*</);
    }

    expect(application).toContain('settingsDataAttr="property-application-settings-open"');
    expect(lease).toContain('settingsDataAttr="property-lease-settings-open"');
  });

  it("Settings hub Applications and Leases keep Form | Automation plus the full automation sections", () => {
    const hub = src("src/components/portal/portal-profile-client.tsx");
    expect(hub).toContain("FormAutomationPaneSwitch");
    expect(hub).toContain("ManagerPropertyApplicationFormEditor");
    expect(hub).toContain("ManagerPropertyLeaseFormEditor");
    expect(hub).toContain('data-attr={formAutomation ? "settings-hub-form-automation"');
    expect(hub).toContain('<SettingsModulePage tab={tab}');
  });
});
