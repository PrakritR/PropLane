import { describe, expect, it } from "vitest";
import {
  COMMS_INCLUDED_ALLOWANCE_CENTS,
  billableCentsAboveAllowance,
  commsAllowanceBlockedMessage,
  evaluateCommsAllowance,
  includedAllowanceCents,
  normalizeCommsPlanTier,
} from "@/lib/comms-billing/allowances";

describe("included allowance by plan", () => {
  it("gives every paid plan a real allowance, rising with price; Free has none", () => {
    // Round 3 plan model: Free carries $0 of communication credit and no
    // work number — texting and calling start on Pro.
    expect(includedAllowanceCents("free")).toBe(0);
    expect(includedAllowanceCents("pro")).toBeGreaterThan(includedAllowanceCents("free")!);
    // Business is CAPPED, not uncapped. "No limit" is not a price, it is an
    // unbounded liability on a fixed fee — and it removes the only signal that
    // an account has started doing something nobody priced. The cap sits far
    // above real use, and with a card on file passing it bills, not blocks.
    expect(includedAllowanceCents("business")).toBeGreaterThan(includedAllowanceCents("pro")!);
  });

  it("treats an unknown or missing plan as Free — the smallest allowance", () => {
    for (const raw of [null, undefined, "", "enterprise", "trial"]) {
      expect(normalizeCommsPlanTier(raw)).toBe("free");
    }
  });
});

describe("evaluateCommsAllowance", () => {
  it("lets a manager with NO card send inside the allowance", () => {
    const state = evaluateCommsAllowance({ tier: "pro", usedCents: 100, hasPaymentMethod: false });
    expect(state.blocked).toBe(false);
    expect(state.exhausted).toBe(false);
    expect(state.remainingCents).toBe(COMMS_INCLUDED_ALLOWANCE_CENTS.pro! - 100);
  });

  it("blocks Free from the first cent unless a pack was bought", () => {
    expect(evaluateCommsAllowance({ tier: "free", usedCents: 0, hasPaymentMethod: true }).blocked).toBe(true);
    const withPack = evaluateCommsAllowance({ tier: "free", usedCents: 100, hasPaymentMethod: false, purchasedRemainingCents: 500 });
    expect(withPack.blocked).toBe(false);
    expect(withPack.remainingCents).toBe(400);
  });

  it("BLOCKS once the allowance is spent and there is no card", () => {
    const state = evaluateCommsAllowance({
      tier: "free",
      usedCents: COMMS_INCLUDED_ALLOWANCE_CENTS.free!,
      hasPaymentMethod: false,
    });
    expect(state.exhausted).toBe(true);
    expect(state.blocked).toBe(true);
  });

  it("blocks at exhaustion even with a saved card", () => {
    const state = evaluateCommsAllowance({
      tier: "free",
      usedCents: COMMS_INCLUDED_ALLOWANCE_CENTS.free! * 10,
      hasPaymentMethod: true,
    });
    expect(state.exhausted).toBe(true);
    expect(state.blocked).toBe(true);
  });

  it("blocks Business at exhaustion even with a saved card", () => {
    const state = evaluateCommsAllowance({
      tier: "business",
      usedCents: 1_000_000,
      hasPaymentMethod: true,
    });
    expect(state.blocked).toBe(true);
    expect(state.exhausted).toBe(true);
  });

  it("still stops a Business account with no card once its cap is spent", () => {
    const state = evaluateCommsAllowance({
      tier: "business",
      usedCents: 1_000_000,
      hasPaymentMethod: false,
    });
    expect(state.blocked).toBe(true);
  });

  it("leaves Business plenty of headroom before any of that applies", () => {
    const state = evaluateCommsAllowance({
      tier: "business",
      usedCents: 5_000,
      hasPaymentMethod: false,
    });
    expect(state.exhausted).toBe(false);
    expect(state.blocked).toBe(false);
  });

  it("never reports a negative remainder", () => {
    const state = evaluateCommsAllowance({ tier: "pro", usedCents: 99_999, hasPaymentMethod: true });
    expect(state.remainingCents).toBe(0);
  });
});

describe("billableCentsAboveAllowance", () => {
  it("bills nothing inside the allowance", () => {
    expect(billableCentsAboveAllowance({ tier: "pro", totalUsedCents: 100 })).toBe(0);
  });

  it("bills only the excess, not the whole month", () => {
    const pro = COMMS_INCLUDED_ALLOWANCE_CENTS.pro!;
    expect(billableCentsAboveAllowance({ tier: "pro", totalUsedCents: pro + 250 })).toBe(250);
  });

  it("bills Business only above its cap", () => {
    const cap = includedAllowanceCents("business")!;
    expect(billableCentsAboveAllowance({ tier: "business", totalUsedCents: cap })).toBe(0);
    expect(billableCentsAboveAllowance({ tier: "business", totalUsedCents: cap + 250 })).toBe(250);
  });
});

describe("the blocked message", () => {
  it("names the amount and the fix, not just a refusal", () => {
    const msg = commsAllowanceBlockedMessage("pro");
    expect(msg).toMatch(/\$\d/);
    expect(msg).toMatch(/buy more usage/i);
  });

  it("tells a Free account the fix is Pro, not a pack alone", () => {
    expect(commsAllowanceBlockedMessage("free")).toMatch(/upgrade to pro/i);
  });
});
