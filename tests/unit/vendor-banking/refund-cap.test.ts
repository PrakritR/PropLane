import { describe, expect, it } from "vitest";
import {
  computeVendorRefundCap,
  maxGrossForNetCents,
  refundFeeShareCents,
  refundNetDebitCents,
  vendorRefundAttemptKey,
} from "@/lib/vendor-banking/refund-cap";

// $205.00 payment, 3% fee = $6.15. The vendor holds $198.85.
const payout = { amountCents: 20_500, platformFeeCents: 615, refundedGrossCents: 0 };
const none = { heldCents: 0, transferredOutstandingCents: 0, availableBalanceCents: 0, frozenCents: 0 };

describe("refund fee share + net debit", () => {
  it("returns the proportional fee: $50.00 refunded returns $1.50 and costs $48.50", () => {
    expect(refundFeeShareCents(payout, 5_000)).toBe(150);
    expect(refundNetDebitCents(payout, 5_000)).toBe(4_850);
  });

  it("partials add up to exactly the fee on the whole payment (no rounding drift)", () => {
    let refunded = 0;
    let fee = 0;
    for (const slice of [3_333, 7_001, 9_000, 1_166]) {
      fee += refundFeeShareCents({ ...payout, refundedGrossCents: refunded }, slice);
      refunded += slice;
    }
    expect(refunded).toBe(20_500);
    expect(fee).toBe(615);
  });
});

describe("computeVendorRefundCap", () => {
  it("refunds in full from money still held on PropLane", () => {
    const cap = computeVendorRefundCap(payout, { ...none, heldCents: 19_885 });
    expect(cap).toMatchObject({ maxGrossCents: 20_500, refusal: null });
  });

  it("refunds from the released balance while it is still in the account", () => {
    const cap = computeVendorRefundCap(payout, { ...none, transferredOutstandingCents: 19_885, availableBalanceCents: 19_885 });
    expect(cap).toMatchObject({ maxGrossCents: 20_500, refusal: null });
  });

  it("caps a partly-withdrawn payment at what the account still holds", () => {
    const cap = computeVendorRefundCap(payout, { ...none, transferredOutstandingCents: 19_885, availableBalanceCents: 4_850 });
    expect(cap.refusal).toBeNull();
    expect(cap.maxGrossCents).toBe(maxGrossForNetCents(payout, 4_850));
    expect(refundNetDebitCents(payout, cap.maxGrossCents)).toBeLessThanOrEqual(4_850);
    expect(refundNetDebitCents(payout, cap.maxGrossCents + 1)).toBeGreaterThan(4_850);
  });

  it("REFUSES a payment whose released money was already withdrawn", () => {
    const cap = computeVendorRefundCap(payout, { ...none, transferredOutstandingCents: 19_885, availableBalanceCents: 0 });
    expect(cap).toMatchObject({ maxGrossCents: 0, refusal: "withdrawn" });
  });

  it("an unrelated balance never lifts the cap past this job's own released money", () => {
    const cap = computeVendorRefundCap(payout, { ...none, transferredOutstandingCents: 1_000, availableBalanceCents: 500_000 });
    expect(refundNetDebitCents(payout, cap.maxGrossCents)).toBeLessThanOrEqual(1_000);
  });

  it("adds held and released money together", () => {
    const cap = computeVendorRefundCap(payout, { ...none, heldCents: 10_000, transferredOutstandingCents: 9_885, availableBalanceCents: 9_885 });
    expect(cap.maxGrossCents).toBe(20_500);
  });

  it("is capped at what is left to refund after an earlier partial", () => {
    const cap = computeVendorRefundCap({ ...payout, refundedGrossCents: 5_000 }, { ...none, heldCents: 19_885 });
    expect(cap.maxGrossCents).toBe(15_500);
  });

  it("refuses a fully refunded payment", () => {
    const cap = computeVendorRefundCap({ ...payout, refundedGrossCents: 20_500 }, { ...none, heldCents: 100 });
    expect(cap.refusal).toBe("fully_refunded");
  });

  it("an open dispute freezes its amount out of the recoverable money", () => {
    const cap = computeVendorRefundCap(payout, { ...none, heldCents: 19_885, frozenCents: 19_885 });
    expect(cap).toMatchObject({ maxGrossCents: 0, refusal: "frozen" });
    const partial = computeVendorRefundCap(payout, { ...none, heldCents: 19_885, frozenCents: 15_000 });
    expect(refundNetDebitCents(payout, partial.maxGrossCents)).toBeLessThanOrEqual(4_885);
  });
});

describe("vendorRefundAttemptKey", () => {
  it("is stable for the same payment and client key, and differs across either", () => {
    const a = vendorRefundAttemptKey("p1", "abcdef12-3456");
    expect(a).toBe(vendorRefundAttemptKey("p1", "abcdef12-3456"));
    expect(a).not.toBe(vendorRefundAttemptKey("p2", "abcdef12-3456"));
    expect(a).not.toBe(vendorRefundAttemptKey("p1", "abcdef12-9999"));
  });

  it("refuses a missing, short or odd client key", () => {
    expect(vendorRefundAttemptKey("p1", "")).toBeNull();
    expect(vendorRefundAttemptKey("p1", "short")).toBeNull();
    expect(vendorRefundAttemptKey("p1", "has spaces and ;;; chars")).toBeNull();
  });
});
