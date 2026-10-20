import { describe, expect, it } from "vitest";
import {
  canonicalPolicyTerms,
  computeCartFee,
  describeManagedFee,
  feeAppliesToKind,
  nextMonthKey,
  pacificMonthKey,
  pacificMonthStartIso,
  policyTermsSha256,
  previousMonthKey,
  refundSplit,
  roundHalfUpDiv,
  spreadByWeight,
  splitManagedCart,
  targetMonthlyFeeCents,
  validateManagedFeeTerms,
  type CartComponent,
  type ManagedFeeTerms,
} from "@/lib/owner-management/fee-math";

const terms = (over: Partial<ManagedFeeTerms> = {}): ManagedFeeTerms => ({
  ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0, reserveTargetCents: 0,
  repairApprovalThresholdCents: 25_000, ...over,
});

describe("the captain's example", () => {
  it("rent $1000 at 90 / 10 gives the owner $900 and PropLane $100", () => {
    const cart = computeCartFee({ terms: terms(), cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 100_000, leasingBase: 0 });
    expect(cart).toEqual({ monthlyFeeCents: 10_000, leasingFeeCents: 0, totalCents: 10_000 });
  });
  it("odd amounts round the fee DOWN and the owner keeps the remainder", () => {
    // 10% of $1,234.57 = 12345.7 cents -> 12345 ; owner gets 111112
    const cart = computeCartFee({ terms: terms(), cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 123_457, leasingBase: 0 });
    expect(cart.monthlyFeeCents).toBe(12_345);
    expect(123_457 - cart.monthlyFeeCents).toBe(111_112);
  });
  it("a one-cent payment takes no fee", () => {
    expect(computeCartFee({ terms: terms(), cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 9, leasingBase: 0 }).monthlyFeeCents).toBe(0);
  });
});

describe("partial payments", () => {
  it("three pieces of $1,000.01 sum to exactly one floor of the total", () => {
    const t = terms({ ownerShareBps: 8750 }); // 12.5%
    const pieces = [33_333, 33_333, 33_335];
    let cum = 0;
    let taken = 0;
    for (const p of pieces) {
      const fee = computeCartFee({ terms: t, cumBaseBefore: cum, monthlyFeeTakenBefore: taken, applicableBase: p, leasingBase: 0 });
      cum += p;
      taken += fee.monthlyFeeCents;
    }
    expect(taken).toBe(targetMonthlyFeeCents(t, 100_001));
    expect(taken).toBe(12_500);
  });
  it("never takes a negative fee after a refund lowered the month", () => {
    const fee = computeCartFee({ terms: terms(), cumBaseBefore: 10_000, monthlyFeeTakenBefore: 1_500, applicableBase: 5_000, leasingBase: 0 });
    expect(fee.monthlyFeeCents).toBe(0);
  });
});

describe("minimum and leasing fee", () => {
  it("the monthly minimum lifts a small percent fee and is bounded by what was collected", () => {
    expect(targetMonthlyFeeCents(terms({ minFeeCents: 5_000 }), 20_000)).toBe(5_000);
    expect(targetMonthlyFeeCents(terms({ minFeeCents: 5_000 }), 100_000)).toBe(10_000);
    expect(targetMonthlyFeeCents(terms({ minFeeCents: 50_000 }), 20_000)).toBe(20_000);
  });
  it("adds a floor of a percent of the first month, once", () => {
    const t = terms({ leasingFeeBps: 5000 });
    const first = computeCartFee({ terms: t, cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 100_001, leasingBase: 100_001 });
    expect(first.monthlyFeeCents).toBe(10_000);
    expect(first.leasingFeeCents).toBe(50_000);
    const later = computeCartFee({ terms: t, cumBaseBefore: 100_001, monthlyFeeTakenBefore: 10_000, applicableBase: 100_001, leasingBase: 0 });
    expect(later.leasingFeeCents).toBe(0);
  });
  it("a leasing fee can never exceed the amount distributed", () => {
    const fee = computeCartFee({ terms: terms({ ownerShareBps: 5000, leasingFeeBps: 10_000 }), cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 1_000, leasingBase: 1_000 });
    expect(fee.totalCents).toBeLessThanOrEqual(1_000);
  });
});

describe("applies to", () => {
  it("rent only: late fees and utilities carry no fee; deposits never do", () => {
    expect(feeAppliesToKind({ appliesTo: "rent" }, "rent")).toBe(true);
    expect(feeAppliesToKind({ appliesTo: "rent" }, "late_fee")).toBe(false);
    expect(feeAppliesToKind({ appliesTo: "all" }, "late_fee")).toBe(true);
    expect(feeAppliesToKind({ appliesTo: "all" }, "security_deposit")).toBe(false);
  });
});

describe("splitting a cart", () => {
  const comp = (id: string, kind: string, d: number, over: Partial<CartComponent> = {}): CartComponent => ({
    id, kind, liabilityClass: "income", principalCents: d, distributableCents: d, residentEmail: "r@x.test", ...over,
  });
  it("spreads the fee over the fee-applicable charges only and sums exactly", () => {
    const components = [comp("b", "rent", 60_000), comp("a", "rent", 40_001), comp("c", "late_fee", 5_000), comp("d", "security_deposit", 90_000, { liabilityClass: "deposit" })];
    const cart = computeCartFee({ terms: terms(), cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 100_001, leasingBase: 0 });
    const split = splitManagedCart(terms(), components, cart, new Set());
    expect(split.map((s) => s.id)).toEqual(["a", "b", "c", "d"]);
    expect(split.reduce((s, p) => s + p.feeCents, 0)).toBe(cart.monthlyFeeCents);
    expect(split.find((s) => s.id === "c")).toMatchObject({ feeCents: 0, ownerCents: 5_000, feeApplies: false });
    expect(split.find((s) => s.id === "d")).toMatchObject({ feeCents: 0, ownerCents: 0, depositCents: 90_000 });
    for (const s of split.filter((p) => p.liabilityClass === "income")) {
      expect(s.ownerCents + s.feeCents + s.leasingCents).toBe(s.distributableCents);
    }
  });
  it("an owner-borne processing fee comes off the distributable amount, not the owner's percent", () => {
    const c = comp("a", "rent", 99_000, { principalCents: 100_000 });
    const cart = computeCartFee({ terms: terms(), cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 99_000, leasingBase: 0 });
    const [s] = splitManagedCart(terms(), [c], cart, new Set());
    expect(s).toMatchObject({ feeCents: 9_900, ownerCents: 89_100, ownerBornCents: 1_000 });
  });
  it("puts the leasing fee on first-payment charges", () => {
    const t = terms({ leasingFeeBps: 1000 });
    const components = [comp("a", "first_month_rent", 100_000), comp("b", "rent", 100_000)];
    const cart = computeCartFee({ terms: t, cumBaseBefore: 0, monthlyFeeTakenBefore: 0, applicableBase: 200_000, leasingBase: 100_000 });
    const split = splitManagedCart(t, components, cart, new Set(["a"]));
    expect(split.find((s) => s.id === "a")!.leasingCents).toBe(10_000);
    expect(split.find((s) => s.id === "b")!.leasingCents).toBe(0);
  });
});

describe("spreadByWeight", () => {
  it("sums exactly and is stable on ties", () => {
    const parts = [{ id: "c", weight: 10_000 }, { id: "a", weight: 10_000 }, { id: "b", weight: 10_000 }];
    const out = spreadByWeight(parts, 100);
    expect(out.map((p) => p.cents)).toEqual([34, 33, 33]);
    expect(spreadByWeight(parts, 100)).toEqual(out);
  });
  it("refuses more than the weight", () => {
    expect(() => spreadByWeight([{ id: "a", weight: 10 }], 11)).toThrow();
  });
});

describe("refunds reverse pro rata", () => {
  it("a full refund reverses everything exactly", () => {
    expect(refundSplit({ amountCents: 100_001, remainingPrincipalCents: 100_001, remainingFeeCents: 10_000, remainingOwnerCents: 90_001, remainingBorneCents: 0 }))
      .toEqual({ feeCents: 10_000, borneCents: 0, ownerCents: 90_001 });
  });
  it("a quarter refund reverses a quarter of the fee, rounded half up", () => {
    expect(refundSplit({ amountCents: 25_001, remainingPrincipalCents: 100_001, remainingFeeCents: 10_000, remainingOwnerCents: 90_001, remainingBorneCents: 0 }))
      .toEqual({ feeCents: 2_500, borneCents: 0, ownerCents: 22_501 });
  });
  it("two partial refunds then the rest add up to the original split", () => {
    let remaining = { p: 100_001, f: 10_000, o: 90_001, b: 0 };
    let fee = 0, owner = 0;
    for (const amount of [25_001, 30_000, remaining.p - 55_001]) {
      const r = refundSplit({ amountCents: amount, remainingPrincipalCents: remaining.p, remainingFeeCents: remaining.f, remainingOwnerCents: remaining.o, remainingBorneCents: remaining.b });
      fee += r.feeCents; owner += r.ownerCents;
      remaining = { p: remaining.p - amount, f: remaining.f - r.feeCents, o: remaining.o - r.ownerCents, b: remaining.b - r.borneCents };
    }
    expect({ fee, owner, left: remaining.p }).toEqual({ fee: 10_000, owner: 90_001, left: 0 });
  });
  it("refuses a refund above what remains", () => {
    expect(() => refundSplit({ amountCents: 11, remainingPrincipalCents: 10, remainingFeeCents: 1, remainingOwnerCents: 9, remainingBorneCents: 0 })).toThrow();
  });
});

describe("validation, hashing, copy", () => {
  it("accepts sane terms and rejects out-of-range ones", () => {
    expect(validateManagedFeeTerms(terms())).toBeNull();
    expect(validateManagedFeeTerms(terms({ ownerShareBps: 4999 }))).toMatch(/50%/);
    expect(validateManagedFeeTerms(terms({ ownerShareBps: 10_001 }))).toMatch(/100%/);
    expect(validateManagedFeeTerms(terms({ leasingFeeBps: 10_001 }))).toMatch(/leasing/);
    expect(validateManagedFeeTerms(terms({ minFeeCents: 600_000 }))).toMatch(/minimum/);
    expect(validateManagedFeeTerms(terms({ repairApprovalThresholdCents: -1 }))).toMatch(/repair/);
  });
  // Canonical v3 (review fix, Oct 20): the repair-approval threshold decides how large a vendor bill is posted
  // against the owner WITHOUT asking her, and the reserve target is part of the agreement she reads. Outside the
  // hash, an admin could raise either one between her page's load and her signature and have it activate under it.
  it("the hash covers every term of the agreement, the repair threshold and reserve included", () => {
    const base = { workspaceId: "w", ownerUserId: "u", terms: terms(), effectiveFrom: "2026-11-01" };
    const h = (over: Partial<typeof base> = {}, t: Partial<ManagedFeeTerms> = {}) =>
      policyTermsSha256(canonicalPolicyTerms({ ...base, ...over, terms: terms(t) }));
    expect(h()).toBe(h());
    expect(h({}, { ownerShareBps: 8999 })).not.toBe(h());
    expect(h({ effectiveFrom: "2026-11-02" })).not.toBe(h());
    expect(h({}, { repairApprovalThresholdCents: 1 })).not.toBe(h());
    expect(h({}, { reserveTargetCents: 1 })).not.toBe(h());
    expect(h({ workspaceId: "other" })).not.toBe(h());
  });
  it("names its version, so a stored hash is never compared across canonical shapes", () => {
    const canonical = canonicalPolicyTerms({ workspaceId: "w", ownerUserId: "u", terms: terms(), effectiveFrom: "2026-11-01" });
    expect(JSON.parse(canonical)).toMatchObject({ v: 3, reserveTargetCents: 0, repairApprovalThresholdCents: 25_000 });
  });
  it("describes the split in plain English", () => {
    expect(describeManagedFee(terms())).toBe("You receive 90%, PropLane keeps 10% of rent");
    expect(describeManagedFee(terms({ ownerShareBps: 8750, appliesTo: "all", leasingFeeBps: 5000, minFeeCents: 10_000 })))
      .toBe("You receive 87.50%, PropLane keeps 12.50% of everything collected, plus 50% leasing fee on a first month, $100 monthly minimum");
  });
  it("rounds half up on integer cents", () => {
    expect(roundHalfUpDiv(5, 10)).toBe(1);
    expect(roundHalfUpDiv(4, 10)).toBe(0);
    expect(() => roundHalfUpDiv(-1, 10)).toThrow();
  });
});

describe("Pacific months", () => {
  it("uses the Pacific calendar, not UTC", () => {
    expect(pacificMonthKey("2026-11-01T06:59:00Z")).toBe("2026-10");
    expect(pacificMonthKey("2026-11-01T08:00:00Z")).toBe("2026-11");
  });
  it("steps across a year and finds month starts through a DST change", () => {
    expect(previousMonthKey("2027-01")).toBe("2026-12");
    expect(nextMonthKey("2026-12")).toBe("2027-01");
    expect(pacificMonthStartIso("2026-10")).toBe("2026-10-01T07:00:00.000Z"); // PDT
    expect(pacificMonthStartIso("2026-12")).toBe("2026-12-01T08:00:00.000Z"); // PST
  });
});
