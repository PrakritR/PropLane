import { describe, expect, it } from "vitest";
import { recurringMonthlyFeesForLease, shouldBillCustomLeaseSurcharge } from "@/lib/custom-lease-billing";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { isCustomCalendarLease } from "@/lib/rental-application/lease-dates";
import { resolveStayPricing } from "@/lib/room-pricing";
import { shortTermStayNightCount, shortTermStayTotalAmount } from "@/lib/short-term-stay-pricing";

/** The quote/charge/checkout path: resolve the room's rates, then one total. */
function stayTotal(room: { monthlyRent: number; shortTermRent: string; weeklyRentPrice?: number }, start: string, end: string): number {
  const pricing = resolveStayPricing({
    room: { id: "r", ...room },
    submission: { shortTermRentalsAllowed: true },
    application: { rentalType: "short_term", leaseStart: start, leaseEnd: end },
  });
  const nights = shortTermStayNightCount(start, end)!;
  return shortTermStayTotalAmount(pricing.dailyRate ?? 0, nights, pricing.weeklyRate, pricing.monthlyRate);
}

const standard = { monthlyRent: 1000, shortTermRent: "50" };
const premium = { monthlyRent: 1200, shortTermRent: "60" };

describe("stay-length tiers through resolveStayPricing", () => {
  it("1-6 nights bill nightly", () => {
    expect(stayTotal(standard, "2027-03-01", "2027-03-04")).toBe(150);
    expect(stayTotal(premium, "2027-03-01", "2027-03-07")).toBe(360);
  });
  it("7 nights is one weekly rate ($300 / $360), defaulting to 6 x nightly", () => {
    expect(stayTotal(standard, "2027-03-01", "2027-03-08")).toBe(300);
    expect(stayTotal(premium, "2027-03-01", "2027-03-08")).toBe(360);
  });
  it("10 nights prorates the weekly rate per night", () => {
    expect(stayTotal(standard, "2027-03-01", "2027-03-11")).toBe(428.57);
    expect(stayTotal(premium, "2027-03-01", "2027-03-11")).toBe(514.29);
  });
  it("an explicit weekly rate wins over the default", () => {
    expect(stayTotal({ ...standard, weeklyRentPrice: 280 }, "2027-03-01", "2027-03-08")).toBe(280);
  });
  it("28+ nights is the monthly rate prorated over 30 nights; 30 nights = the monthly rate", () => {
    expect(stayTotal(standard, "2027-03-01", "2027-03-31")).toBe(1000);
    expect(stayTotal(premium, "2027-03-01", "2027-03-31")).toBe(1200);
    expect(stayTotal(standard, "2027-03-01", "2027-03-29")).toBe(933.33);
  });
});

describe("custom-date lease surcharge", () => {
  it.each([
    ["2026-11-15", "2027-01-31", true],
    ["2026-12-01", "2027-01-14", true],
    ["2026-12-01", "2027-02-01", false],
    ["2026-12-01", "2027-02-28", false],
    ["2026-12-01", "", false],
    ["2026-12-15", "", true],
    ["2026-11-15", "2026-12-14", true],
  ])("%s -> %s custom: %s", (start, end, expected) => {
    expect(isCustomCalendarLease(start, end)).toBe(expected);
  });

  const sub = normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), allowedLeaseTerms: ["Custom", "Long-term", "Month-to-Month"] });
  const ctx = (leaseStart: string, leaseEnd: string, leaseTerm = "Custom") => ({ leaseStart, leaseEnd, leaseTerm });

  it("bills the blank-amount default of $100 once a month, even when both dates are custom", () => {
    const fees = recurringMonthlyFeesForLease(sub, [], ctx("2026-11-15", "2026-12-14"));
    expect(fees.filter((f) => f.id === "preset:custom_lease_surcharge")).toEqual([
      { id: "preset:custom_lease_surcharge", label: "Custom lease", amount: 100 },
    ]);
  });
  it("bills nothing on an aligned lease or month-to-month", () => {
    expect(shouldBillCustomLeaseSurcharge(ctx("2026-12-01", "2027-02-01"), sub)).toBe(false);
    expect(recurringMonthlyFeesForLease(sub, [], ctx("2026-12-01", "", "Month-to-Month"))).toEqual([]);
  });
});
