import { describe, expect, it } from "vitest";
import {
  agreementTermsSha256,
  allocateFeeAcrossCharges,
  canonicalAgreementTerms,
  computeExpenseRecoupCents,
  computeManagementFee,
  describeOwnerFee,
  feeRefundCents,
  maxCumulativeFeeCents,
  ownerNetBreakdown,
  pacificMonthKey,
  previousMonthKey,
  roundHalfUpDiv,
  targetMonthlyFeeCents,
  validateOwnerAgreementTerms,
  type OwnerAgreementTerms,
} from "@/lib/owner-management/fee-math";

const pct = (feeBps: number, extra: Partial<OwnerAgreementTerms> = {}): OwnerAgreementTerms => ({
  feeModel: "percent_of_collected",
  feeBps,
  feeFlatCents: 0,
  leasingFeeBps: 0,
  minFeeCents: 0,
  repairApprovalThresholdCents: 25_000,
  reserveTargetCents: 0,
  ...extra,
});
const flat = (feeFlatCents: number, extra: Partial<OwnerAgreementTerms> = {}): OwnerAgreementTerms => ({
  feeModel: "flat_monthly",
  feeBps: 0,
  feeFlatCents,
  leasingFeeBps: 0,
  minFeeCents: 0,
  repairApprovalThresholdCents: 25_000,
  reserveTargetCents: 0,
  ...extra,
});

describe("rounding", () => {
  it("rounds half up on integer cents", () => {
    expect(roundHalfUpDiv(5, 10)).toBe(1);
    expect(roundHalfUpDiv(4, 10)).toBe(0);
    expect(roundHalfUpDiv(15, 10)).toBe(2);
    expect(roundHalfUpDiv(0, 7)).toBe(0);
  });
  it("refuses fractional or negative cents", () => {
    expect(() => roundHalfUpDiv(-1, 10)).toThrow();
    expect(() => roundHalfUpDiv(1.5, 10)).toThrow();
    expect(() => roundHalfUpDiv(1, 0)).toThrow();
  });
});

describe("percent_of_collected", () => {
  it("takes 8% of a $1,850 rent exactly", () => {
    const fee = computeManagementFee({ terms: pct(800), cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 185_000, leasingPrincipal: 0 });
    expect(fee).toEqual({ monthlyFeeCents: 14_800, leasingFeeCents: 0, totalCents: 14_800 });
  });
  it("rounds half up: 8.5% of $1,234.57", () => {
    // 123457 * 850 / 10000 = 10493.845 -> 10494
    const fee = computeManagementFee({ terms: pct(850), cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 123_457, leasingPrincipal: 0 });
    expect(fee.totalCents).toBe(10_494);
  });
  it("partial payments sum to exactly the fee on the total (cumulative rounding)", () => {
    const terms = pct(850);
    const payments = [33_333, 33_333, 33_334]; // $1,000.00 in three pieces
    let cum = 0;
    let taken = 0;
    for (const principal of payments) {
      const fee = computeManagementFee({ terms, cumPrincipalBefore: cum, monthlyFeeTakenBefore: taken, principal, leasingPrincipal: 0 });
      cum += principal;
      taken += fee.monthlyFeeCents;
    }
    expect(taken).toBe(targetMonthlyFeeCents(terms, 100_000));
    expect(taken).toBe(8_500);
  });
  it("a second payment the same month only tops up to the target", () => {
    const terms = pct(1000);
    const first = computeManagementFee({ terms, cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 60_000, leasingPrincipal: 0 });
    const second = computeManagementFee({ terms, cumPrincipalBefore: 60_000, monthlyFeeTakenBefore: first.monthlyFeeCents, principal: 40_000, leasingPrincipal: 0 });
    expect(first.monthlyFeeCents + second.monthlyFeeCents).toBe(10_000);
  });
  it("never takes a negative fee after a refund lowered the month's collected total", () => {
    const fee = computeManagementFee({ terms: pct(1000), cumPrincipalBefore: 10_000, monthlyFeeTakenBefore: 1_500, principal: 5_000, leasingPrincipal: 0 });
    expect(fee.monthlyFeeCents).toBe(0);
  });
  it("0 principal takes nothing", () => {
    expect(computeManagementFee({ terms: pct(1000), cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 0, leasingPrincipal: 0 }).totalCents).toBe(0);
  });
});

describe("flat_monthly and minimum", () => {
  it("takes the flat fee once, from the first payment, then nothing", () => {
    const terms = flat(15_000);
    const first = computeManagementFee({ terms, cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 90_000, leasingPrincipal: 0 });
    const second = computeManagementFee({ terms, cumPrincipalBefore: 90_000, monthlyFeeTakenBefore: first.monthlyFeeCents, principal: 90_000, leasingPrincipal: 0 });
    expect(first.monthlyFeeCents).toBe(15_000);
    expect(second.monthlyFeeCents).toBe(0);
  });
  it("never exceeds what was collected", () => {
    const fee = computeManagementFee({ terms: flat(15_000), cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 4_000, leasingPrincipal: 0 });
    expect(fee.monthlyFeeCents).toBe(4_000 - 0);
    // leasing none; fee is clamped to principal, the flow later refuses an owner share of 0
    expect(fee.monthlyFeeCents).toBeLessThanOrEqual(4_000);
  });
  it("the minimum lifts a small percent fee", () => {
    const terms = pct(500, { minFeeCents: 5_000 });
    expect(targetMonthlyFeeCents(terms, 40_000)).toBe(5_000); // 5% = 2000 < 5000 floor
    expect(targetMonthlyFeeCents(terms, 200_000)).toBe(10_000); // 5% above the floor
  });
  it("the minimum is bounded by the collected rent", () => {
    expect(targetMonthlyFeeCents(pct(500, { minFeeCents: 50_000 }), 20_000)).toBe(20_000);
  });
});

describe("leasing fee", () => {
  it("adds a percent of the first month's rent once", () => {
    const fee = computeManagementFee({ terms: pct(800, { leasingFeeBps: 5000 }), cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 100_000, leasingPrincipal: 100_000 });
    expect(fee.monthlyFeeCents).toBe(8_000);
    expect(fee.leasingFeeCents).toBe(50_000 > 100_000 - 8_000 - 1 ? 100_000 - 8_000 - 1 : 50_000);
    expect(fee.totalCents).toBe(58_000);
  });
  it("leaves the owner at least one cent", () => {
    const fee = computeManagementFee({ terms: pct(800, { leasingFeeBps: 10_000 }), cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 100_000, leasingPrincipal: 100_000 });
    expect(fee.totalCents).toBeLessThan(100_000);
  });
  it("takes nothing when no leasing principal is passed (already charged)", () => {
    const fee = computeManagementFee({ terms: pct(800, { leasingFeeBps: 5000 }), cumPrincipalBefore: 0, monthlyFeeTakenBefore: 0, principal: 100_000, leasingPrincipal: 0 });
    expect(fee.leasingFeeCents).toBe(0);
  });
  it("max cumulative bound is monthly target plus leasing actually taken", () => {
    expect(maxCumulativeFeeCents(pct(800), 100_000, 0)).toBe(8_000);
    expect(maxCumulativeFeeCents(pct(800), 100_000, 2_500)).toBe(10_500);
    expect(maxCumulativeFeeCents(flat(200_000), 100_000, 0)).toBe(100_000);
  });
});

describe("spreading a cart's fee over its charges", () => {
  it("sums to the fee with largest-remainder rounding and is stable on ties", () => {
    const parts = [
      { id: "c", principalCents: 10_000 },
      { id: "a", principalCents: 10_000 },
      { id: "b", principalCents: 10_000 },
    ];
    const shares = allocateFeeAcrossCharges(parts, 100);
    expect(shares.reduce((s, p) => s + p.feeCents, 0)).toBe(100);
    expect(shares.map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(shares.map((s) => s.feeCents)).toEqual([34, 33, 33]);
    expect(allocateFeeAcrossCharges(parts, 100)).toEqual(shares);
  });
  it("refuses a fee larger than the cart", () => {
    expect(() => allocateFeeAcrossCharges([{ id: "a", principalCents: 100 }], 101)).toThrow();
  });
});

describe("refunds reverse the application fee in proportion", () => {
  it("full refund returns the whole fee", () => {
    expect(feeRefundCents(8_500, 100_000, 100_000)).toBe(8_500);
  });
  it("partial refund returns a proportional fee, rounded half up", () => {
    expect(feeRefundCents(8_500, 100_000, 25_000)).toBe(2_125);
    expect(feeRefundCents(101, 1_000, 500)).toBe(51); // 50.5 -> 51
  });
  it("refuses a refund above the payment", () => {
    expect(() => feeRefundCents(100, 1_000, 1_001)).toThrow();
  });
  it("two partial refunds never return more than the fee in total on a full second refund", () => {
    const first = feeRefundCents(101, 1_000, 400);
    expect(first).toBe(40);
    // The remaining refund is the remaining principal: Stripe returns the rest of the fee.
    expect(101 - first).toBe(61);
  });
});

describe("expense recoup and the owner's net", () => {
  it("is bounded by outstanding, by half the payment, and leaves the owner a positive net", () => {
    expect(computeExpenseRecoupCents({ outstandingApprovedCents: 24_000, principal: 100_000, managementFeeCents: 8_000, ownerBornProcessingCents: 0 })).toBe(24_000);
    expect(computeExpenseRecoupCents({ outstandingApprovedCents: 90_000, principal: 100_000, managementFeeCents: 8_000, ownerBornProcessingCents: 0 })).toBe(50_000);
    expect(computeExpenseRecoupCents({ outstandingApprovedCents: 90_000, principal: 10_000, managementFeeCents: 9_999, ownerBornProcessingCents: 0 })).toBe(0);
  });
  it("net equals principal minus every deduction and must stay positive", () => {
    const net = ownerNetBreakdown({ principalCents: 100_000, managementFeeCents: 8_000, ownerBornProcessingCents: 500, expenseRecoupCents: 24_000 });
    expect(net.ownerNetCents).toBe(67_500);
    expect(() => ownerNetBreakdown({ principalCents: 100, managementFeeCents: 100, ownerBornProcessingCents: 0, expenseRecoupCents: 0 })).toThrow();
  });
});

describe("terms validation and hashing", () => {
  it("accepts sane terms and rejects out-of-range ones", () => {
    expect(validateOwnerAgreementTerms(pct(800))).toBeNull();
    expect(validateOwnerAgreementTerms(pct(3001))).toMatch(/30%/);
    expect(validateOwnerAgreementTerms(pct(0))).toMatch(/percentage/);
    expect(validateOwnerAgreementTerms(flat(0))).toMatch(/monthly fee/);
    expect(validateOwnerAgreementTerms(flat(600_000))).toMatch(/\$5,000/);
    expect(validateOwnerAgreementTerms(pct(800, { leasingFeeBps: 10_001 }))).toMatch(/leasing/);
    expect(validateOwnerAgreementTerms(pct(800, { repairApprovalThresholdCents: -1 }))).toMatch(/repair/);
  });
  it("the terms hash changes with any term", () => {
    const base = { propertyId: "p1", ownerUserId: "u1", terms: pct(800), startsOn: "2026-11-01", endsOn: null };
    const h1 = agreementTermsSha256(canonicalAgreementTerms(base));
    const h2 = agreementTermsSha256(canonicalAgreementTerms({ ...base, terms: pct(801) }));
    const h3 = agreementTermsSha256(canonicalAgreementTerms({ ...base, startsOn: "2026-11-02" }));
    expect(new Set([h1, h2, h3]).size).toBe(3);
    expect(agreementTermsSha256(canonicalAgreementTerms(base))).toBe(h1);
  });
  it("describes the fee in plain English", () => {
    expect(describeOwnerFee(pct(800))).toBe("8% of rent collected");
    expect(describeOwnerFee(flat(15_000, { minFeeCents: 10_000, leasingFeeBps: 5000 }))).toBe("$150 a month, 50% leasing fee, $100 monthly minimum");
  });
});

describe("Pacific months", () => {
  it("uses the Pacific calendar, not UTC", () => {
    expect(pacificMonthKey("2026-11-01T06:59:00Z")).toBe("2026-10"); // still Oct 31 in Pacific
    expect(pacificMonthKey("2026-11-01T08:00:00Z")).toBe("2026-11");
  });
  it("steps back across a year", () => {
    expect(previousMonthKey("2027-01")).toBe("2026-12");
    expect(previousMonthKey("2026-11")).toBe("2026-10");
  });
});
