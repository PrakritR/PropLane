import { describe, expect, it } from "vitest";
import {
  defaultResidentDashboardVisibility,
  RESIDENT_DASHBOARD_SECTIONS,
} from "@/lib/resident-dashboard-preferences";

describe("resident dashboard preferences", () => {
  it("defines seven customizable attention groups in dashboard order", () => {
    expect(RESIDENT_DASHBOARD_SECTIONS.map((s) => s.id)).toEqual([
      "tours",
      "applications",
      "lease",
      "services",
      "payments",
      "communication",
      "houseDetails",
    ]);
  });

  it("defaults every section to visible", () => {
    const visibility = defaultResidentDashboardVisibility();
    for (const section of RESIDENT_DASHBOARD_SECTIONS) {
      expect(visibility[section.id]).toBe(true);
    }
  });
});
