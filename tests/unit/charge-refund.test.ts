/**
 * Deciding whether a paid rent/fee charge may be refunded (C023).
 *
 * Same discipline as `deposit-return.test.ts`: mostly about what the decision REFUSES, since
 * Stripe will not un-refund. `decideChargeRefund` deliberately carries no time-window cap (C099).
 */
import { describe, expect, it } from "vitest";
import {
  chargeRefundIdempotencyKey,
  chargeRefundRemainingCents,
  decideChargeRefund,
  type ChargeRefundContext,
} from "@/lib/charge-refund";

const paid = (over: Partial<ChargeRefundContext> = {}): ChargeRefundContext => ({
  kind: "rent",
  status: "paid",
  paidCents: 90_000,
  alreadyRefundedCents: 0,
  stripeChargeId: "ch_1",
  settled: true,
  ...over,
});

describe("refunding the whole charge", () => {
  it("refunds everything paid when no amount is given", () => {
    expect(decideChargeRefund(paid())).toEqual({
      ok: true,
      amountCents: 90_000,
      remainingAfterCents: 0,
      stripeChargeId: "ch_1",
    });
  });

  it("refunds only what is LEFT after an earlier partial refund", () => {
    const decision = decideChargeRefund(paid({ alreadyRefundedCents: 30_000 }));
    expect(decision).toMatchObject({ ok: true, amountCents: 60_000, remainingAfterCents: 0 });
  });
});

describe("partial refunds", () => {
  it("allows a partial refund and reports what stays refundable", () => {
    expect(decideChargeRefund(paid(), 20_000)).toMatchObject({
      ok: true,
      amountCents: 20_000,
      remainingAfterCents: 70_000,
    });
  });

  it("refuses more than remains", () => {
    expect(decideChargeRefund(paid({ alreadyRefundedCents: 85_000 }), 10_000)).toMatchObject({
      ok: false,
      reason: "amount_exceeds_remaining",
    });
  });

  it("refuses zero and negative rather than reading them as 'all of it'", () => {
    expect(decideChargeRefund(paid(), 0)).toMatchObject({ ok: false, reason: "amount_not_positive" });
    expect(decideChargeRefund(paid(), -1)).toMatchObject({ ok: false, reason: "amount_not_positive" });
  });
});

describe("what it will not touch", () => {
  it("refuses a security deposit — that keeps its own Return-deposit flow", () => {
    expect(decideChargeRefund(paid({ kind: "security_deposit" }))).toMatchObject({
      ok: false,
      reason: "is_a_deposit",
    });
  });

  it("refuses a charge that was never paid", () => {
    for (const status of ["pending", "overdue", "failed", "void"]) {
      expect(decideChargeRefund(paid({ status }))).toMatchObject({ ok: false, reason: "not_paid" });
    }
  });

  it("refuses an unsettled payment", () => {
    expect(decideChargeRefund(paid({ settled: false }))).toMatchObject({ ok: false, reason: "not_settled" });
  });

  it("refuses a charge with no Stripe payment behind it", () => {
    expect(decideChargeRefund(paid({ stripeChargeId: null }))).toMatchObject({
      ok: false,
      reason: "no_stripe_payment",
    });
  });

  it("refuses a charge already refunded in full", () => {
    expect(decideChargeRefund(paid({ alreadyRefundedCents: 90_000 }))).toMatchObject({
      ok: false,
      reason: "nothing_left",
    });
  });

  it("has no time-window cap (C099: matches the real Stripe-refund path, as built)", () => {
    // No "issued at" / "days since payment" field exists on the context at all — there is
    // nothing this decision COULD check a window against, by design.
    const ctx: ChargeRefundContext = paid();
    expect(Object.keys(ctx)).not.toContain("paidAt");
    expect(Object.keys(ctx)).not.toContain("issuedAt");
    expect(decideChargeRefund(ctx).ok).toBe(true);
  });
});

describe("chargeRefundRemainingCents", () => {
  it("never goes below zero", () => {
    expect(chargeRefundRemainingCents({ paidCents: 100, alreadyRefundedCents: 500 })).toBe(0);
  });
});

describe("chargeRefundIdempotencyKey", () => {
  it("varies by charge, amount and attempt so a genuine second refund is still possible", () => {
    const a = chargeRefundIdempotencyKey({ chargeId: "c1", amountCents: 100, attempt: 1 });
    const b = chargeRefundIdempotencyKey({ chargeId: "c1", amountCents: 100, attempt: 2 });
    expect(a).not.toBe(b);
  });
});
