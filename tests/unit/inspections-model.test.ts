import { reportFixture } from "../helpers/inspection-fixture";
import { describe, expect, it } from "vitest";
import { applyInspectionObservations, createInspectionSchema, ensureInspectionSchema, inspectionPhotoCounts } from "@/lib/inspections/model";

const patch = { revision: 1, observations: [{ itemId: "area-0-item-0", condition: "damaged", notes: "Door has a scratch" }] };
describe("inspection evidence and workflow", () => {
  it("creates all PDF areas with independent, unassessed observations", () => {
    const report = reportFixture();
    expect(report.document.areas).toHaveLength(15);
    expect(report.document.areas.map(a => a.label)).toEqual(expect.arrayContaining(["Kitchen", "Safety & security", "Keys & access", "Front yard & exterior"]));
    report.document.areas[0]!.items[0]!.manager.notes = "Manager note";
    expect(report.document.areas[0]!.items[0]!.resident.notes).toBe("");
    expect(report.document.areas[0]!.items[1]!.manager.notes).toBe("");
  });
  it("accepts only real calendar dates and rejects client ownership fields", () => {
    const input = { applicationId: "a", kind: "move-in", inspectionDate: "2026-02-30" };
    expect(createInspectionSchema.safeParse(input).success).toBe(false);
    expect(createInspectionSchema.safeParse({ ...input, inspectionDate: "2028-02-29" }).success).toBe(true);
    expect(createInspectionSchema.safeParse({ ...input, manager_user_id: "other" }).success).toBe(false);
  });
  it("edits only the caller observations without changing photos or the original snapshot", () => {
    const report = reportFixture();
    report.document.areas[0]!.items[0]!.manager.notes = "Manager baseline";
    const next = applyInspectionObservations(report, "resident", patch);
    expect(next.areas[0]!.items[0]!.resident.notes).toBe("Door has a scratch");
    expect(next.areas[0]!.items[0]!.manager.notes).toBe("Manager baseline");
    expect(report.document.areas[0]!.items[0]!.resident.notes).toBe("");
    expect(() => applyInspectionObservations(report, "resident", { ...patch, photos: [] })).toThrow();
  });
  it("rejects stale revisions, unknown items and duplicates", () => {
    expect(() => applyInspectionObservations(reportFixture({ revision: 2 }), "manager", patch)).toThrow(/changed/);
    expect(() => applyInspectionObservations(reportFixture(), "manager", { ...patch, observations: [{ ...patch.observations[0], itemId: "unknown" }] })).toThrow(/Unknown/);
    expect(() => applyInspectionObservations(reportFixture(), "manager", { ...patch, observations: [...patch.observations, ...patch.observations] })).toThrow(/repeated/);
  });
  /**
   * A report has no locked state. Photos and notes stay open to both parties for as long as
   * the residency is theirs, so a stored legacy status can never refuse an edit — the revision
   * compare-and-swap is the only gate left.
   */
  it("takes edits whatever status a legacy row carries", () => {
    for (const status of ["submitted", "completed"] as const) {
      expect(applyInspectionObservations(reportFixture({ status }), "manager", patch)
        .areas[0]!.items[0]!.manager.notes).toBe("Door has a scratch");
    }
  });
  it("opens a report from the residency alone, with no date or baseline to choose", () => {
    expect(ensureInspectionSchema.safeParse({ applicationId: "AXIS-1", kind: "move-in" }).success).toBe(true);
    expect(ensureInspectionSchema.safeParse({ applicationId: "AXIS-1", kind: "move-in", inspectionDate: "2026-09-10" }).success).toBe(false);
    expect(ensureInspectionSchema.safeParse({ applicationId: "", kind: "move-in" }).success).toBe(false);
  });
  it("counts photos per side and reports the most recent upload", () => {
    const report = reportFixture();
    const item = report.document.areas[0]!.items[0]!;
    item.resident.photos.push({ id: "a", path: "p/a", uploadedBy: "resident", uploadedAt: "2026-09-05T10:00:00Z" });
    item.manager.photos.push({ id: "b", path: "p/b", uploadedBy: "owner", uploadedAt: "2026-09-07T10:00:00Z" });
    expect(inspectionPhotoCounts(report.document)).toEqual({ manager: 1, resident: 1, total: 2, lastAt: "2026-09-07T10:00:00Z" });
    expect(inspectionPhotoCounts(reportFixture().document)).toEqual({ manager: 0, resident: 0, total: 0, lastAt: null });
  });
});
