import { reportFixture } from "../helpers/inspection-fixture";
import { describe, expect, it } from "vitest";
import { applyInspectionObservations, createInspectionSchema, transitionInspection } from "@/lib/inspections/model";

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
  it("rejects stale revisions, unknown items, duplicates and locked edits", () => {
    expect(() => applyInspectionObservations(reportFixture({ revision: 2 }), "manager", patch)).toThrow(/changed/);
    expect(() => applyInspectionObservations(reportFixture(), "manager", { ...patch, observations: [{ ...patch.observations[0], itemId: "unknown" }] })).toThrow(/Unknown/);
    expect(() => applyInspectionObservations(reportFixture(), "manager", { ...patch, observations: [...patch.observations, ...patch.observations] })).toThrow(/repeated/);
    for (const status of ["submitted", "completed"] as const) expect(() => applyInspectionObservations(reportFixture({ status }), "manager", patch)).toThrow(/locked/);
  });
  it("requires an actual observation before submitting", () => {
    expect(() => transitionInspection(reportFixture(), "manager", "owner", { revision: 1, action: "submit" })).toThrow(/at least one/);
  });
  it("lets the manager request confirmation of resident-only evidence and refuses resident submission", () => {
    const report = reportFixture();
    report.document.areas[0]!.items[0]!.resident.notes = "Scuff beside the door";
    expect(() => transitionInspection(report, "resident", "resident", { revision: 1, action: "submit" })).toThrow(/Only the manager/);
    expect(transitionInspection(report, "manager", "owner", { revision: 1, action: "submit" }).status).toBe("submitted");
  });
  it("requires resident review before completion and permanently seals completion", () => {
    let report = reportFixture();
    report.document = applyInspectionObservations(report, "manager", patch);
    report = { ...report, ...transitionInspection(report, "manager", "owner", { revision: 1, action: "submit" }) };
    expect(report.status).toBe("submitted");
    expect(() => transitionInspection(report, "manager", "owner", { revision: 1, action: "complete" })).toThrow(/resident must/);
    expect(() => transitionInspection(report, "manager", "owner", { revision: 1, action: "acknowledge" })).toThrow(/Resident acknowledgment/);
    report = { ...report, ...transitionInspection(report, "resident", "resident", { revision: 1, action: "acknowledge" }) };
    expect(report.document.residentAcknowledgment?.userId).toBe("resident");
    expect(() => transitionInspection(report, "resident", "resident", { revision: 1, action: "complete" })).toThrow();
    report = { ...report, ...transitionInspection(report, "manager", "owner", { revision: 1, action: "complete" }) };
    expect(report.status).toBe("completed");
    expect(() => transitionInspection(report, "manager", "owner", { revision: 1, action: "reopen" })).toThrow(/permanent/);
  });
  it("invalidates acknowledgment whenever a manager reopens the report", () => {
    const report = reportFixture({ status: "submitted" });
    report.document.residentAcknowledgment = { userId: "resident", at: "2026-09-05" };
    expect(() => transitionInspection(report, "resident", "resident", { revision: 1, action: "reopen" })).toThrow();
    const next = transitionInspection(report, "manager", "owner", { revision: 1, action: "reopen" });
    expect(next.status).toBe("draft"); expect(next.document.residentAcknowledgment).toBeNull();
  });
  it("rejects duplicate acknowledgment and stale status changes", () => {
    const report = reportFixture({ status: "submitted" });
    report.document.residentAcknowledgment = { userId: "resident", at: "2026-09-05" };
    expect(() => transitionInspection(report, "resident", "resident", { revision: 1, action: "acknowledge" })).toThrow();
    expect(() => transitionInspection(report, "manager", "owner", { revision: 2, action: "complete" })).toThrow(/changed/);
  });
});
