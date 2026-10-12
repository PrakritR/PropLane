/**
 * A live signup trial has no Communication: its monthly credit is $0 (whatever Pro/Business
 * entitlement the row carries for everything else), and the billing gate refuses with the `trial`
 * reason BEFORE any credit math - even if purchased credit somehow exists. A lapsed trial reads
 * Free (liveSignupTrial false) and keeps Free's behaviour.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const plan = vi.hoisted(() => vi.fn());
vi.mock("@/lib/manager-access-server", () => ({ getEffectiveManagerSkuTier: plan }));
vi.mock("@/lib/comms-billing/notifications.server", () => ({ maybeNotifyCommsBudgetThreshold: vi.fn(async () => undefined) }));

import { commsBudgetTierForPlan } from "@/lib/comms-billing/allowances";
import {
  commsBillingBlockMessage,
  evaluateManagerCommsBillingGate,
} from "@/lib/comms-billing/eligibility.server";
import { commsPlanBudget, loadCommsWallet, loadCommsWalletTotals } from "@/lib/comms-billing/wallet.server";
import { RATE_CARD } from "@/lib/billing/rate-card";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const snapshot = {
  allowance_cents: 0,
  included_remaining_cents: 0,
  purchased_remaining_cents: 0,
  next_allowance_cents: 0,
  period_start: "2026-10-01T00:00:00Z",
  period_end: "2026-11-01T00:00:00Z",
  paused: false,
};
function database(data: unknown = snapshot) {
  return {
    rpc: vi.fn().mockImplementation(async (fn: string) =>
      fn === "ensure_default_portal_workspace" ? { data: WORKSPACE, error: null } : { data, error: null },
    ),
  };
}

beforeEach(() => plan.mockReset());

describe("the communication budget of a live trial", () => {
  it("is the zero-credit tier's, not Pro's", () => {
    expect(commsBudgetTierForPlan({ tier: "pro", liveSignupTrial: true })).toBe("free");
    expect(commsBudgetTierForPlan({ tier: "business", liveSignupTrial: true })).toBe("free");
    expect(commsBudgetTierForPlan({ tier: "pro", liveSignupTrial: false })).toBe("pro");
    expect(commsBudgetTierForPlan({ tier: "pro" })).toBe("pro");
    expect(commsBudgetTierForPlan({ tier: "free" })).toBe("free");
  });

  it("commsPlanBudget gives a trial $0 and a paid Pro its real allowance", async () => {
    plan.mockResolvedValue({ ok: true, tier: "pro", liveSignupTrial: true });
    expect(await commsPlanBudget("owner")).toMatchObject({ tier: "free", allowance: 0, legacy: 0, liveSignupTrial: true });
    plan.mockResolvedValue({ ok: true, tier: "pro", liveSignupTrial: false });
    expect(await commsPlanBudget("owner")).toMatchObject({
      tier: "pro",
      allowance: RATE_CARD.pro.commsIncludedAllowanceCents,
      liveSignupTrial: false,
    });
  });

  it("the wallet read asks for a zero allowance and says it is a trial", async () => {
    plan.mockResolvedValue({ ok: true, tier: "pro", liveSignupTrial: true });
    const db = database();
    const wallet = await loadCommsWallet(db as never, "owner");
    expect(wallet.liveSignupTrial).toBe(true);
    expect(db.rpc).toHaveBeenCalledWith(
      "comms_wallet_snapshot",
      expect.objectContaining({ p_owner: "owner", p_allowance: 0, p_legacy_allowance: 0 }),
    );
  });

  it("the admin wallet totals are read under the zero-credit tier for a trial owner", async () => {
    const db = { rpc: vi.fn().mockResolvedValue({ data: [], error: null }) };
    await loadCommsWalletTotals(db as never, [
      { managerUserId: "trial-owner", tier: commsBudgetTierForPlan({ tier: "pro", liveSignupTrial: true }) },
      { managerUserId: "paid-owner", tier: commsBudgetTierForPlan({ tier: "pro" }) },
    ]);
    const requests = (db.rpc.mock.calls[0]![1] as { p_requests: { owner: string; allowance: number }[] }).p_requests;
    expect(requests.find((r) => r.owner === "trial-owner")!.allowance).toBe(0);
    expect(requests.find((r) => r.owner === "paid-owner")!.allowance).toBe(RATE_CARD.pro.commsIncludedAllowanceCents);
  });
});

describe("evaluateManagerCommsBillingGate for a live trial", () => {
  it("refuses with the trial reason", async () => {
    plan.mockResolvedValue({ ok: true, tier: "pro", liveSignupTrial: true });
    expect(await evaluateManagerCommsBillingGate(database() as never, "owner")).toEqual({
      allowed: false,
      reason: "trial",
    });
  });

  it("refuses even when purchased credit is sitting in the wallet", async () => {
    plan.mockResolvedValue({ ok: true, tier: "pro", liveSignupTrial: true });
    const db = database({ ...snapshot, purchased_remaining_cents: 5000 });
    expect(await evaluateManagerCommsBillingGate(db as never, "owner", 1)).toEqual({ allowed: false, reason: "trial" });
  });

  it("does not touch a lapsed trial, a paid plan, or Free with credit", async () => {
    plan.mockResolvedValue({ ok: true, tier: "free", liveSignupTrial: false });
    const funded = database({ ...snapshot, purchased_remaining_cents: 500 });
    expect(await evaluateManagerCommsBillingGate(funded as never, "owner", 3)).toMatchObject({ allowed: true });

    plan.mockResolvedValue({ ok: true, tier: "pro", liveSignupTrial: false });
    const paid = database({ ...snapshot, allowance_cents: 200, included_remaining_cents: 200 });
    expect(await evaluateManagerCommsBillingGate(paid as never, "owner", 3)).toMatchObject({ allowed: true });
  });

  it("an unreadable plan is still plan_unreadable, not trial", async () => {
    plan.mockResolvedValue({ ok: false, error: "offline" });
    expect(await evaluateManagerCommsBillingGate(database() as never, "owner")).toMatchObject({
      allowed: false,
      reason: "plan_unreadable",
    });
  });

  it("words the refusal as the paid-plan message", () => {
    expect(commsBillingBlockMessage("trial")).toBe("Communication is available on a paid plan.");
    expect(commsBillingBlockMessage("trial", "work_email")).toBe("Communication is available on a paid plan.");
  });
});
