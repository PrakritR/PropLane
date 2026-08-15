import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  isCurrentResidentApplicationRow,
  shouldReconcileResidentPaymentSchedule,
} from "@/lib/current-resident";

function row(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-TEST",
    name: "Test Resident",
    email: "resident@example.com",
    property: "Test Property",
    bucket: "pending",
    stage: "New",
    ...overrides,
  };
}

describe("shouldReconcileResidentPaymentSchedule", () => {
  it("includes pending submitted residents", () => {
    expect(shouldReconcileResidentPaymentSchedule(row())).toBe(true);
  });

  it("includes approved active residents", () => {
    expect(
      shouldReconcileResidentPaymentSchedule(
        row({ bucket: "approved", stage: "Active" }),
      ),
    ).toBe(true);
    expect(isCurrentResidentApplicationRow(row({ bucket: "approved", stage: "Active" }))).toBe(true);
  });

  it("excludes in-progress drafts and moved-out approved residents", () => {
    expect(
      shouldReconcileResidentPaymentSchedule(
        row({ bucket: "pending", stage: "In progress" }),
      ),
    ).toBe(false);
    expect(
      shouldReconcileResidentPaymentSchedule(
        row({ bucket: "pending", stage: "Submitted" }),
      ),
    ).toBe(true);
    expect(
      shouldReconcileResidentPaymentSchedule(
        row({
          bucket: "approved",
          stage: "Moved out",
          manualResidentDetails: { moveOutDate: "2020-01-01" },
        }),
      ),
    ).toBe(false);
  });
});
