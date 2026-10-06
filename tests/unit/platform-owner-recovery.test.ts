import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ verifySource: vi.fn() }));
vi.mock("@/lib/platform-hold-release.server", () => ({
  verifyPlatformHoldSourceRefundHistory: mocks.verifySource,
}));

import { settleClearedPlatformOwnerRecovery, verifiedCapturedChargeAvailability,
  reconcileUnhydratedCentralSourceMirrors } from "@/lib/platform-owner-recovery.server";

const owner = "2f78a71d-a80e-4f10-bbe8-d01bffb1069c";
const hold = { id: "hold-1", owner_user_id: owner, owner_role: "manager",
  stripe_charge_id: "ch_source", source_payment_intent_id: "pi_source" };
const leg = { attempt_key: "owner-recovery:exact", hold_id: hold.id,
  owner_user_id: owner, source_charge_id: "ch_source", source_payment_intent_id: "pi_source",
  source_net_cents: 175 };

function fixture(balanceTransaction: string | null = "txn_source") {
  const rpc = vi.fn(async () => ({ data: true, error: null }));
  const db = {
    from: vi.fn((table: string) => {
      const row = table === "platform_source_consumption_legs" ? [leg] : hold;
      const query: Record<string, unknown> = {
        eq: () => query,
        then: (resolve: (result: unknown) => void) => resolve({ data: row, error: null }),
        maybeSingle: async () => ({ data: row, error: null }),
      };
      return { select: () => query };
    }), rpc,
  };
  const balance = { id: "txn_source", currency: "usd", amount: 1000,
    fee: 30, net: 970, source: "ch_source", type: "charge", status: "available",
    available_on: Math.floor(Date.now() / 1000) - 60 };
  const stripe = { balanceTransactions: { retrieve: vi.fn(async () => balance) } };
  mocks.verifySource.mockResolvedValue({ id: "ch_source", amount: 1000,
    balance_transaction: balanceTransaction });
  return { db, stripe, rpc, balance };
}

describe("owner recovery clearing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps missing balance transaction evidence reserved", async () => {
    const f = fixture(null);
    expect(await settleClearedPlatformOwnerRecovery(f.db as never, f.stripe as never,
      { ownerUserId: owner })).toEqual({ settled: 0, pending: 1 });
    expect(f.stripe.balanceTransactions.retrieve).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("keeps future or pending provider funds reserved without AP repayment", async () => {
    const f = fixture();
    f.balance.available_on = Math.floor(Date.now() / 1000) + 3600;
    expect(await settleClearedPlatformOwnerRecovery(f.db as never, f.stripe as never,
      { ownerUserId: owner })).toEqual({ settled: 0, pending: 1 });
    f.balance.available_on = Math.floor(Date.now() / 1000) - 60;
    f.balance.status = "pending";
    expect(await settleClearedPlatformOwnerRecovery(f.db as never, f.stripe as never,
      { ownerUserId: owner })).toEqual({ settled: 0, pending: 1 });
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("passes exact fresh available provider evidence to the durable settlement", async () => {
    const f = fixture();
    expect(await settleClearedPlatformOwnerRecovery(f.db as never, f.stripe as never,
      { ownerUserId: owner, holdId: hold.id })).toEqual({ settled: 1, pending: 0 });
    expect(f.rpc).toHaveBeenCalledWith("settle_platform_owner_recovery", expect.objectContaining({
      p_attempt: leg.attempt_key, p_charge: "ch_source", p_payment_intent: "pi_source",
      p_balance_transaction: "txn_source",
      p_available_on: new Date(f.balance.available_on * 1000).toISOString(),
    }));
  });

  it("refuses a balance transaction linked to another source", async () => {
    const f = fixture();
    f.balance.source = "ch_other";
    await expect(settleClearedPlatformOwnerRecovery(f.db as never, f.stripe as never,
      { ownerUserId: owner })).rejects.toThrow(/differs from its balance transaction/);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it("rejects zero or malformed source availability before booking it", async () => {
    const f = fixture();
    f.balance.available_on = 0;
    await expect(verifiedCapturedChargeAvailability(f.stripe as never,
      { id: "ch_source", amount: 1000, balance_transaction: "txn_source" } as never))
      .rejects.toThrow(/availability differs/);
    expect(f.rpc).not.toHaveBeenCalled();
  });

  it.each(["application_fee", "household_charge"])(
    "hydrates an exact classified %s mirror after availability appears", async (source) => {
    const f = fixture();
    const sourceHold = { ...hold, source, source_id: "cs_source",
      amount_cents: 1000, status: "held", source_allocation_mode: "hold",
      source_verified_at: "2026-10-01T00:00:00Z", source_charge_gross_cents: 1000,
      source_principal_cents: 1000, original_amount_cents: 1000,
      source_fee_payer: "resident", source_components: [{ source_id: "hc_source",
        kind: "application_fee", liability_class: "income", principal_cents: 1000,
        recipient_net_cents: 1000 }] };
    const mirror = { source_hold_id: hold.id, platform_payment_holds: sourceHold };
    const query: Record<string, unknown> = {
      eq: () => query, in: () => query, is: () => query, order: () => query,
      limit: async () => ({ data: [mirror], error: null }),
    };
    f.db.from = vi.fn(() => ({ select: () => query }));
    f.rpc.mockResolvedValue({ data: [{ hold_id: hold.id, credited: false }], error: null });
    mocks.verifySource.mockResolvedValue({ id: "ch_source", amount: 1000,
      balance_transaction: "txn_source" });
    expect(await reconcileUnhydratedCentralSourceMirrors(f.db as never,
      f.stripe as never)).toMatchObject({ scanned: 1, hydrated: 1, errors: [] });
    expect(f.rpc).toHaveBeenCalledWith("credit_platform_income_with_recovery",
      expect.objectContaining({ p_owner: owner, p_source_id: "cs_source",
        p_available_on: new Date(f.balance.available_on * 1000).toISOString(),
        p_components: sourceHold.source_components }));
  });
});
