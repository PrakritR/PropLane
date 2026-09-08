import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  isCurrentResidentApplicationRow,
  residentChargeMoment,
  shouldRetainResidentPaymentSchedule,
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

/**
 * RETENTION is the wider of the two questions and is unchanged: a submitted
 * applicant stays in scope so the reconciler's wipe filter cannot delete a
 * charge a manager added to them (the regression `6aeb64df` fixed).
 */
describe("shouldRetainResidentPaymentSchedule", () => {
  it("includes pending submitted residents", () => {
    expect(shouldRetainResidentPaymentSchedule(row())).toBe(true);
  });

  it("includes approved active residents", () => {
    expect(
      shouldRetainResidentPaymentSchedule(
        row({ bucket: "approved", stage: "Active" }),
      ),
    ).toBe(true);
    expect(isCurrentResidentApplicationRow(row({ bucket: "approved", stage: "Active" }))).toBe(true);
  });

  it("excludes in-progress drafts and moved-out approved residents", () => {
    expect(
      shouldRetainResidentPaymentSchedule(
        row({ bucket: "pending", stage: "In progress" }),
      ),
    ).toBe(false);
    expect(
      shouldRetainResidentPaymentSchedule(
        row({ bucket: "pending", stage: "Submitted" }),
      ),
    ).toBe(true);
    expect(
      shouldRetainResidentPaymentSchedule(
        row({
          bucket: "approved",
          stage: "Moved out",
          manualResidentDetails: { moveOutDate: "2020-01-01" },
        }),
      ),
    ).toBe(false);
  });
});

/**
 * GENERATION is the narrower question, and the one this split exists for. Only
 * two moments create money; approval is deliberately not one of them.
 */
describe("residentChargeMoment", () => {
  const unsigned = { leaseExecuted: false };
  const signed = { leaseExecuted: true };

  it("bills a submitted applicant the application fee and nothing else", () => {
    expect(residentChargeMoment(row({ stage: "Submitted" }), unsigned)).toBe("application");
  });

  it("charges nothing for an unfinished draft", () => {
    expect(residentChargeMoment(row({ bucket: "pending", stage: "In progress" }), unsigned)).toBe("none");
  });

  it("charges NOTHING on approval alone — an approval is a decision, not a bill", () => {
    expect(residentChargeMoment(row({ bucket: "approved", stage: "Active" }), unsigned)).toBe("none");
  });

  it("bills the full schedule once the lease is executed", () => {
    expect(residentChargeMoment(row({ bucket: "approved", stage: "Active" }), signed)).toBe("signed");
  });

  it("treats a hand-onboarded resident as a tenancy even with no lease on file", () => {
    expect(
      residentChargeMoment(row({ bucket: "approved", stage: "Active", manuallyAdded: true }), unsigned),
    ).toBe("signed");
  });

  it("stops billing a moved-out resident even with an executed lease", () => {
    expect(
      residentChargeMoment(
        row({
          bucket: "approved",
          stage: "Moved out",
          manualResidentDetails: { moveOutDate: "2020-01-01" },
        }),
        signed,
      ),
    ).toBe("none");
  });

  it("charges nothing on a billing hold or without an email", () => {
    expect(residentChargeMoment(row({ migrationBillingHold: true }), signed)).toBe("none");
    expect(residentChargeMoment(row({ email: "" }), signed)).toBe("none");
  });
});
