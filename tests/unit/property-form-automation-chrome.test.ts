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

  it("Settings hub Applications and Leases jump to the listing Form instead of embedding the editor", () => {
    const hub = src("src/components/portal/portal-profile-client.tsx");
    expect(hub).not.toContain("FormAutomationPaneSwitch");
    expect(hub).not.toContain("ManagerPropertyApplicationFormEditor");
    expect(hub).not.toContain("ManagerPropertyLeaseFormEditor");
    expect(hub).toContain("showFormLink");
    expect(hub).toContain("<SettingsModulePage tab={tab}");
  });
});
