import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notify }));

import { ensureAutomaticPayoutSchedule } from "@/lib/payout-schedule-default.server";
import { notifyOwnerOfFailedPayout, payoutFailureReason } from "@/lib/payout-failed-notice.server";
import { validateScheduleRequestBody } from "@/lib/stripe-payouts";
import { payoutMethodBankLabel } from "@/components/portal/portal-payout-method-card";

afterEach(() => { delete process.env.MANUAL_PAYOUT_POLICY_ENABLED; notify.mockReset(); });

const acct = (interval: string) => ({ id: "acct_1", settings: { payouts: { schedule: { interval } } } }) as never;

describe("automatic payout schedule on ready", () => {
  it("moves a manual account to weekly Monday on the same account", async () => {
    const update = vi.fn();
    expect(await ensureAutomaticPayoutSchedule({ accounts: { update } } as never, acct("manual"), { vendorOwned: false })).toBe(true);
    expect(update).toHaveBeenCalledWith("acct_1", { settings: { payouts: { schedule: { interval: "weekly", weekly_anchor: "monday" } } } });
  });
  it("never overrides a chosen schedule, a vendor account, or the withdraw-only policy", async () => {
    const update = vi.fn();
    const stripe = { accounts: { update } } as never;
    expect(await ensureAutomaticPayoutSchedule(stripe, acct("daily"), { vendorOwned: false })).toBe(false);
    expect(await ensureAutomaticPayoutSchedule(stripe, acct("manual"), { vendorOwned: true })).toBe(false);
    process.env.MANUAL_PAYOUT_POLICY_ENABLED = "1";
    expect(await ensureAutomaticPayoutSchedule(stripe, acct("manual"), { vendorOwned: false })).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
  it("a weekly request without a day defaults to Monday; a bad day is refused", () => {
    expect(validateScheduleRequestBody({ interval: "weekly" })).toEqual({ ok: true, schedule: { interval: "weekly", weeklyAnchor: "monday" } });
    expect(validateScheduleRequestBody({ interval: "weekly", weeklyAnchor: "someday" }).ok).toBe(false);
    expect(validateScheduleRequestBody({ interval: "daily" }).ok).toBe(true);
  });
});

describe("payout.failed notice", () => {
  const payout = { id: "po_1", status: "failed", amount: 12345, currency: "usd", failure_message: "The bank account has been closed.", failure_code: "account_closed" } as never;
  it("tells the owner once with Stripe's reason, idempotent on the payout", async () => {
    await notifyOwnerOfFailedPayout({} as never, "owner-1", payout, "in_transit");
    expect(notify).toHaveBeenCalledTimes(1);
    const arg = notify.mock.calls[0]![1] as { landlordId: string; text: string; idempotencyKey: string };
    expect(arg.landlordId).toBe("owner-1");
    expect(arg.text).toContain("$123.45");
    expect(arg.text).toContain("The bank account has been closed.");
    expect(arg.idempotencyKey).toBe("payout-failed:po_1");
  });
  it("skips a payout already known as failed and one that has not failed", async () => {
    await notifyOwnerOfFailedPayout({} as never, "owner-1", payout, "failed");
    await notifyOwnerOfFailedPayout({} as never, "owner-1", { ...(payout as object), status: "paid" } as never, null);
    expect(notify).not.toHaveBeenCalled();
  });
  it("falls back to the failure code, and never carries a number", () => {
    expect(payoutFailureReason({ failure_message: null, failure_code: "account_closed" } as never)).toBe("account closed");
  });
});

describe("bank label", () => {
  it("shows last four only, however long the value", () => {
    expect(payoutMethodBankLabel({ bankName: "Chase", last4: "000123456789" })).toBe("Chase •••• 6789");
    expect(payoutMethodBankLabel({ last4: "" })).toBeNull();
  });
});
