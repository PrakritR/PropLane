import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const inspections = readFileSync("src/components/portal/inspections-panel.tsx", "utf8");
const modal = readFileSync("src/components/portal/pro-portal-settings-modal.tsx", "utf8");
const tasks = readFileSync("src/components/portal/pro-task-list.tsx", "utf8");

describe("Operations settings gears carry a Property picker", () => {
  it("Inspections passes propertyOptions into its settings sheet", () => {
    expect(inspections).toContain("buildManagerPropertyFilterOptions");
    expect(inspections).toContain("propertyOptions={propertyOptions}");
    // Inspections settings tab is gone (C111/C116) — the gear opens the
    // central Reminders hub, grouped to Inspections, instead.
    expect(inspections).toContain('initialTab="automation"');
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
