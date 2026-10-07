import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const inspections = readFileSync("src/components/portal/inspections-panel.tsx", "utf8");
const modal = readFileSync("src/components/portal/pro-portal-settings-modal.tsx", "utf8");
const tasks = readFileSync("src/components/portal/pro-task-list.tsx", "utf8");

describe("Operations settings gears carry a Property picker", () => {
  // Portal redesign (captain: "settings should go to page, remove the pop-up"):
  // the Inspections panel's settings sheet was never opened by anything, so it
  // is deleted. Inspection reminders live on the central Settings pages, whose
  // Property picker is covered by the modal guard below.
  it("Inspections no longer mounts its own settings sheet", () => {
    expect(inspections).not.toContain("ProPortalSettingsModal");
    expect(inspections).not.toContain("propertyOptions={propertyOptions}");
  });

  it("the settings modal always wraps the module page in the All properties picker", () => {
    expect(modal).toContain("SettingsPropertyScopeProvider");
    expect(modal).toContain("SettingsScopeBar");
  });

  // S021 (captain, 2026-09-27): the Tasks list page dropped its own settings
  // sheet entirely — task reminders now live only on the central Settings ->
  // Reminders hub, which the property-picker guarantee above still covers.
  it("Tasks no longer opens its own settings sheet", () => {
    expect(tasks).not.toContain('initialTab="tasks"');
    expect(tasks).toContain("propertyOptions={propertyOptions}");
  });
});
