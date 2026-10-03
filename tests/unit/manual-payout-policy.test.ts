import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
vi.mock("server-only", () => ({}));
import { ensureManualPayoutPolicy } from "@/lib/manual-payout-policy.server";
describe("withdraw-only provider policy", () => {
  it("converts a weekly account without changing any bank destination", async () => {
    const update = vi.fn();
    const stripe = { accounts: { retrieve: async () => ({ settings: { payouts: { schedule: { interval: "weekly" } } } }), update } } as unknown as Stripe;
    expect(await ensureManualPayoutPolicy(stripe, "acct_owner")).toBe(true);
    expect(update).toHaveBeenCalledWith("acct_owner", { settings: { payouts: { schedule: { interval: "manual" } } } });
  });
  it("leaves already-manual accounts untouched", async () => {
    const update = vi.fn();
    const stripe = { accounts: { retrieve: async () => ({ settings: { payouts: { schedule: { interval: "manual" } } } }), update } } as unknown as Stripe;
    expect(await ensureManualPayoutPolicy(stripe, "acct_owner")).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});
