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
  it("gives every plan a real allowance, rising with price", () => {
    expect(includedAllowanceCents("free")).toBeGreaterThan(0);
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
    const state = evaluateCommsAllowance({ tier: "free", usedCents: 100, hasPaymentMethod: false });
    expect(state.blocked).toBe(false);
    expect(state.exhausted).toBe(false);
    expect(state.remainingCents).toBe(COMMS_INCLUDED_ALLOWANCE_CENTS.free! - 100);
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

  it("does NOT block past the allowance when a card is on file — it just bills", () => {
    const state = evaluateCommsAllowance({
      tier: "free",
      usedCents: COMMS_INCLUDED_ALLOWANCE_CENTS.free! * 10,
      hasPaymentMethod: true,
    });
    expect(state.exhausted).toBe(true);
    expect(state.blocked).toBe(false);
  });

  it("does not block a Business account that has a card, however much it uses", () => {
    const state = evaluateCommsAllowance({
      tier: "business",
      usedCents: 1_000_000,
      hasPaymentMethod: true,
    });
    expect(state.blocked).toBe(false);
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
    expect(billableCentsAboveAllowance({ tier: "free", totalUsedCents: 100 })).toBe(0);
  });

  it("bills only the excess, not the whole month", () => {
    const free = COMMS_INCLUDED_ALLOWANCE_CENTS.free!;
    expect(billableCentsAboveAllowance({ tier: "free", totalUsedCents: free + 250 })).toBe(250);
  });

  it("bills Business only above its cap", () => {
    const cap = includedAllowanceCents("business")!;
    expect(billableCentsAboveAllowance({ tier: "business", totalUsedCents: cap })).toBe(0);
    expect(billableCentsAboveAllowance({ tier: "business", totalUsedCents: cap + 250 })).toBe(250);
  });
});

describe("the blocked message", () => {
  it("names the amount and the fix, not just a refusal", () => {
    const msg = commsAllowanceBlockedMessage("free");
    expect(msg).toMatch(/\$\d/);
    expect(msg).toMatch(/add a card/i);
  });
});
