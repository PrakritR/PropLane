import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { createAxisConnectAccount } from "@/lib/stripe-connect";

/**
 * VD39: a NEW vendor Stripe Connect account defaults to manual payouts
 * ("only when the vendor presses Withdraw") once VENDOR_BANKING_ENABLED is
 * on (default ON, captain 2026-09-28). Every other case — a manager account,
 * or a vendor account created with the flag explicitly off — keeps today's
 * automatic weekly Friday schedule, byte-for-byte.
 */
describe("createAxisConnectAccount — payout schedule default", () => {
  const PREV = process.env.VENDOR_BANKING_ENABLED;

  beforeEach(() => {
    // Default ON: tests that need the flag OFF must say so explicitly.
    process.env.VENDOR_BANKING_ENABLED = "0";
  });
  afterEach(() => {
    if (PREV === undefined) delete process.env.VENDOR_BANKING_ENABLED;
    else process.env.VENDOR_BANKING_ENABLED = PREV;
  });

  function captureStripe() {
    const calls: Record<string, unknown>[] = [];
    const stripe = {
      accounts: {
        create: async (params: Record<string, unknown>) => {
          calls.push(params);
          return { id: "acct_test" } as Stripe.Account;
        },
      },
    } as unknown as Stripe;
    return { stripe, calls };
  }

  it("vendor account, flag explicitly OFF ('0'): weekly/Friday (unchanged)", async () => {
    const { stripe, calls } = captureStripe();
    await createAxisConnectAccount(stripe, { axisUserId: "u1", axisPortal: "vendor" });
    expect((calls[0]!.settings as { payouts: { schedule: unknown } }).payouts.schedule).toEqual({
      interval: "weekly",
      weekly_anchor: "friday",
    });
  });

  it("vendor account, flag unset (default ON): manual", async () => {
    delete process.env.VENDOR_BANKING_ENABLED;
    const { stripe, calls } = captureStripe();
    await createAxisConnectAccount(stripe, { axisUserId: "u1", axisPortal: "vendor" });
    expect((calls[0]!.settings as { payouts: { schedule: unknown } }).payouts.schedule).toEqual({
      interval: "manual",
    });
  });

  it("vendor account, flag ON: manual", async () => {
    process.env.VENDOR_BANKING_ENABLED = "1";
    const { stripe, calls } = captureStripe();
    await createAxisConnectAccount(stripe, { axisUserId: "u1", axisPortal: "vendor" });
    expect((calls[0]!.settings as { payouts: { schedule: unknown } }).payouts.schedule).toEqual({
      interval: "manual",
    });
  });

  it("manager account, flag ON: still weekly/Friday — the flag only ever touches vendor accounts", async () => {
    process.env.VENDOR_BANKING_ENABLED = "1";
    const { stripe, calls } = captureStripe();
    await createAxisConnectAccount(stripe, { axisUserId: "u1", axisPortal: "portal" });
    expect((calls[0]!.settings as { payouts: { schedule: unknown } }).payouts.schedule).toEqual({
      interval: "weekly",
      weekly_anchor: "friday",
    });
  });

  it("axisPortal omitted (defaults to manager), flag ON: still weekly/Friday", async () => {
    process.env.VENDOR_BANKING_ENABLED = "1";
    const { stripe, calls } = captureStripe();
    await createAxisConnectAccount(stripe, { axisUserId: "u1" });
    expect((calls[0]!.settings as { payouts: { schedule: unknown } }).payouts.schedule).toEqual({
      interval: "weekly",
      weekly_anchor: "friday",
    });
  });
});
