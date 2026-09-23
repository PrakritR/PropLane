import { describe, expect, it } from "vitest";
import {
  applyHoldRefund,
  applyHoldTransfer,
  availableCentsFromHoldAndStripe,
  withdrawableCentsFromSnapshot,
  canCreditPlatformHold,
  holdsReadyToTransfer,
  payoutsAvailableNote,
  platformHoldCreditKey,
  sumHeldCents,
  type PlatformHoldRow,
} from "@/lib/stripe-platform-hold";

function hold(partial: Partial<PlatformHoldRow> & Pick<PlatformHoldRow, "id" | "sourceId">): PlatformHoldRow {
  return {
    ownerUserId: "mgr_1",
    ownerRole: "manager",
    source: "household_charge",
    amountCents: 120_000,
    status: "held",
    stripeChargeId: "ch_1",
    stripeTransferId: null,
    ...partial,
  };
}

describe("platform hold", () => {
  it("refuses a second credit for the same source id", () => {
    const existing = hold({ id: "h1", sourceId: "cs_abc" });
    expect(canCreditPlatformHold(existing)).toBe(false);
    expect(canCreditPlatformHold(null)).toBe(true);
    expect(platformHoldCreditKey("household_charge", "cs_abc")).toBe("household_charge:cs_abc");
  });

  it("sums only held rows", () => {
    const rows = [
      hold({ id: "a", sourceId: "1", amountCents: 100_000, status: "held" }),
      hold({ id: "b", sourceId: "2", amountCents: 40_000, status: "transferred" }),
      hold({ id: "c", sourceId: "3", amountCents: 24_000, status: "held" }),
    ];
    expect(sumHeldCents(rows)).toBe(124_000);
  });

  it("drains only held rows and marks them transferred once", () => {
    const held = hold({ id: "a", sourceId: "1" });
    const already = hold({ id: "b", sourceId: "2", status: "transferred", stripeTransferId: "tr_old" });
    const ready = holdsReadyToTransfer([held, already]);
    expect(ready).toEqual([held]);
    expect(applyHoldTransfer(held, "tr_new")).toEqual({
      ...held,
      status: "transferred",
      stripeTransferId: "tr_new",
    });
  });

  it("refunds a hold without transferring it", () => {
    const row = hold({ id: "a", sourceId: "1" });
    expect(applyHoldRefund(row).status).toBe("refunded");
  });

  it("adds held cents to the Stripe available figure", () => {
    expect(availableCentsFromHoldAndStripe(124_000, 0)).toBe(124_000);
    expect(availableCentsFromHoldAndStripe(24_000, 1_200_00)).toBe(144_000);
  });

  it("Withdraw uses Stripe-only cents, never a hold", () => {
    expect(withdrawableCentsFromSnapshot({ availableCents: 124_000, withdrawableCents: 0, heldCents: 124_000 })).toBe(0);
    expect(withdrawableCentsFromSnapshot({ availableCents: 428_000, withdrawableCents: 428_000 })).toBe(428_000);
    expect(withdrawableCentsFromSnapshot({ availableCents: 428_000 })).toBe(428_000);
  });

  it("names the Available line held vs on-Stripe", () => {
    expect(payoutsAvailableNote({ ready: false, heldCents: 1_240_00 })).toBe(
      "Held on PropLane until a bank is connected",
    );
    expect(payoutsAvailableNote({ ready: true, heldCents: 0, bankLabel: "Chase ··4291" })).toBe(
      "On your Stripe · Chase ··4291",
    );
  });
});
