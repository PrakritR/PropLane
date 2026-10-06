import { beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  claim: vi.fn(), reverse: vi.fn(), stamp: vi.fn(), ensure: vi.fn(), account: vi.fn(),
}));
vi.mock("@/lib/proplane-balance/flag", () => ({ proplaneBalanceEnabled: () => true }));
vi.mock("@/lib/proplane-balance/ledger.server", () => ({
  claimWithdrawal: vi.fn(), claimClassifiedWithdrawal: mock.claim,
  ensureBalanceAccountId: mock.ensure, reverseWithdrawalClaim: mock.reverse,
  stampWithdrawalTransfer: mock.stamp,
}));
vi.mock("@/lib/stripe-connect", () => ({ retrieveManagerConnectAccountOrNull: mock.account }));
vi.mock("@/lib/stripe-payouts-readiness.server", () => ({ resolvePayoutsReadiness: () => ({ ready: true }) }));

import { withdrawFromBalance } from "@/lib/proplane-balance/withdraw.server";

function fixture(options: { transferTimeout?: boolean; wrongPayout?: boolean } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const transfers: Array<Record<string, unknown>> = [];
  const payouts: Array<Record<string, unknown>> = [];
  const db = {
    from: (table: string) => {
      if (table === "profiles") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: { stripe_connect_account_id: "acct_owned" }, error: null,
      }) }) }) };
      if (table !== "proplane_balance_entries") throw new Error(`unexpected table ${table}`);
      return { update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        const chain: Record<string, unknown> = { eq: () => chain, is: () => chain,
          select: () => chain, maybeSingle: async () => ({ data: { id: "entry-1" }, error: null }) };
        return chain;
      } };
    },
    rpc: vi.fn(async () => ({ data: { stripe_object_id: "tr_exact" }, error: null })),
  };
  const stripe = {
    transfers: { create: vi.fn(async (params: Record<string, unknown>) => {
      transfers.push(params);
      if (options.transferTimeout) throw new Error("response lost after create");
      return { id: "tr_exact", amount: 100, currency: "usd", destination: "acct_owned",
        metadata: params.metadata };
    }) },
    payouts: { create: vi.fn(async (params: Record<string, unknown>) => {
      payouts.push(params);
      return { id: "po_exact", amount: options.wrongPayout ? 200 : 100,
        currency: "usd", method: "standard", metadata: params.metadata };
    }) },
  };
  return { db, stripe, updates, transfers, payouts };
}

describe("classified balance withdrawal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.account.mockResolvedValue({ id: "acct_owned", metadata: { axis_user_id: "owner-1" } });
    mock.ensure.mockResolvedValue("wallet-1");
    mock.claim.mockResolvedValue({ ok: true, entryId: "entry-1", idempotencyKey: "withdrawal:exact" });
  });

  it("retains the exact source debit when a transfer succeeds but its response is lost", async () => {
    const f = fixture({ transferTimeout: true });
    const result = await withdrawFromBalance(f.stripe as never, f.db as never, {
      ownerKind: "workspace", ownerUserId: "owner-1", amountCents: 100 });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(mock.claim).toHaveBeenCalledWith(f.db, expect.objectContaining({
      accountId: "wallet-1", ownerUserId: "owner-1", destinationAccountId: "acct_owned" }));
    expect(f.updates).toContainEqual({ withdrawal_provider_status: "unknown" });
    expect(mock.reverse).not.toHaveBeenCalled();
    expect(mock.stamp).not.toHaveBeenCalled();
    expect(f.db.rpc).not.toHaveBeenCalled();
    expect(f.payouts).toHaveLength(0);
  });

  it("refuses an unrelated connected account before claiming or calling Stripe", async () => {
    mock.account.mockResolvedValueOnce({ id: "acct_owned", metadata: { axis_user_id: "foreign" } });
    const f = fixture();
    expect(await withdrawFromBalance(f.stripe as never, f.db as never, {
      ownerKind: "workspace", ownerUserId: "owner-1", amountCents: 100 }))
      .toMatchObject({ ok: false, status: 402 });
    expect(mock.claim).not.toHaveBeenCalled();
    expect(f.transfers).toHaveLength(0);
    expect(f.payouts).toHaveLength(0);
  });

  it("does not stamp a payout whose returned amount differs from frozen terms", async () => {
    const f = fixture({ wrongPayout: true });
    expect(await withdrawFromBalance(f.stripe as never, f.db as never, {
      ownerKind: "workspace", ownerUserId: "owner-1", amountCents: 100 }))
      .toMatchObject({ ok: true, payoutPending: true });
    expect(f.db.rpc).toHaveBeenCalledWith("finish_platform_classified_withdrawal",
      expect.objectContaining({ p_entry: "entry-1", p_transfer: "tr_exact" }));
    expect(f.updates).not.toContainEqual(expect.objectContaining({ withdrawal_payout_id: "po_exact" }));
    expect(mock.reverse).not.toHaveBeenCalled();
  });
});
