/**
 * AXI-143 — "change leasing to 4 options: short term long term month to month
 * and custom. use as little words as possible make simple and easy to read."
 *
 * The captain's decision: just have Long-term. The move-in / move-out dates ARE
 * the term, and a lease whose dates do not line up with calendar months picks up
 * the custom-lease surcharge — only when the manager has set one — on both the
 * lease document and the charge ledger.
 */
import { describe, expect, it } from "vitest";
import {
  CUSTOM_LEASE_TERM,
  LEASE_TERM_CHOICES,
  LEASE_TERM_OPTIONS,
  LISTING_LEASE_TERM_OPTION_SET,
  LONG_TERM_LEASE_TERM,
  isLegacyFixedLeaseTerm,
} from "@/lib/rental-application/lease-terms";
import { shouldAutoComputeLeaseEnd, resolvePlacementLeaseDates } from "@/lib/rental-application/lease-dates";
import { shouldBillCustomLeaseSurcharge } from "@/lib/custom-lease-billing";

describe("offered lease terms", () => {
  it("offers three named choices, plus short-stay per listing", () => {
    expect(LEASE_TERM_CHOICES).toEqual([LONG_TERM_LEASE_TERM, "Month-to-Month", CUSTOM_LEASE_TERM]);
  });

  it("keeps Custom last", () => {
    expect(LEASE_TERM_CHOICES[LEASE_TERM_CHOICES.length - 1]).toBe(CUSTOM_LEASE_TERM);
  });

  it("still ACCEPTS every legacy fixed length", () => {
    // Signed leases and existing listings carry these; dropping them from the
    // accepted set would invalidate real data.
    for (const legacy of ["3-Month", "6-Month", "9-Month", "12-Month"]) {
      expect(LEASE_TERM_OPTIONS).toContain(legacy);
      expect(LISTING_LEASE_TERM_OPTION_SET.has(legacy)).toBe(true);
      expect(isLegacyFixedLeaseTerm(legacy)).toBe(true);
    }
  });

  it("does not treat the offered terms as legacy", () => {
    for (const offered of LEASE_TERM_CHOICES) expect(isLegacyFixedLeaseTerm(offered)).toBe(false);
  });
});

describe("Long-term takes its length from the dates", () => {
  it("never invents an end date", () => {
    // It has no month count, so the applicant's move-out date is used verbatim.
    expect(shouldAutoComputeLeaseEnd(LONG_TERM_LEASE_TERM, "standard")).toBe(false);
  });

  it("keeps the move-out date the applicant gave", () => {
    const resolved = resolvePlacementLeaseDates({
      leaseTerm: LONG_TERM_LEASE_TERM,
      leaseStart: "2026-09-22",
      leaseEnd: "2027-12-01",
      rentalType: "standard",
    });
    expect(resolved).toEqual({
      leaseTerm: LONG_TERM_LEASE_TERM,
      leaseStart: "2026-09-22",
      leaseEnd: "2027-12-01",
    });
  });
});

describe("custom-lease surcharge on a Long-term lease", () => {
  const ctx = (leaseStart: string, leaseEnd: string) => ({
    leaseTerm: LONG_TERM_LEASE_TERM,
    leaseStart,
    leaseEnd,
    rentalType: "standard",
  });

  it("bills when the dates do not line up with calendar months", () => {
    expect(shouldBillCustomLeaseSurcharge(ctx("2026-09-22", "2027-12-01"))).toBe(true);
  });

  it("does not bill a clean 1st-to-last-day lease", () => {
    expect(shouldBillCustomLeaseSurcharge(ctx("2026-10-01", "2027-09-30"))).toBe(false);
  });

  it("still does not bill a month-to-month tenancy", () => {
    expect(
      shouldBillCustomLeaseSurcharge({
        leaseTerm: "Month-to-Month",
        leaseStart: "2026-09-22",
        leaseEnd: "2027-12-01",
        rentalType: "standard",
      }),
    ).toBe(false);
  });
});
