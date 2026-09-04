/**
 * "Show properly payments" — the renewal preview a resident reads BEFORE
 * confirming. It must never quote a number the ledger would not go on to bill,
 * which is why it shares the proration helpers with the ledger and the document.
 */
import { describe, expect, it } from "vitest";
import { leaseRenewalPaymentPreview } from "@/lib/lease-renewal-preview";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";

const base = { monthlyRent: 1000, currentMonthlyRent: 900, monthlyUtilities: 0 };

describe("leaseRenewalPaymentPreview", () => {
  it("prices a clean calendar term with no partial months", () => {
    const p = leaseRenewalPaymentPreview({
      ...base,
      leaseTerm: "Long-term",
      leaseStart: "2027-01-01",
      leaseEnd: "2027-06-30",
    });
    expect(p.applies).toBe(true);
    expect(p.lines.map((l) => l.id)).toEqual(["monthly"]);
    expect(p.lines[0]!.label).toBe("Monthly rent × 6");
    expect(p.total).toBe(6000);
  });

  it("shows both partial months when the dates do not line up", () => {
    const p = leaseRenewalPaymentPreview({
      ...base,
      leaseTerm: "Long-term",
      leaseStart: "2027-01-16",
      leaseEnd: "2027-04-10",
    });
    expect(p.lines.map((l) => l.id)).toEqual(["first", "monthly", "last"]);
    // Jan 16-31 = 16/31 days, Feb + Mar full, Apr 1-10 = 10/30 days.
    expect(p.lines[0]!.amount).toBeCloseTo(516.13, 2);
    expect(p.lines[1]!.label).toBe("Monthly rent × 2");
    expect(p.lines[2]!.amount).toBeCloseTo(333.33, 2);
    expect(p.total).toBeCloseTo(2849.46, 2);
  });

  it("uses the current rent when the resident leaves the field blank", () => {
    const p = leaseRenewalPaymentPreview({
      ...base,
      monthlyRent: null,
      leaseTerm: "Long-term",
      leaseStart: "2027-01-01",
      leaseEnd: "2027-03-31",
    });
    expect(p.total).toBe(2700);
  });

  it("gives month-to-month a recurring line and NO term total", () => {
    // An open-ended tenancy has no total; printing one would invent an end date.
    const p = leaseRenewalPaymentPreview({
      ...base,
      leaseTerm: "Month-to-Month",
      leaseStart: "2027-01-01",
      leaseEnd: "",
    });
    expect(p.total).toBeNull();
    expect(p.lines.some((l) => l.recurring)).toBe(true);
  });

  it("declines to price a short stay rather than guessing a monthly schedule", () => {
    const p = leaseRenewalPaymentPreview({
      ...base,
      leaseTerm: SHORT_TERM_LEASE_TERM,
      leaseStart: "2027-01-05",
      leaseEnd: "2027-01-12",
    });
    expect(p.applies).toBe(false);
    expect(p.lines).toEqual([]);
    expect(p.note).toContain("per night");
  });

  it("says nothing at all when no rent is known", () => {
    const p = leaseRenewalPaymentPreview({
      monthlyRent: null,
      currentMonthlyRent: null,
      leaseTerm: "Long-term",
      leaseStart: "2027-01-01",
      leaseEnd: "2027-12-31",
    });
    expect(p.applies).toBe(false);
    expect(p.lines).toEqual([]);
  });

  it("adds utilities into every line", () => {
    const p = leaseRenewalPaymentPreview({
      monthlyRent: 1000,
      currentMonthlyRent: null,
      monthlyUtilities: 200,
      leaseTerm: "Long-term",
      leaseStart: "2027-02-01",
      leaseEnd: "2027-04-30",
    });
    expect(p.lines[0]!.amount).toBe(1200);
    expect(p.total).toBe(3600);
  });
});
