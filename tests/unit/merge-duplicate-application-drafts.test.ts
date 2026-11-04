import { describe, expect, it } from "vitest";

import {
  archivedRowData,
  checkTarget,
  compareDrafts,
  DEV_PROJECT_REF,
  planMerges,
  PRODUCTION_PROJECT_REF,
  projectRefFromUrl,
} from "../../scripts/merge-duplicate-application-drafts.mjs";

type Rec = {
  id: string;
  resident_email: string;
  property_id: string;
  updated_at: string;
  row_data: Record<string, unknown>;
};

function record(id: string, over: Partial<Rec> & { row?: Record<string, unknown>; app?: Record<string, unknown> } = {}): Rec {
  return {
    id,
    resident_email: over.resident_email ?? "kumar@example.com",
    property_id: over.property_id ?? "prop-4709a",
    updated_at: over.updated_at ?? "2026-11-02T10:00:00.000Z",
    row_data: {
      id,
      bucket: "pending",
      stage: "In progress",
      email: over.resident_email ?? "kumar@example.com",
      propertyId: over.property_id ?? "prop-4709a",
      application: { propertyId: over.property_id ?? "prop-4709a", ...(over.app ?? {}) },
      ...(over.row ?? {}),
    },
  };
}

describe("merge-duplicate-application-drafts: planMerges", () => {
  it("keeps the most complete draft and archives the rest", () => {
    const plans = planMerges([
      record("A", { app: { fullLegalName: "K", wizardMaxStepReached: 1 } }),
      record("B", { app: { fullLegalName: "K", employer: "X", monthlyIncome: "5", wizardMaxStepReached: 4 } }),
      record("C", { app: { wizardMaxStepReached: 2 } }),
      record("D", { app: { fullLegalName: "K", wizardMaxStepReached: 1 }, updated_at: "2026-11-03T10:00:00.000Z" }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.kept.id).toBe("B");
    expect(plans[0]!.archive.map((a: { record: Rec }) => a.record.id).sort()).toEqual(["A", "C", "D"]);
    expect(plans[0]!.archive.every((a: { mergedInto: string }) => a.mergedInto === "B")).toBe(true);
  });

  it("breaks a tie on completeness by the newest update", () => {
    const older = record("old", { app: { x: "1" }, updated_at: "2026-10-29T10:00:00.000Z" });
    const newer = record("new", { app: { x: "1" }, updated_at: "2026-11-02T10:00:00.000Z" });
    expect([older, newer].sort(compareDrafts)[0]!.id).toBe("new");
  });

  it("never archives a submitted application: it is what the drafts fold into", () => {
    const plans = planMerges([
      record("S", { row: { stage: "Submitted" }, app: { wizardMaxStepReached: 7 } }),
      record("D1", { app: { wizardMaxStepReached: 6, a: "1", b: "2", c: "3" } }),
      record("D2", { app: { wizardMaxStepReached: 2 } }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.kept.id).toBe("S");
    expect(plans[0]!.keptIsSubmitted).toBe(true);
    expect(plans[0]!.archive.map((a: { record: Rec }) => a.record.id).sort()).toEqual(["D1", "D2"]);
    expect(plans[0]!.archive.every((a: { mergedInto: string }) => a.mergedInto === "S")).toBe(true);
  });

  it("never archives a legacy stage-less row: it is not provably unsent", () => {
    // Two genuinely submitted rows that predate the `stage` field. Neither may be withdrawn.
    expect(
      planMerges([
        record("L1", { row: { stage: "" }, app: { fullLegalName: "K", wizardMaxStepReached: 7 } }),
        record("L2", { row: { stage: "" }, app: { fullLegalName: "K", wizardMaxStepReached: 6 } }),
      ]),
    ).toHaveLength(0);
    // A real draft beside one still folds into it, and the legacy row is what is kept.
    const plans = planMerges([
      record("L1", { row: { stage: "" }, app: { fullLegalName: "K", wizardMaxStepReached: 7 } }),
      record("D1", { app: { wizardMaxStepReached: 2 } }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.kept.id).toBe("L1");
    expect(plans[0]!.archive.map((a: { record: Rec }) => a.record.id)).toEqual(["D1"]);
  });

  it("keeps a draft for a different room than the sent application", () => {
    const plans = planMerges([
      record("S", { row: { stage: "Submitted" }, app: { roomChoice1: "prop::room-1" } }),
      record("D", { app: { roomChoice1: "prop::room-2" } }),
    ]);
    expect(plans).toHaveLength(0);
  });

  it("leaves different people and different houses alone", () => {
    expect(
      planMerges([
        record("A"),
        record("B", { resident_email: "someone-else@example.com" }),
        record("C", { property_id: "prop-other" }),
      ]),
    ).toHaveLength(0);
  });

  it("never touches approved, declined, withdrawn, merged or hand-added rows, and reports a decided sibling", () => {
    const plans = planMerges([
      record("D1"),
      record("D2", { app: { a: "1" } }),
      record("OK", { row: { bucket: "approved", stage: "Approved" } }),
      record("NO", { row: { bucket: "rejected", stage: "Declined" } }),
      record("W", { row: { withdrawnAt: "2026-11-01T00:00:00.000Z" } }),
      record("M", { row: { mergedInto: "D1" } }),
      record("H", { row: { manuallyAdded: true } }),
    ]);
    expect(plans).toHaveLength(1);
    const touched = [plans[0]!.kept.id, ...plans[0]!.archive.map((a: { record: Rec }) => a.record.id)].sort();
    expect(touched).toEqual(["D1", "D2"]);
    expect(plans[0]!.siblings.map((s: { id: string }) => s.id).sort()).toEqual(["NO", "OK"]);
  });

  it("keys on the Auth subject when the row has one: a guest row is never merged into an account's", () => {
    // Same email, three different people: one guest row and two signed-in accounts.
    expect(
      planMerges([
        record("G1"),
        record("A1", { row: { residentUserId: "subject-a" } }),
        record("B1", { row: { residentUserId: "subject-b" }, app: { a: "1" } }),
      ]),
    ).toHaveLength(0);
    // Two drafts of the SAME account still merge, even though one carries a different typed email.
    const plans = planMerges([
      record("A1", { row: { residentUserId: "subject-a" } }),
      record("A2", { resident_email: "typo@example.com", row: { residentUserId: "subject-a" }, app: { a: "1" } }),
    ]);
    expect(plans).toHaveLength(1);
    expect(plans[0]!.kept.id).toBe("A2");
  });

  it("matches a guest applicant by email case-insensitively", () => {
    const plans = planMerges([
      record("A", { resident_email: "Kumar@Example.com" }),
      record("B", { resident_email: "kumar@example.com", app: { a: "1" } }),
    ]);
    expect(plans).toHaveLength(1);
  });

  it("writes an archived row as the stored row plus three merge fields only", () => {
    const next = archivedRowData({ id: "A", bucket: "pending", stage: "In progress" }, "B", "2026-11-03T00:00:00.000Z");
    expect(next).toEqual({
      id: "A",
      bucket: "pending",
      stage: "In progress",
      withdrawnAt: "2026-11-03T00:00:00.000Z",
      mergedInto: "B",
      mergedAt: "2026-11-03T00:00:00.000Z",
    });
  });
});

describe("merge-duplicate-application-drafts: target guard", () => {
  it("reads the project ref and refuses production without the flag", () => {
    expect(projectRefFromUrl(`https://${DEV_PROJECT_REF}.supabase.co`)).toBe(DEV_PROJECT_REF);
    expect(checkTarget(DEV_PROJECT_REF).ok).toBe(true);
    expect(checkTarget(PRODUCTION_PROJECT_REF).ok).toBe(false);
    expect(checkTarget(PRODUCTION_PROJECT_REF, { confirmProduction: true }).ok).toBe(true);
    expect(checkTarget("xwszcafaontidfgznlxd", { confirmProduction: true }).ok).toBe(false);
    expect(checkTarget("").ok).toBe(false);
  });
});
