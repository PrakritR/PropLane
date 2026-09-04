/**
 * The renewal line at the top of the resident's Lease tab.
 *
 * Before this, the tab said nothing about a lease two weeks from ending — the
 * only extend affordance was a footer button on a signed lease's DETAIL page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const rollsOver = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/rental-application/data", () => ({
  listingRollsOverToMonthToMonth: () => rollsOver.value,
}));

import { residentLeaseRenewalStatus, daysUntil } from "@/lib/resident-lease-renewal-status";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const TODAY = new Date(2027, 0, 15); // Jan 15 2027, local

const signature = { role: "manager" as const, name: "M", signedAtIso: "2026-01-01T00:00:00.000Z" };

function lease(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentEmail: "r@example.com",
    propertyId: "property-1",
    bucket: "resident",
    status: "Fully Signed",
    managerSignature: signature,
    residentSignature: { ...signature, role: "resident" as const },
    application: { leaseTerm: "Long-term", leaseStart: "2026-02-01", leaseEnd: "2027-01-31" },
    ...overrides,
  } as unknown as LeasePipelineRow;
}

describe("residentLeaseRenewalStatus", () => {
  beforeEach(() => {
    rollsOver.value = false;
  });

  it("says nothing when there is no lease or it is not signed", () => {
    expect(residentLeaseRenewalStatus(null, TODAY).kind).toBe("none");
    expect(
      residentLeaseRenewalStatus(lease({ managerSignature: null, residentSignature: null }), TODAY).kind,
    ).toBe("none");
  });

  it("a renewal out for signature outranks the ending lease", () => {
    // Telling the resident their lease is ending, while its replacement sits in
    // their own signature queue, would send them to start a SECOND renewal.
    const status = residentLeaseRenewalStatus(
      lease({
        pendingRenewal: { leaseTerm: "Long-term", leaseStart: "2027-02-01", leaseEnd: "2028-01-31" },
        managerSignature: null,
        residentSignature: null,
      } as Partial<LeasePipelineRow>),
      TODAY,
    );
    expect(status.kind).toBe("awaiting_signature");
    if (status.kind === "awaiting_signature") expect(status.body).toContain("sign");
  });

  it("flags an ending lease with an urgent CTA inside 60 days", () => {
    const status = residentLeaseRenewalStatus(lease(), TODAY);
    expect(status.kind).toBe("ending");
    if (status.kind === "ending") {
      expect(status.daysRemaining).toBe(16);
      expect(status.soon).toBe(true);
      expect(status.cta).toBe("Renew or extend");
      expect(status.headline).toContain("January 31, 2027");
      expect(status.body).toContain("16 days");
    }
  });

  it("stays calm when the end is far off", () => {
    const status = residentLeaseRenewalStatus(
      lease({ application: { leaseTerm: "Long-term", leaseStart: "2026-02-01", leaseEnd: "2028-01-31" } } as Partial<LeasePipelineRow>),
      TODAY,
    );
    expect(status.kind).toBe("ending");
    if (status.kind === "ending") {
      expect(status.soon).toBe(false);
      expect(status.cta).toBe("Extend lease");
    }
  });

  it("tells a rollover resident they need do nothing", () => {
    rollsOver.value = true;
    const status = residentLeaseRenewalStatus(lease(), TODAY);
    expect(status.kind).toBe("rolls_over");
    if (status.kind === "rolls_over") {
      expect(status.headline).toContain("Continues month-to-month");
      expect(status.body).toContain("do not need to do anything");
    }
  });

  it("recognizes an already open-ended tenancy", () => {
    const status = residentLeaseRenewalStatus(
      lease({ application: { leaseTerm: "Month-to-Month", leaseStart: "2026-02-01", leaseEnd: "" } } as Partial<LeasePipelineRow>),
      TODAY,
    );
    expect(status.kind).toBe("month_to_month");
  });

  it("counts days without a timezone slip", () => {
    expect(daysUntil("2027-01-15", TODAY)).toBe(0);
    expect(daysUntil("2027-01-16", TODAY)).toBe(1);
    expect(daysUntil("2027-01-14", TODAY)).toBe(-1);
  });
});
