import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function src(rel: string) {
  return readFileSync(join(ROOT, rel), "utf8");
}

describe("Application / Lease Bookings chrome", () => {
  it("property pages use the Form command bar and no longer carry their own automation pane (C228)", () => {
    const application = src("src/components/portal/pro-property-application-questions-panel.tsx");
    const lease = src("src/components/portal/pro-property-lease-panel.tsx");

    for (const file of [application, lease]) {
      expect(file).toContain("PropertyFormAutomationCommandBar");
      // C228: automation moved onto the form itself (Settings -> Forms) — the
      // property page no longer mounts an inline SettingsModulePage pane for it.
      expect(file).not.toContain("SettingsModulePage");
      expect(file).not.toContain('initialPane="automation"');
      expect(file).not.toContain("ProPortalSettingsModal");
      expect(file).not.toContain("PropertyDetailFooterActions");
      expect(file).not.toMatch(/>\s*Settings\s*</);
    }

    // e04eadde1: the application gear still jumps to Settings -> Forms; the lease gear
    // opens the in-page catalog settings popup (offered toggles) instead.
    expect(application).toContain('router.push("/portal/profile?tab=forms")');
    expect(lease).toContain("PropertyLeaseCatalogSettingsModal");
    expect(lease).toContain("setCatalogSettingsOpen(true)");
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
