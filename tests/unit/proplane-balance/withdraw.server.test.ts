import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { withdrawFromBalance } from "@/lib/proplane-balance/withdraw.server";

type Result = { data: unknown; error: { code?: string; message: string } | null };

function chain(result: Result) {
  return { data: result.data, error: result.error, select: () => chain(result), maybeSingle: () => result, eq: () => chain(result) };
}

function makeDb(opts: {
  rpc?: Record<string, (args: Record<string, unknown>) => Result>;
  profile?: Result;
  entriesInsert?: (row: Record<string, unknown>) => Result;
  entriesUpdate?: (patch: Record<string, unknown>) => Result;
}) {
  const updateCalls: Array<{ table: string; patch: Record<string, unknown> }> = [];
  const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      const handler = opts.rpc?.[name];
      if (!handler) throw new Error(`no rpc mock for ${name}`);
      return handler(args);
    },
    from: (table: string) => ({
      select: () => {
        const result = table === "profiles" ? (opts.profile ?? { data: null, error: null }) : { data: null, error: null };
        const node = { eq: () => node, maybeSingle: () => result };
        return node;
      },
      insert: (row: Record<string, unknown>) => {
        insertCalls.push({ table, row });
        const result = table === "proplane_balance_entries" && opts.entriesInsert ? opts.entriesInsert(row) : { data: { id: "claim-1" }, error: null };
        return chain(result);
      },
      update: (patch: Record<string, unknown>) => {
        updateCalls.push({ table, patch });
        const result = table === "proplane_balance_entries" && opts.entriesUpdate ? opts.entriesUpdate(patch) : { data: null, error: null };
        return chain(result);
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, updateCalls, insertCalls };
}

function baseRpc(): Record<string, (args: Record<string, unknown>) => Result> {
  return {
    proplane_balance_ensure_account: () => ({ data: "acct-1", error: null }),
    proplane_balance_settle_due: () => ({ data: null, error: null }),
    proplane_balance_available_cents: () => ({ data: 50_000, error: null }),
  };
}

function makeStripe(opts: { accountReady?: boolean; transferError?: Error; payoutError?: Error }) {
  const transfersCreate: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const payoutsCreate: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const stripe = {
    accounts: {
      retrieve: async (id: string) => ({
        id,
        capabilities: { transfers: opts.accountReady === false ? "inactive" : "active" },
        payouts_enabled: opts.accountReady !== false,
      }),
    },
    transfers: {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        transfersCreate.push({ params, options });
        if (opts.transferError) throw opts.transferError;
        return { id: "tr_test_1" };
      },
    },
    payouts: {
      create: async (params: Record<string, unknown>, options: Record<string, unknown>) => {
        payoutsCreate.push({ params, options });
        if (opts.payoutError) throw opts.payoutError;
        return { id: "po_test_1" };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Stripe;
  return { stripe, transfersCreate, payoutsCreate };
}

const CALL = { ownerKind: "workspace" as const, ownerUserId: "manager-1", amountCents: 10_000 };

describe("withdrawFromBalance", () => {
  it("refuses when there is no connected Stripe account yet", async () => {
    const { stripe } = makeStripe({});
    const { db } = makeDb({ rpc: baseRpc(), profile: { data: null, error: null } });
    const result = await withdrawFromBalance(stripe, db, CALL);
    expect(result).toEqual({ ok: false, status: 402, error: "Finish Stripe payout setup before withdrawing." });
  });

  it("refuses when the connected account has not finished onboarding", async () => {
    const { stripe } = makeStripe({ accountReady: false });
    const { db } = makeDb({ rpc: baseRpc(), profile: { data: { stripe_connect_account_id: "acct_x" }, error: null } });
    const result = await withdrawFromBalance(stripe, db, CALL);
    expect(result).toEqual({ ok: false, status: 402, error: "Finish Stripe payout setup before withdrawing." });
  });

  it("maps a concurrent withdrawal claim to 409", async () => {
    const { stripe } = makeStripe({});
    const { db } = makeDb({
      rpc: baseRpc(),
      profile: { data: { stripe_connect_account_id: "acct_x" }, error: null },
      entriesInsert: () => ({ data: null, error: { code: "23505", message: "duplicate key" } }),
    });
    const result = await withdrawFromBalance(stripe, db, CALL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("maps an insufficient balance to 422 with the available amount", async () => {
    const { stripe } = makeStripe({});
    const { db } = makeDb({
      rpc: { ...baseRpc(), proplane_balance_available_cents: () => ({ data: 500, error: null }) },
      profile: { data: { stripe_connect_account_id: "acct_x" }, error: null },
    });
    const result = await withdrawFromBalance(stripe, db, CALL);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.error).toContain("5.00");
    }
  });

  it("a failed transfer call reverses the ledger claim and never touches the bank", async () => {
    const { stripe, transfersCreate, payoutsCreate } = makeStripe({ transferError: new Error("Stripe down") });
    const { db, updateCalls, insertCalls } = makeDb({ rpc: baseRpc(), profile: { data: { stripe_connect_account_id: "acct_x" }, error: null } });
    const result = await withdrawFromBalance(stripe, db, CALL);
    expect(result).toEqual({ ok: false, status: 500, error: "Stripe down" });
    expect(payoutsCreate).toHaveLength(0);
    // Reversal: the claim gets the "reversed:" sentinel, and a mirror credit is inserted.
    const reversalUpdate = updateCalls.find((c) => typeof c.patch.stripe_object_id === "string" && (c.patch.stripe_object_id as string).startsWith("reversed:"));
    expect(reversalUpdate).toBeTruthy();
    const reversalInsert = insertCalls.find((c) => c.row.kind === "withdrawal_reversal");
    expect(reversalInsert?.row).toMatchObject({ amount_cents: 10_000, related_entry_id: "claim-1" });
    expect(transfersCreate).toHaveLength(1);
  });

  it("transfer succeeds but the automatic payout fails: money already left the platform, ledger is NOT reversed", async () => {
    const { stripe } = makeStripe({ payoutError: new Error("bank_account_unusable") });
    const { db, updateCalls, insertCalls } = makeDb({ rpc: baseRpc(), profile: { data: { stripe_connect_account_id: "acct_x" }, error: null } });
    const result = await withdrawFromBalance(stripe, db, CALL);
    expect(result).toEqual({
      ok: true,
      transferId: "tr_test_1",
      payoutId: null,
      payoutPending: true,
      payoutError: "bank_account_unusable",
    });
    // Stamped with the real transfer id, not a reversal sentinel.
    expect(updateCalls.some((c) => c.patch.stripe_object_id === "tr_test_1")).toBe(true);
    expect(insertCalls.some((c) => c.row.kind === "withdrawal_reversal")).toBe(false);
  });

  it("transfer + payout both succeed", async () => {
    const { stripe, transfersCreate, payoutsCreate } = makeStripe({});
    const { db } = makeDb({ rpc: baseRpc(), profile: { data: { stripe_connect_account_id: "acct_x" }, error: null } });
    const result = await withdrawFromBalance(stripe, db, CALL);
    expect(result).toEqual({ ok: true, transferId: "tr_test_1", payoutId: "po_test_1", payoutPending: false });
    expect(transfersCreate[0]?.params).toMatchObject({ amount: 10_000, currency: "usd", destination: "acct_x" });
    expect(payoutsCreate[0]?.params).toMatchObject({ amount: 10_000, currency: "usd", method: "standard" });
    expect(payoutsCreate[0]?.options).toMatchObject({ stripeAccount: "acct_x" });
  });
});
