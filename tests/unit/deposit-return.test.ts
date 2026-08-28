/**
 * Deciding whether a security deposit may be sent back.
 *
 * One button press moves real money to a real person and Stripe will not un-refund it, so this
 * suite is mostly about what the decision REFUSES. Every refusal below corresponds to a way a
 * manager could otherwise send money they do not have, send it twice, or send it against a
 * payment that never cleared.
 */
import { describe, expect, it } from "vitest";
import {
  decideDepositReturn,
  depositRemainingCents,
  depositReturnIdempotencyKey,
  type DepositReturnContext,
} from "@/lib/deposit-return";

const paid = (over: Partial<DepositReturnContext> = {}): DepositReturnContext => ({
  kind: "security_deposit",
  status: "paid",
  paidCents: 75_000,
  alreadyReturnedCents: 0,
  stripeChargeId: "ch_123",
  settled: true,
  ...over,
});

describe("returning the whole deposit", () => {
  it("returns everything held when no amount is given", () => {
    const decision = decideDepositReturn(paid());
    expect(decision).toEqual({
      ok: true,
      amountCents: 75_000,
      remainingAfterCents: 0,
      stripeChargeId: "ch_123",
    });
  });

  it("returns only what is LEFT after an earlier partial return", () => {
    // Not the original payment — otherwise two partial returns together exceed what was taken.
    const decision = decideDepositReturn(paid({ alreadyReturnedCents: 25_000 }));
    expect(decision).toMatchObject({ ok: true, amountCents: 50_000, remainingAfterCents: 0 });
  });
});

describe("partial returns", () => {
  it("allows a partial return and reports what stays held", () => {
    // Deposits are a liability; the remainder is still owed to the resident.
    expect(decideDepositReturn(paid(), 20_000)).toMatchObject({
      ok: true,
      amountCents: 20_000,
      remainingAfterCents: 55_000,
    });
  });

  it("refuses more than remains", () => {
    expect(decideDepositReturn(paid({ alreadyReturnedCents: 70_000 }), 10_000)).toMatchObject({
      ok: false,
      reason: "amount_exceeds_remaining",
    });
  });

  it("refuses zero and negative rather than reading them as 'all of it'", () => {
    // Absent means everything; an explicit zero is a mistake and must not become a full return.
    expect(decideDepositReturn(paid(), 0)).toMatchObject({ ok: false, reason: "amount_not_positive" });
    expect(decideDepositReturn(paid(), -5_000)).toMatchObject({ ok: false, reason: "amount_not_positive" });
  });
});

describe("what it will not touch", () => {
  it("refuses a charge that is not a deposit", () => {
    // Rent is the manager's income, not money held on someone's behalf.
    for (const kind of ["rent", "utilities", "processing", "late_fee"]) {
      expect(decideDepositReturn(paid({ kind }))).toMatchObject({ ok: false, reason: "not_a_deposit" });
    }
  });

  it("refuses a deposit that was never paid", () => {
    for (const status of ["pending", "overdue", "failed", "void"]) {
      expect(decideDepositReturn(paid({ status }))).toMatchObject({ ok: false, reason: "not_paid" });
    }
  });

  it("refuses a payment that has not cleared", () => {
    // An ACH debit can bounce days after it looks successful. Refunding first sends real money
    // against funds that never arrive, and the manager is left owing it.
    expect(decideDepositReturn(paid({ settled: false }))).toMatchObject({ ok: false, reason: "not_settled" });
  });

  it("refuses a deposit that did not come through Stripe", () => {
    // Cash or Zelle leaves nothing to refund against; it has to go back the way it came.
    for (const id of [null, "", "   "]) {
      expect(decideDepositReturn(paid({ stripeChargeId: id }))).toMatchObject({
        ok: false,
        reason: "no_stripe_payment",
      });
    }
  });

  it("refuses one already returned in full", () => {
    expect(decideDepositReturn(paid({ alreadyReturnedCents: 75_000 }))).toMatchObject({
      ok: false,
      reason: "nothing_left",
    });
    // And an over-return recorded by any means still reads as nothing left, never as negative.
    expect(decideDepositReturn(paid({ alreadyReturnedCents: 90_000 }))).toMatchObject({
      ok: false,
      reason: "nothing_left",
    });
  });

  it("explains every refusal in words a manager can act on", () => {
    const refusal = decideDepositReturn(paid({ settled: false }));
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) {
      expect(refusal.message).toMatch(/cleared/i);
      expect(refusal.message).not.toMatch(/null|undefined|cents/i);
    }
  });
});

describe("remaining balance", () => {
  it("never reports a negative balance", () => {
    expect(depositRemainingCents({ paidCents: 50_000, alreadyReturnedCents: 60_000 })).toBe(0);
  });
});

describe("not sending it twice", () => {
  it("gives two clicks on the same return the same key", () => {
    // A double click, or a retry after a timeout that actually succeeded, must not send it twice.
    const a = depositReturnIdempotencyKey({ chargeId: "c1", amountCents: 75_000, attempt: 1 });
    const b = depositReturnIdempotencyKey({ chargeId: "c1", amountCents: 75_000, attempt: 1 });
    expect(a).toBe(b);
  });

  it("still allows a genuine second partial return of the same size", () => {
    // Two $250 returns against one deposit are legitimate; keying on charge and amount alone
    // would silently swallow the second.
    const first = depositReturnIdempotencyKey({ chargeId: "c1", amountCents: 25_000, attempt: 1 });
    const second = depositReturnIdempotencyKey({ chargeId: "c1", amountCents: 25_000, attempt: 2 });
    expect(first).not.toBe(second);
  });

  it("keeps two different deposits apart", () => {
    expect(depositReturnIdempotencyKey({ chargeId: "c1", amountCents: 100, attempt: 1 })).not.toBe(
      depositReturnIdempotencyKey({ chargeId: "c2", amountCents: 100, attempt: 1 }),
    );
  });
});
