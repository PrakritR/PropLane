import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/proplane-balance/flag", () => ({ proplaneBalanceEnabled: () => true }));
import { reconcileClassifiedBalanceWithdrawals } from "@/lib/proplane-balance/withdraw-reconcile.server";

function fixture(opts: { stale?: boolean; foreignAccount?: boolean;
  transfer?: boolean; payout?: boolean; incompleteTransfers?: boolean } = {}) {
  const key = "withdrawal:exact";
  const claim = { id: "entry-1", account_id: "wallet-1", amount_cents: -100,
    idempotency_key: key, stripe_object_id: null,
    withdrawal_destination_account_id: "acct_owned", withdrawal_payout_id: null,
    created_at: new Date(Date.now() - (opts.stale ? 30 : 1) * 60 * 60 * 1000).toISOString() };
  const transfer = { id: "tr_exact", amount: 100, currency: "usd", destination: "acct_owned",
    amount_reversed: 0, metadata: { proplane_balance_withdrawal: key,
      proplane_balance_entry_id: claim.id, owner_kind: "workspace", owner_user_id: "owner-1" } };
  const payout = { id: "po_exact", amount: 100, currency: "usd", method: "standard",
    metadata: { proplane_balance_withdrawal: key, proplane_balance_entry_id: claim.id,
      proplane_balance_transfer_id: transfer.id } };
  const updates: Array<Record<string, unknown>> = [];
  const db = { from: (table: string) => {
    if (table === "proplane_balance_accounts") return { select: () => ({ eq: () => ({
      maybeSingle: async () => ({ data: { owner_kind: "workspace", owner_key: "owner-1",
        currency: "usd" }, error: null }),
    }) }) };
    if (table === "proplane_balance_entries") return {
      select: () => { const node: Record<string, unknown> = { eq: () => node,
        not: () => node, is: () => node, order: () => node,
        limit: async () => ({ data: [claim], error: null }) }; return node; },
      update: (patch: Record<string, unknown>) => { updates.push(patch);
        const node: Record<string, unknown> = { eq: () => node, select: () => node,
          maybeSingle: async () => ({ data: { id: claim.id }, error: null }) }; return node; },
    };
    throw new Error(`unexpected table ${table}`);
  }, rpc: vi.fn(async () => ({ data: { stripe_object_id: transfer.id }, error: null })) };
  const stripe = {
    accounts: { retrieve: vi.fn(async () => ({ id: "acct_owned",
      metadata: { axis_user_id: opts.foreignAccount ? "foreign" : "owner-1" } })) },
    transfers: { list: vi.fn(async () => ({ data: opts.transfer ? [transfer] : [],
      has_more: Boolean(opts.incompleteTransfers) })),
      create: vi.fn(async () => transfer), retrieve: vi.fn(async () => transfer) },
    payouts: { list: vi.fn(async () => ({ data: opts.payout ? [payout] : [], has_more: false })),
      create: vi.fn(async () => payout) },
  };
  return { db, stripe, updates };
}

describe("classified withdrawal exact provider reconciliation", () => {
  it("adopts one exact lost-response transfer and payout without a second provider create", async () => {
    const f = fixture({ transfer: true, payout: true });
    expect(await reconcileClassifiedBalanceWithdrawals(f.stripe as never, f.db as never))
      .toMatchObject({ scanned: 1, transfers: 1, payouts: 1, pending: 0, errors: [] });
    expect(f.db.rpc).toHaveBeenCalledWith("finish_platform_classified_withdrawal",
      expect.objectContaining({ p_entry: "entry-1", p_transfer: "tr_exact" }));
    expect(f.updates).toContainEqual({ withdrawal_payout_id: "po_exact",
      withdrawal_provider_status: "payout_created" });
    expect(f.stripe.transfers.create).not.toHaveBeenCalled();
    expect(f.stripe.payouts.create).not.toHaveBeenCalled();
  });

  it("keeps a stale exact-key absence reserved and never retries outside the provider key window", async () => {
    const f = fixture({ stale: true });
    expect(await reconcileClassifiedBalanceWithdrawals(f.stripe as never, f.db as never))
      .toMatchObject({ scanned: 1, transfers: 0, payouts: 0, pending: 1, errors: [] });
    expect(f.stripe.transfers.create).not.toHaveBeenCalled();
    expect(f.db.rpc).not.toHaveBeenCalled();
    expect(f.updates).toHaveLength(0);
  });

  it("does not adopt or create on an incomplete provider list or foreign frozen account", async () => {
    const incomplete = fixture({ incompleteTransfers: true });
    const result = await reconcileClassifiedBalanceWithdrawals(incomplete.stripe as never,
      incomplete.db as never);
    expect(result.errors[0]).toMatch(/search is incomplete/);
    expect(incomplete.stripe.transfers.create).not.toHaveBeenCalled();
    const foreign = fixture({ foreignAccount: true });
    const foreignResult = await reconcileClassifiedBalanceWithdrawals(foreign.stripe as never,
      foreign.db as never);
    expect(foreignResult.errors[0]).toMatch(/destination no longer belongs/);
    expect(foreign.stripe.transfers.list).not.toHaveBeenCalled();
    expect(foreign.stripe.transfers.create).not.toHaveBeenCalled();
  });
});
