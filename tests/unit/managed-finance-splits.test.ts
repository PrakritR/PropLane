import { describe, expect, it } from "vitest";
import {
  computeSplit,
  reversalTargetCents,
  ruleActiveAt,
  rulesForPayment,
  validateSplitRule,
  type SplitRule,
  type SplitRuleDraft,
  type SplitValidationContext,
} from "@/lib/managed-finance/splits";

const KINDS = ["rent", "first_month_rent", "prorated_rent", "prorated_last_month_rent", "stay_total"];
let n = 0;
const rule = (over: Partial<SplitRule> = {}): SplitRule => ({
  id: `r${++n}`, workspaceId: "ws", propertyId: null, ruleKind: "percent", appliesTo: KINDS, payeeKind: "member", payeeUserId: "m1",
  bps: 1500, fixedCents: null, effectiveFrom: "2026-01-01T00:00:00Z", endedAt: null, createdAt: `2026-01-01T00:00:0${n % 10}Z`, ...over,
});
const pay = (over: Record<string, unknown> = {}) => ({ chargeKind: "rent", propertyId: "p1", ownerCents: 90_000, paidAt: "2026-06-01T12:00:00Z", ...over });

describe("computeSplit: integer cents, owner keeps the remainder", () => {
  it("15% of an owner share of $900 is $135 and the owner keeps $765", () => {
    const r = computeSplit([rule()], pay());
    expect(r.shares.map((s) => s.cents)).toEqual([13_500]);
    expect(r.ownerRemainderCents).toBe(76_500);
  });

  it("floors odd cents and the remainder goes to the owner: shares + remainder always equal the owner share", () => {
    for (const owner of [1, 7, 99, 101, 12_345, 90_001, 1_000_003]) {
      const r = computeSplit([rule({ bps: 3333 }), rule({ bps: 3333, payeeUserId: "m2" }), rule({ ruleKind: "fixed", bps: null, fixedCents: 777, payeeUserId: "m3" })], pay({ ownerCents: owner }));
      expect(r.shares.reduce((s, x) => s + x.cents, 0) + r.ownerRemainderCents).toBe(owner);
      expect(r.ownerRemainderCents).toBeGreaterThanOrEqual(0);
      for (const s of r.shares) expect(Number.isInteger(s.cents)).toBe(true);
    }
  });

  it("a fixed rule is capped at what is left, never negative", () => {
    const r = computeSplit([rule({ ruleKind: "fixed", bps: null, fixedCents: 50_000 })], pay({ ownerCents: 12_000 }));
    expect(r.shares.map((s) => s.cents)).toEqual([12_000]);
    expect(r.ownerRemainderCents).toBe(0);
  });

  it("percent rules come off the owner's share, then fixed rules from what remains", () => {
    const r = computeSplit(
      [rule({ bps: 5000 }), rule({ ruleKind: "fixed", bps: null, fixedCents: 10_000, payeeUserId: "m2" })],
      pay({ ownerCents: 90_000 }),
    );
    expect(r.shares.map((s) => [s.payeeUserId, s.cents])).toEqual([["m1", 45_000], ["m2", 10_000]]);
    expect(r.ownerRemainderCents).toBe(35_000);
  });

  it("ignores a charge kind the rule does not name (a deposit is never split)", () => {
    expect(computeSplit([rule()], pay({ chargeKind: "security_deposit" })).shares).toEqual([]);
  });

  it("a zero owner share produces nothing", () => {
    expect(computeSplit([rule()], pay({ ownerCents: 0 }))).toEqual({ shares: [], ownerRemainderCents: 0 });
  });

  it("refuses a fractional or negative owner share", () => {
    expect(() => computeSplit([rule()], pay({ ownerCents: 10.5 }))).toThrow();
    expect(() => computeSplit([rule()], pay({ ownerCents: -1 }))).toThrow();
  });
});

describe("effective dating: a rule applies to money paid after it started and before it ended", () => {
  const live = rule({ effectiveFrom: "2026-06-01T00:00:00Z", endedAt: "2026-07-01T00:00:00Z" });
  it("is read AS OF the payment date, never now", () => {
    expect(ruleActiveAt(live, "2026-05-31T23:59:59Z")).toBe(false);
    expect(ruleActiveAt(live, "2026-06-01T00:00:00Z")).toBe(true);
    expect(ruleActiveAt(live, "2026-06-30T23:59:59Z")).toBe(true);
    expect(ruleActiveAt(live, "2026-07-01T00:00:00Z")).toBe(false);
  });
  it("a payment made before the rule existed is never split, even when it settles after", () => {
    expect(computeSplit([live], pay({ paidAt: "2026-05-15T00:00:00Z" })).shares).toEqual([]);
  });
  it("a payment made while the rule was in force still splits after the rule ended", () => {
    expect(computeSplit([live], pay({ paidAt: "2026-06-20T00:00:00Z" })).shares).toHaveLength(1);
  });
  it("an invalid date never matches", () => {
    expect(ruleActiveAt(live, "not a date")).toBe(false);
  });
});

describe("per-house override", () => {
  const all = rule({ id: "ws-rule", bps: 1000, payeeUserId: "m1" });
  const house = rule({ id: "house-rule", propertyId: "p1", bps: 2500, payeeUserId: "m2" });
  it("a rule scoped to the house REPLACES the workspace rules for that house", () => {
    expect(rulesForPayment([all, house], pay({ propertyId: "p1" })).map((r) => r.id)).toEqual(["house-rule"]);
  });
  it("another house keeps the workspace rules", () => {
    expect(rulesForPayment([all, house], pay({ propertyId: "p2" })).map((r) => r.id)).toEqual(["ws-rule"]);
  });
  it("an ended house rule hands the house back to the workspace rules", () => {
    expect(rulesForPayment([all, { ...house, endedAt: "2026-05-01T00:00:00Z" }], pay({ propertyId: "p1" })).map((r) => r.id)).toEqual(["ws-rule"]);
  });
});

describe("validateSplitRule", () => {
  const draft = (over: Partial<SplitRuleDraft> = {}): SplitRuleDraft => ({
    propertyId: null, ruleKind: "percent", appliesTo: ["rent"], payeeKind: "member", payeeUserId: "m1", bps: 1500, fixedCents: null, ...over,
  });
  const ctx = (over: Partial<SplitValidationContext> = {}): SplitValidationContext => ({
    activeRules: [], ownerUserId: "owner", payeeIsWorkspaceMember: true, payeeIsVendorWithConnectedAccount: false, propertyInWorkspace: true, ...over,
  });
  it("accepts a plain team-member percent", () => {
    expect(validateSplitRule(draft(), ctx())).toBeNull();
  });
  it("total percent may never pass 100% of the owner's share", () => {
    const existing = [rule({ bps: 9000, appliesTo: ["rent"] })];
    expect(validateSplitRule(draft({ bps: 1001 }), ctx({ activeRules: existing }))).toMatch(/more than 100%/);
    expect(validateSplitRule(draft({ bps: 1000 }), ctx({ activeRules: existing }))).toBeNull();
  });
  it("percent rules on different charge kinds do not add up against each other", () => {
    const existing = [rule({ bps: 9000, appliesTo: ["stay_total"] })];
    expect(validateSplitRule(draft({ bps: 5000, appliesTo: ["rent"] }), ctx({ activeRules: existing }))).toBeNull();
  });
  it("a house override is checked against that house's own rules, not the workspace's", () => {
    const existing = [rule({ bps: 9500, propertyId: null })];
    expect(validateSplitRule(draft({ propertyId: "p1", bps: 9000 }), ctx({ activeRules: existing }))).toBeNull();
  });
  it("the payee must be a workspace member, or a vendor with a connected account", () => {
    expect(validateSplitRule(draft(), ctx({ payeeIsWorkspaceMember: false }))).toMatch(/team/);
    expect(validateSplitRule(draft({ payeeKind: "vendor" }), ctx())).toMatch(/payouts set up/);
    expect(validateSplitRule(draft({ payeeKind: "vendor" }), ctx({ payeeIsVendorWithConnectedAccount: true }))).toBeNull();
  });
  it("refuses the owner of record as a payee, a house outside the workspace, bad amounts and unknown charge kinds", () => {
    expect(validateSplitRule(draft({ payeeUserId: "owner" }), ctx())).toMatch(/owner/);
    expect(validateSplitRule(draft({ propertyId: "other" }), ctx({ propertyInWorkspace: false }))).toMatch(/house/);
    expect(validateSplitRule(draft({ bps: 0 }), ctx())).toMatch(/percent/);
    expect(validateSplitRule(draft({ bps: 10_001 }), ctx())).toMatch(/percent/);
    expect(validateSplitRule(draft({ bps: 150.5 }), ctx())).toMatch(/percent/);
    expect(validateSplitRule(draft({ ruleKind: "fixed", bps: null, fixedCents: 0 }), ctx())).toMatch(/dollar/);
    expect(validateSplitRule(draft({ ruleKind: "fixed", bps: 100, fixedCents: 500 }), ctx())).toMatch(/no percent/);
    expect(validateSplitRule(draft({ appliesTo: ["security_deposit"] }), ctx())).toMatch(/cannot be split/);
    expect(validateSplitRule(draft({ appliesTo: [] }), ctx())).toMatch(/applies to/);
  });
});

describe("reversalTargetCents: a refund takes back the same pro-rata share", () => {
  it("a full refund reverses the whole share exactly", () => {
    expect(reversalTargetCents({ shareCents: 13_501, ownerCents: 90_001, refundedOwnerCents: 90_001 })).toBe(13_501);
  });
  it("a half refund reverses about half, never more than the share", () => {
    expect(reversalTargetCents({ shareCents: 13_500, ownerCents: 90_000, refundedOwnerCents: 45_000 })).toBe(6_750);
    expect(reversalTargetCents({ shareCents: 5, ownerCents: 7, refundedOwnerCents: 6 })).toBeLessThanOrEqual(5);
  });
  it("nothing refunded reverses nothing", () => {
    expect(reversalTargetCents({ shareCents: 100, ownerCents: 1_000, refundedOwnerCents: 0 })).toBe(0);
  });
});
