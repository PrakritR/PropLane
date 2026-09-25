import { describe, expect, it, vi } from "vitest";
import {
  claimWithdrawal,
  creditResidentPaymentPending,
  ensureBalanceAccountId,
  payVendorFromBalance,
  readBalanceSnapshot,
  reverseWithdrawalClaim,
  stampWithdrawalTransfer,
} from "@/lib/proplane-balance/ledger.server";

type Result = { data: unknown; error: { code?: string; message: string } | null };

function chain(result: Result) {
  return {
    data: result.data,
    error: result.error,
    select: () => chain(result),
    maybeSingle: () => result,
    eq: () => chain(result),
  };
}

/** Minimal Supabase-client double covering exactly the call shapes ledger.server.ts uses. */
function makeDb(opts: {
  rpc?: Record<string, (args: Record<string, unknown>) => Result>;
  tables?: Record<string, { insert?: (row: Record<string, unknown>) => Result; update?: (patch: Record<string, unknown>) => Result }>;
}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
  const updateCalls: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const db = {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const handler = opts.rpc?.[name];
      if (!handler) throw new Error(`no rpc mock configured for ${name}`);
      return handler(args);
    }),
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        insertCalls.push({ table, row });
        const handler = opts.tables?.[table]?.insert;
        return chain(handler ? handler(row) : { data: null, error: null });
      },
      update: (patch: Record<string, unknown>) => {
        updateCalls.push({ table, patch });
        const handler = opts.tables?.[table]?.update;
        return chain(handler ? handler(patch) : { data: null, error: null });
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, rpcCalls, insertCalls, updateCalls };
}

describe("ensureBalanceAccountId", () => {
  it("resolves the account id from the RPC", async () => {
    const { db, rpcCalls } = makeDb({
      rpc: { proplane_balance_ensure_account: () => ({ data: "acct-1", error: null }) },
    });
    const id = await ensureBalanceAccountId(db, "workspace", "manager-1");
    expect(id).toBe("acct-1");
    expect(rpcCalls[0]).toEqual({
      name: "proplane_balance_ensure_account",
      args: { p_owner_kind: "workspace", p_owner_key: "manager-1", p_currency: "usd" },
    });
  });

  it("throws on an RPC error", async () => {
    const { db } = makeDb({
      rpc: { proplane_balance_ensure_account: () => ({ data: null, error: { message: "boom" } }) },
    });
    await expect(ensureBalanceAccountId(db, "vendor", "vendor-1")).rejects.toThrow(/boom/);
  });

  it("rejects an empty owner key before ever calling the RPC", async () => {
    const { db, rpcCalls } = makeDb({ rpc: {} });
    await expect(ensureBalanceAccountId(db, "vendor", "   ")).rejects.toThrow(/owner key required/);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("readBalanceSnapshot", () => {
  it("settles due entries, then reads available + pending", async () => {
    const { db, rpcCalls } = makeDb({
      rpc: {
        proplane_balance_settle_due: () => ({ data: null, error: null }),
        proplane_balance_available_cents: () => ({ data: 5000, error: null }),
        proplane_balance_pending_cents: () => ({ data: 1200, error: null }),
      },
    });
    const snapshot = await readBalanceSnapshot(db, "acct-1");
    expect(snapshot).toEqual({ currency: "usd", availableCents: 5000, pendingCents: 1200 });
    expect(rpcCalls.map((c) => c.name)).toEqual([
      "proplane_balance_settle_due",
      "proplane_balance_available_cents",
      "proplane_balance_pending_cents",
    ]);
  });

  it("throws if settling due entries fails, without reading a stale balance", async () => {
    const { db, rpcCalls } = makeDb({
      rpc: { proplane_balance_settle_due: () => ({ data: null, error: { message: "lock timeout" } }) },
    });
    await expect(readBalanceSnapshot(db, "acct-1")).rejects.toThrow(/lock timeout/);
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("creditResidentPaymentPending", () => {
  const base = {
    accountId: "acct-1",
    amountCents: 10_000,
    availableOnIso: "2026-09-30T00:00:00.000Z",
    stripeChargeId: "ch_123",
    idempotencyKey: "resident-payment:cs_test_1",
  };

  it("inserts a pending resident_payment entry", async () => {
    const { db, insertCalls } = makeDb({ tables: { proplane_balance_entries: { insert: () => ({ data: null, error: null }) } } });
    const result = await creditResidentPaymentPending(db, base);
    expect(result).toEqual({ ok: true, alreadyCredited: false });
    expect(insertCalls[0]?.row).toMatchObject({
      account_id: "acct-1",
      amount_cents: 10_000,
      kind: "resident_payment",
      status: "pending",
      available_on: base.availableOnIso,
      stripe_object_id: "ch_123",
      idempotency_key: base.idempotencyKey,
    });
  });

  it("is idempotent: a unique-violation replay reads as already credited, not an error", async () => {
    const { db } = makeDb({
      tables: { proplane_balance_entries: { insert: () => ({ data: null, error: { code: "23505", message: "duplicate key" } }) } },
    });
    const result = await creditResidentPaymentPending(db, base);
    expect(result).toEqual({ ok: true, alreadyCredited: true });
  });

  it("throws on a non-idempotency DB error", async () => {
    const { db } = makeDb({
      tables: { proplane_balance_entries: { insert: () => ({ data: null, error: { message: "connection reset" } }) } },
    });
    await expect(creditResidentPaymentPending(db, base)).rejects.toThrow(/connection reset/);
  });

  it("refuses a non-positive amount before ever touching the DB", async () => {
    const { db, insertCalls } = makeDb({ tables: {} });
    await expect(creditResidentPaymentPending(db, { ...base, amountCents: 0 })).rejects.toThrow(/positive/);
    expect(insertCalls).toHaveLength(0);
  });
});

describe("payVendorFromBalance", () => {
  const opts = { managerUserId: "manager-1", vendorUserId: "vendor-1", amountCents: 25_000, idempotencyRoot: "vendor-invoice:inv-1" };

  it("moves the amount workspace -> vendor and returns both entry ids", async () => {
    const { db, rpcCalls } = makeDb({
      rpc: {
        proplane_balance_ensure_account: (args) =>
          args.p_owner_kind === "workspace" ? { data: "acct-workspace", error: null } : { data: "acct-vendor", error: null },
        proplane_balance_move: () => ({ data: [{ payer_entry_id: "e-out", payee_entry_id: "e-in" }], error: null }),
      },
    });
    const result = await payVendorFromBalance(db, opts);
    expect(result).toEqual({ ok: true, payerEntryId: "e-out", payeeEntryId: "e-in" });
    const move = rpcCalls.find((c) => c.name === "proplane_balance_move");
    expect(move?.args).toEqual({
      p_payer_account_id: "acct-workspace",
      p_payee_account_id: "acct-vendor",
      p_amount_cents: 25_000,
      p_payer_kind: "vendor_payment_out",
      p_payee_kind: "vendor_payment_in",
      p_idempotency_root: "vendor-invoice:inv-1",
    });
  });

  it("maps INSUFFICIENT_BALANCE to a structured shortfall, never a thrown error", async () => {
    const { db } = makeDb({
      rpc: {
        proplane_balance_ensure_account: (args) =>
          args.p_owner_kind === "workspace" ? { data: "acct-workspace", error: null } : { data: "acct-vendor", error: null },
        proplane_balance_move: () => ({
          data: null,
          error: { message: "INSUFFICIENT_BALANCE: available=1000 requested=25000" },
        }),
      },
    });
    const result = await payVendorFromBalance(db, opts);
    expect(result).toEqual({
      ok: false,
      code: "insufficient_balance",
      availableCents: 1000,
      requestedCents: 25_000,
      shortfallCents: 24_000,
    });
  });

  it("surfaces any other RPC error as a generic failure", async () => {
    const { db } = makeDb({
      rpc: {
        proplane_balance_ensure_account: (args) =>
          args.p_owner_kind === "workspace" ? { data: "acct-workspace", error: null } : { data: "acct-vendor", error: null },
        proplane_balance_move: () => ({ data: null, error: { message: "deadlock detected" } }),
      },
    });
    const result = await payVendorFromBalance(db, opts);
    expect(result).toEqual({ ok: false, code: "error", error: "deadlock detected" });
  });
});

describe("claimWithdrawal", () => {
  it("claims when available balance covers the amount", async () => {
    const { db, insertCalls } = makeDb({
      rpc: {
        proplane_balance_settle_due: () => ({ data: null, error: null }),
        proplane_balance_available_cents: () => ({ data: 50_000, error: null }),
      },
      tables: { proplane_balance_entries: { insert: () => ({ data: { id: "claim-1" }, error: null }) } },
    });
    const result = await claimWithdrawal(db, { accountId: "acct-1", amountCents: 10_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entryId).toBe("claim-1");
      expect(result.idempotencyKey).toMatch(/^withdrawal:/);
    }
    expect(insertCalls[0]?.row).toMatchObject({
      account_id: "acct-1",
      amount_cents: -10_000,
      kind: "withdrawal",
      status: "available",
      stripe_object_id: null,
    });
  });

  it("refuses without claiming when the balance is short", async () => {
    const { db, insertCalls } = makeDb({
      rpc: {
        proplane_balance_settle_due: () => ({ data: null, error: null }),
        proplane_balance_available_cents: () => ({ data: 500, error: null }),
      },
    });
    const result = await claimWithdrawal(db, { accountId: "acct-1", amountCents: 10_000 });
    expect(result).toEqual({ ok: false, code: "insufficient_balance", availableCents: 500 });
    expect(insertCalls).toHaveLength(0);
  });

  it("maps a unique-index collision to a conflict (another withdrawal already in flight)", async () => {
    const { db } = makeDb({
      rpc: {
        proplane_balance_settle_due: () => ({ data: null, error: null }),
        proplane_balance_available_cents: () => ({ data: 50_000, error: null }),
      },
      tables: {
        proplane_balance_entries: {
          insert: () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }),
        },
      },
    });
    const result = await claimWithdrawal(db, { accountId: "acct-1", amountCents: 10_000 });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ code: "conflict" });
  });

  it("rejects a non-positive amount before any RPC call", async () => {
    const { db, rpcCalls } = makeDb({ rpc: {} });
    const result = await claimWithdrawal(db, { accountId: "acct-1", amountCents: 0 });
    expect(result).toEqual({ ok: false, code: "error", error: "Amount must be positive." });
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("stampWithdrawalTransfer / reverseWithdrawalClaim", () => {
  it("stamps the claim with the real transfer id", async () => {
    const { db, updateCalls } = makeDb({ tables: { proplane_balance_entries: { update: () => ({ data: null, error: null }) } } });
    await stampWithdrawalTransfer(db, { entryId: "claim-1", transferId: "tr_abc" });
    expect(updateCalls[0]).toEqual({ table: "proplane_balance_entries", patch: { stripe_object_id: "tr_abc" } });
  });

  it("reverses a failed claim: sentinel on the original entry, mirror credit as a new entry", async () => {
    const { db, updateCalls, insertCalls } = makeDb({
      tables: {
        proplane_balance_entries: {
          update: () => ({ data: null, error: null }),
          insert: () => ({ data: null, error: null }),
        },
      },
    });
    await reverseWithdrawalClaim(db, { entryId: "claim-1", accountId: "acct-1", amountCents: 10_000 });
    expect(updateCalls[0]?.patch.stripe_object_id).toMatch(/^reversed:/);
    expect(insertCalls[0]?.row).toMatchObject({
      account_id: "acct-1",
      amount_cents: 10_000,
      kind: "withdrawal_reversal",
      status: "available",
      related_entry_id: "claim-1",
      idempotency_key: "claim-1:reversal",
    });
  });

  it("reversal insert is idempotent: a unique-violation replay is not thrown", async () => {
    const { db } = makeDb({
      tables: {
        proplane_balance_entries: {
          update: () => ({ data: null, error: null }),
          insert: () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
        },
      },
    });
    await expect(
      reverseWithdrawalClaim(db, { entryId: "claim-1", accountId: "acct-1", amountCents: 10_000 }),
    ).resolves.toBeUndefined();
  });
});
