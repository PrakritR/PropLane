// Pure derivation of a rent reporting submission's bureau status from ledger dates,
// plus the "no consent -> no rows" contract on the period builder. Never model
// arithmetic: every date/amount here comes straight off the charge/ledger.
import { describe, expect, it, vi } from "vitest";
import {
  buildRentReportingRowsForPeriod,
  deriveRentReportingSubmissionStatus,
} from "@/lib/rent-reporting/export.server";
import type { RentReportingEnrollment } from "@/lib/rent-reporting/consent.server";

vi.mock("@/lib/payment-automation-server", () => ({
  loadListingByPropertyId: async () => new Map(),
}));

describe("deriveRentReportingSubmissionStatus", () => {
  const base = { dueDate: "2026-08-01", amountCents: 120000, graceDays: 5, lateFeeWaived: false };

  it("unpaid when there is no paid date", () => {
    expect(deriveRentReportingSubmissionStatus({ ...base, paidAt: null })).toBe("unpaid");
  });

  it("on time when paid on the due date", () => {
    expect(deriveRentReportingSubmissionStatus({ ...base, paidAt: "2026-08-01" })).toBe("on_time");
  });

  it("on time within the grace period", () => {
    expect(deriveRentReportingSubmissionStatus({ ...base, paidAt: "2026-08-05" })).toBe("on_time");
  });

  it("late_30 just past the grace period", () => {
    expect(deriveRentReportingSubmissionStatus({ ...base, paidAt: "2026-08-20" })).toBe("late_30");
  });

  it("late_60 between 31 and 60 days late", () => {
    expect(deriveRentReportingSubmissionStatus({ ...base, paidAt: "2026-09-15" })).toBe("late_60");
  });

  it("late_90 beyond 60 days late", () => {
    expect(deriveRentReportingSubmissionStatus({ ...base, paidAt: "2026-11-01" })).toBe("late_90");
  });

  it("a waived late fee counts as on time no matter how late the payment landed", () => {
    expect(
      deriveRentReportingSubmissionStatus({ ...base, paidAt: "2026-11-01", lateFeeWaived: true }),
    ).toBe("on_time");
  });
});

function enrollment(over: Partial<RentReportingEnrollment>): RentReportingEnrollment {
  return {
    id: "rr-1",
    residentUserId: "res-1",
    managerUserId: "mgr-1",
    propertyId: "prop-1",
    leaseId: null,
    status: "active",
    consentedAt: "2026-08-01T00:00:00.000Z",
    stoppedAt: null,
    partnerSubjectId: "stub_rr-1",
    ...over,
  };
}

function fakeDb(charges: Array<Record<string, unknown>>) {
  return {
    from(table: string) {
      if (table !== "portal_household_charge_records") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            in() {
              return Promise.resolve({ data: charges.map((row_data) => ({ row_data })), error: null });
            },
          };
        },
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("buildRentReportingRowsForPeriod", () => {
  it("no active enrollments means no rows", async () => {
    const rows = await buildRentReportingRowsForPeriod(fakeDb([]), "2026-08", []);
    expect(rows).toEqual([]);
  });

  it("no consent (stopped enrollment) means no rows, even with a matching charge", async () => {
    const charges = [
      {
        id: "rent-1",
        residentUserId: "res-1",
        propertyId: "prop-1",
        kind: "rent",
        rentMonth: "2026-08",
        amountLabel: "$1,200.00",
        status: "paid",
        paidAt: "2026-08-01",
        dueDateLabel: "Aug 1, 2026",
      },
    ];
    const rows = await buildRentReportingRowsForPeriod(fakeDb(charges), "2026-08", [
      enrollment({ status: "stopped" }),
    ]);
    expect(rows).toEqual([]);
  });

  it("an active enrollment with a matching paid-on-time rent charge reports on_time", async () => {
    const charges = [
      {
        id: "rent-1",
        residentUserId: "res-1",
        propertyId: "prop-1",
        kind: "rent",
        rentMonth: "2026-08",
        amountLabel: "$1,200.00",
        status: "paid",
        paidAt: "2026-08-01",
        dueDateLabel: "Aug 1, 2026",
      },
    ];
    const rows = await buildRentReportingRowsForPeriod(fakeDb(charges), "2026-08", [enrollment({})]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reportingId: "rr-1", period: "2026-08", status: "on_time", amountCents: 120000 });
  });

  it("an active enrollment with no matching charge for the period reports nothing", async () => {
    const rows = await buildRentReportingRowsForPeriod(fakeDb([]), "2026-08", [enrollment({})]);
    expect(rows).toEqual([]);
  });
});
