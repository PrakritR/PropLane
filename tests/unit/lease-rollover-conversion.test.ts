/**
 * A rolled-over lease must be carried past its end date in the DATA, not only
 * in the document.
 *
 * Charges are bounded by `leaseEnd` (`resolveLeaseDatesForBilling`), so a lease
 * whose signed document promises it "continues as a month-to-month tenancy"
 * would otherwise bill nothing at all once that date passed: the resident stays,
 * owes rent, and no charge is ever created.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rollsOver = vi.hoisted(() => ({ value: true }));
vi.mock("@/lib/rental-application/data", () => ({
  listingRollsOverToMonthToMonth: () => rollsOver.value,
}));

import { rolloverConversionApplies } from "@/lib/lease-rollover-conversion";
import type { DemoApplicantRow } from "@/data/demo-portal";

const NOW = new Date(2027, 1, 10); // Feb 10 2027

function row(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXI-1",
    name: "Jordan Lee",
    email: "jordan@example.com",
    property: "Brooklyn House",
    stage: "Active",
    bucket: "approved",
    detail: "",
    assignedPropertyId: "property-1",
    application: {
      leaseTerm: "Long-term",
      leaseStart: "2026-02-01",
      leaseEnd: "2027-01-31",
      rentalType: "standard",
    },
    ...overrides,
  } as unknown as DemoApplicantRow;
}

const opts = { renewalInFlight: false, now: NOW };

describe("rolloverConversionApplies", () => {
  beforeEach(() => {
    rollsOver.value = true;
  });

  it("converts a lapsed fixed term on a rollover listing", () => {
    expect(rolloverConversionApplies(row(), opts)).toBe(true);
  });

  it("leaves a lease that has not ended yet alone", () => {
    expect(
      rolloverConversionApplies(
        row({ application: { leaseTerm: "Long-term", leaseStart: "2026-02-01", leaseEnd: "2027-12-31" } } as Partial<DemoApplicantRow>),
        opts,
      ),
    ).toBe(false);
  });

  it("does nothing when the listing never opted in", () => {
    rollsOver.value = false;
    expect(rolloverConversionApplies(row(), opts)).toBe(false);
  });

  it("never overwrites a renewal the resident is already signing", () => {
    // Converting underneath an in-flight renewal would replace the term they
    // chose with the fallback.
    expect(rolloverConversionApplies(row(), { ...opts, renewalInFlight: true })).toBe(false);
  });

  it("skips short stays and Airbnb bookings", () => {
    for (const rentalType of ["short_term", "airbnb"]) {
      expect(
        rolloverConversionApplies(
          row({ application: { leaseTerm: "Long-term", leaseStart: "2027-01-01", leaseEnd: "2027-01-31", rentalType } } as Partial<DemoApplicantRow>),
          opts,
        ),
      ).toBe(false);
    }
  });

  it("is a no-op for a lease that is already month-to-month", () => {
    expect(
      rolloverConversionApplies(
        row({ application: { leaseTerm: "Month-to-Month", leaseStart: "2026-02-01", leaseEnd: "2027-01-31" } } as Partial<DemoApplicantRow>),
        opts,
      ),
    ).toBe(false);
  });

  it("reads the manual move-out date when a manager set one", () => {
    // A manually added resident carries dates on manualResidentDetails, which
    // resolveLeaseDatesForBilling prefers — reading only the application would
    // miss exactly those residents.
    expect(
      rolloverConversionApplies(
        row({ manualResidentDetails: { moveOutDate: "2027-12-31" } } as Partial<DemoApplicantRow>),
        opts,
      ),
    ).toBe(false);
  });

  it("ignores an applicant who is not an approved resident", () => {
    expect(rolloverConversionApplies(row({ bucket: "pending" } as Partial<DemoApplicantRow>), opts)).toBe(false);
  });
});
