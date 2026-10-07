import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  axisResidentPaymentFeePlanLine,
  platformFeeCents,
  platformFeeDisplayPercents,
  vendorInstantWithdrawFeeCents,
  vendorPayFeeBps,
  vendorPayFeeCents,
  vendorPayFeeDisplayPercent,
  vendorServiceFeeDescription,
  PROPLANE_SERVICE_FEE_LABEL,
  VENDOR_PAY_FEE_BPS,
  VENDOR_SERVICE_FEE_RAILS,
  VENDOR_INSTANT_FEE_COLLECTABLE,
} from "@/lib/platform-fees";
import {
  residentConnectApplicationFeeCents,
  residentProcessingFeeCents,
} from "@/lib/payment-policy";

describe("platform-fees", () => {
  it("never takes a PropLane fee on any tier", () => {
    // PropLane takes 0% from resident/applicant transactions on every tier.
    expect(platformFeeCents(10000, "rent", "free")).toBe(0);
    expect(platformFeeCents(10000, "rent", "pro")).toBe(0);
    expect(platformFeeCents(10000, "rent", "business")).toBe(0);
    expect(platformFeeCents(10000, "application_fee", "free")).toBe(0);
    expect(platformFeeCents(0, "rent", "pro")).toBe(0);
    expect(platformFeeCents(-100, "rent", "pro")).toBe(0);
  });

  it("returns display percents (0 on every tier)", () => {
    expect(platformFeeDisplayPercents("free")).toEqual({ applicationFee: 0, rent: 0 });
    expect(platformFeeDisplayPercents("pro")).toEqual({ applicationFee: 0, rent: 0 });
    expect(platformFeeDisplayPercents("business")).toEqual({ applicationFee: 0, rent: 0 });
  });

  it("plan copy states no PropLane fee and never advertises a processing charge", () => {
    for (const tier of ["free", "pro", "business"] as const) {
      const line = axisResidentPaymentFeePlanLine(tier);
      expect(line).toContain("No PropLane fee");
      expect(line).toContain("PropLane covers payment processing");
      expect(line).not.toMatch(/residents pay processing/i);
    }
  });
});

describe("vendor pay take rate (VENDOR_BANKING_ENABLED)", () => {
  const PREV = process.env.VENDOR_BANKING_ENABLED;

  beforeEach(() => {
    // Default ON (captain, 2026-09-28): tests that need the flag OFF must
    // say so explicitly rather than relying on unset.
    process.env.VENDOR_BANKING_ENABLED = "0";
  });

  afterEach(() => {
    if (PREV === undefined) delete process.env.VENDOR_BANKING_ENABLED;
    else process.env.VENDOR_BANKING_ENABLED = PREV;
  });

  it("is 0 bps / 0 cents / 0% with the flag explicitly off ('0') — today's behavior, byte-for-byte", () => {
    expect(vendorPayFeeBps()).toBe(0);
    expect(vendorPayFeeCents(10_000)).toBe(0);
    expect(vendorPayFeeDisplayPercent()).toBe(0);
    expect(vendorInstantWithdrawFeeCents(10_000)).toBe(0);
  });

  it("is also off for 'false' and 'off'", () => {
    for (const value of ["false", "off", "FALSE", "OFF"]) {
      process.env.VENDOR_BANKING_ENABLED = value;
      expect(vendorPayFeeBps()).toBe(0);
    }
  });

  it("is 300 bps (3%) with the flag unset (default ON)", () => {
    delete process.env.VENDOR_BANKING_ENABLED;
    expect(vendorPayFeeBps()).toBe(300);
    expect(vendorPayFeeDisplayPercent()).toBe(3);
  });

  it("is 300 bps (3%) once the flag is on", () => {
    process.env.VENDOR_BANKING_ENABLED = "1";
    expect(vendorPayFeeBps()).toBe(300);
    expect(vendorPayFeeDisplayPercent()).toBe(3);
  });

  it("floors to the cent and never exceeds the gross amount", () => {
    process.env.VENDOR_BANKING_ENABLED = "1";
    expect(vendorPayFeeCents(10_000)).toBe(300); // exactly 3%
    expect(vendorPayFeeCents(10_001)).toBe(300); // floors, not rounds up
    expect(vendorPayFeeCents(3333)).toBe(99); // 99.99 -> floors to 99
    expect(vendorPayFeeCents(1)).toBe(0); // 0.03 -> floors to 0
    expect(vendorPayFeeCents(0)).toBe(0);
    expect(vendorPayFeeCents(-500)).toBe(0);
    expect(vendorPayFeeCents(Number.NaN)).toBe(0);
  });

  it("never goes negative or exceeds gross even at extreme inputs", () => {
    process.env.VENDOR_BANKING_ENABLED = "1";
    const gross = 7;
    const fee = vendorPayFeeCents(gross);
    expect(fee).toBeGreaterThanOrEqual(0);
    expect(fee).toBeLessThanOrEqual(gross);
  });

  it("Instant-withdraw fee is $0 while no collect mechanism exists, flag on or off", () => {
    process.env.VENDOR_BANKING_ENABLED = "1";
    expect(VENDOR_INSTANT_FEE_COLLECTABLE).toBe(false);
    for (const cents of [10_000, 1_000, 0, -100]) expect(vendorInstantWithdrawFeeCents(cents)).toBe(0);
    delete process.env.VENDOR_BANKING_ENABLED;
    expect(vendorInstantWithdrawFeeCents(10_000)).toBe(0);
  });
});

describe("PropLane service fee naming and rails", () => {
  const PREV = process.env.VENDOR_BANKING_ENABLED;
  beforeEach(() => {
    process.env.VENDOR_BANKING_ENABLED = "1";
  });
  afterEach(() => {
    if (PREV === undefined) delete process.env.VENDOR_BANKING_ENABLED;
    else process.env.VENDOR_BANKING_ENABLED = PREV;
  });

  it("has one vendor-facing label, and the description derives its percent from the rate constant", () => {
    expect(PROPLANE_SERVICE_FEE_LABEL).toBe("PropLane service fee");
    expect(VENDOR_PAY_FEE_BPS).toBe(300);
    expect(vendorServiceFeeDescription()).toBe("PropLane service fee (3%)");
  });

  it("the description is the frozen rate, not the live flag (a flag flip never relabels a settled fee)", () => {
    process.env.VENDOR_BANKING_ENABLED = "0";
    expect(vendorServiceFeeDescription()).toBe("PropLane service fee (3%)");
  });

  it("only the Stripe checkout rail carries the fee; offline and PropLane-balance are explicitly exempt", () => {
    expect([...VENDOR_SERVICE_FEE_RAILS]).toEqual(["stripe_checkout"]);
  });

  it("fee math is a pure function of the gross: it never mutates an accepted bid object", () => {
    const bid = Object.freeze({ amountCents: 12_500 });
    expect(vendorPayFeeCents(bid.amountCents)).toBe(375);
    expect(bid.amountCents).toBe(12_500);
  });
});

describe("resident payment fees", () => {
  it("the service fee is Stripe's real per-method cost", () => {
    expect(residentProcessingFeeCents(10000, "ach")).toBe(80); // 0.8%
    expect(residentProcessingFeeCents(10000, "card")).toBe(320); // 2.9% + $0.30
  });

  it("the retained application fee (resident-pays value) equals the service fee — the 0-bps platform take adds nothing", () => {
    expect(residentConnectApplicationFeeCents(10000, "ach", "free")).toBe(80);
    expect(residentConnectApplicationFeeCents(10000, "card", "business")).toBe(320);
  });
});
