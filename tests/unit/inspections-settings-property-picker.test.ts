import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const inspections = readFileSync("src/components/portal/inspections-panel.tsx", "utf8");
const modal = readFileSync("src/components/portal/pro-portal-settings-modal.tsx", "utf8");
const tasks = readFileSync("src/components/portal/pro-task-list.tsx", "utf8");

describe("Operations settings gears carry a Property picker", () => {
  it("Inspections passes propertyOptions into its settings sheet", () => {
    expect(inspections).toContain("buildManagerPropertyFilterOptions");
    expect(inspections).toContain("propertyOptions={propertyOptions}");
    expect(inspections).toContain('initialTab="inspections"');
    expect(inspections).toContain("from \"lucide-react\"");
    expect(inspections).toMatch(/import \{[^}]*Settings[^}]*\} from "lucide-react"/);
    expect(inspections).not.toContain("Settings2");
  });

  it("the settings modal wraps inspections, bookings, and tasks in the All properties picker", () => {
    expect(modal).toContain('["inspections", "bookings", "tasks"]');
    expect(modal).toContain("SettingsPropertyScopeProvider");
    expect(modal).toContain("SettingsPropertyScopeBar");
  });

  it("Tasks already hands propertyOptions to the same sheet", () => {
    expect(tasks).toContain("propertyOptions={propertyOptions}");
    expect(tasks).toContain('initialTab="tasks"');
  });
});
