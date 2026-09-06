import { describe, expect, it } from "vitest";
import { buildInspectionRows } from "@/components/portal/inspections-panel";
import { residencyOccupancy, type InspectionResidency, type InspectionSummary } from "@/lib/inspections/model";

/**
 * The Inspections page shipped listing only FILED reports, so a manager with seven properties
 * and nine approved residents saw "Move-in 0 / Move-out 0" and an empty state telling them an
 * approved resident was needed. The list is a roster of people; a report rides on the row it
 * belongs to.
 */

const residency = (over: Partial<InspectionResidency> & { id: string }): InspectionResidency => ({
  name: "Resident", property: "5259 Brooklyn Ave NE", room: "Room 1", canCreate: true,
  moveInDate: "", moveOutDate: "", occupancy: "upcoming", ...over,
});

const report = (over: Partial<InspectionSummary> & { id: string; application_id: string }): InspectionSummary => ({
  manager_user_id: "mgr", property_id: "prop", resident_name: "Resident",
  property_label: "5259 Brooklyn Ave NE", room_label: "Room 1", kind: "move-in", status: "draft",
  inspection_date: "2026-03-04", baseline_id: null, revision: 1,
  created_at: "2026-03-04T00:00:00.000Z", updated_at: "2026-03-04T00:00:00.000Z", ...over,
});

describe("residencyOccupancy", () => {
  const today = "2026-09-05";

  it("treats a placement with no dates as upcoming, never current", () => {
    // An approved applicant whose dates are still blank has not moved in; calling them current
    // would file them under move-out.
    expect(residencyOccupancy("", "", today)).toBe("upcoming");
  });

  it("is current from the move-in day through the move-out day inclusive", () => {
    expect(residencyOccupancy("2026-09-05", "", today)).toBe("current");
    expect(residencyOccupancy("2026-01-01", "2026-09-05", today)).toBe("current");
    expect(residencyOccupancy("2026-09-06", "", today)).toBe("upcoming");
    expect(residencyOccupancy("2026-01-01", "2026-09-04", today)).toBe("past");
  });
});

describe("buildInspectionRows", () => {
  it("lists approved residents with no report at all", () => {
    const rows = buildInspectionRows("move-in", [
      residency({ id: "app-1", name: "Sohan Vivek Naik", moveInDate: "2026-10-01", occupancy: "upcoming" }),
    ], []);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Sohan Vivek Naik");
    expect(rows[0]!.preview).toContain("Moves in Oct 1, 2026");
    expect(rows[0]!.preview).toContain("No move-in inspection yet");
    expect(rows[0]!.badge.label).toBe("Moving in");
  });

  it("shows a current resident with the date they moved in", () => {
    const rows = buildInspectionRows("move-in", [
      residency({ id: "app-2", name: "aarav jain", moveInDate: "2026-08-01", occupancy: "current" }),
    ], []);

    expect(rows[0]!.preview).toContain("Moved in Aug 1, 2026");
    expect(rows[0]!.badge.label).toBe("Living here");
  });

  it("puts current residents on the move-out tab as still to move out", () => {
    const rows = buildInspectionRows("move-out", [
      residency({ id: "app-2", moveInDate: "2026-08-01", moveOutDate: "2027-07-31", occupancy: "current" }),
      residency({ id: "app-3", moveInDate: "2026-10-01", occupancy: "upcoming" }),
    ], []);

    // Someone who has not moved in yet cannot be moving out.
    expect(rows.map(row => row.key)).toEqual(["residency:app-2"]);
    expect(rows[0]!.preview).toContain("Moves out Jul 31, 2027");
  });

  it("drops a moved-out resident from the move-in tab but keeps them on move-out", () => {
    const past = residency({ id: "app-4", moveInDate: "2025-01-01", moveOutDate: "2026-01-01", occupancy: "past" });

    expect(buildInspectionRows("move-in", [past], [])).toEqual([]);
    expect(buildInspectionRows("move-out", [past], [])).toHaveLength(1);
  });

  it("keeps every filed report of that kind reachable, under its resident's tenancy", () => {
    const rows = buildInspectionRows("move-in", [
      residency({ id: "app-1", moveInDate: "2026-08-01", occupancy: "current" }),
    ], [
      report({ id: "r-old", application_id: "app-1", created_at: "2026-08-01T00:00:00.000Z", inspection_date: "2026-08-01" }),
      report({ id: "r-new", application_id: "app-1", created_at: "2026-08-09T00:00:00.000Z", inspection_date: "2026-08-09", status: "completed" }),
      report({ id: "r-out", application_id: "app-1", kind: "move-out" }),
    ]);

    // Both move-in reports stay reachable; the move-out one belongs to the other tab.
    expect(rows.map(row => row.report?.id)).toEqual(["r-old", "r-new"]);
    expect(rows.every(row => row.preview.includes("Moved in Aug 1, 2026"))).toBe(true);
    expect(rows[1]!.badge.label).toBe("Completed");
    expect(rows[1]!.preview).toContain("Move-in inspection Aug 9, 2026");
  });

  it("keeps a report whose residency is gone reachable on its own row", () => {
    // Evidence must never disappear because the application row was withdrawn or reassigned.
    const rows = buildInspectionRows("move-in", [], [report({ id: "r-orphan", application_id: "gone" })]);

    expect(rows.map(row => row.key)).toEqual(["report:r-orphan"]);
    expect(rows[0]!.report?.id).toBe("r-orphan");
  });

  it("orders a tab by the date that tab is about, undated last", () => {
    const rows = buildInspectionRows("move-in", [
      residency({ id: "c", name: "C", moveInDate: "", occupancy: "upcoming" }),
      residency({ id: "b", name: "B", moveInDate: "2026-11-01", occupancy: "upcoming" }),
      residency({ id: "a", name: "A", moveInDate: "2026-09-01", occupancy: "current" }),
    ], []);

    expect(rows.map(row => row.name)).toEqual(["A", "B", "C"]);
  });

  it("formats a wall date without shifting it a day west of Greenwich", () => {
    // A tenancy date is `2026-03-04`, not an instant; parsing it as UTC prints March 3.
    const rows = buildInspectionRows("move-in", [
      residency({ id: "app-1", moveInDate: "2026-03-04", occupancy: "upcoming" }),
    ], []);

    expect(rows[0]!.preview).toContain("Mar 4, 2026");
  });
});
