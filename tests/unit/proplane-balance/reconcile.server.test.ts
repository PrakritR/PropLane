import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { reconcilePlatformLedgerCharges } from "@/lib/proplane-balance/reconcile.server";

type Result = { data: unknown; error: { code?: string; message: string } | null };

function chain(result: Result) {
  return { data: result.data, error: result.error, select: () => chain(result), maybeSingle: () => result, eq: () => chain(result) };
}

/**
 * Mock Supabase client covering both `reconcile.server.ts`'s own
 * `proplane_balance_entries` existence check AND the real
 * `ledger.server.ts` functions it calls (`ensureWorkspaceBalanceAccountId`,
 * `creditResidentPaymentPending`) — those are NOT mocked, so this proves the
 * real ledger crediting code runs, not a stand-in.
 */
function makeDb(opts: { existingChargeIds?: Set<string> } = {}) {
  const existingChargeIds = opts.existingChargeIds ?? new Set<string>();
  const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
  const selectCalls: Array<{ table: string; chargeId?: string }> = [];
  let lastChargeIdFilter: string | undefined;

  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "proplane_balance_ensure_account") {
        return { data: `acct-${args.p_owner_key}`, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => ({
      select: () => {
        lastChargeIdFilter = undefined;
        const node = {
          eq: (col: string, val: unknown) => {
            if (col === "stripe_object_id") lastChargeIdFilter = String(val);
            return node;
          },
          maybeSingle: () => {
            selectCalls.push({ table, chargeId: lastChargeIdFilter });
            const found = lastChargeIdFilter && existingChargeIds.has(lastChargeIdFilter);
            return { data: found ? { id: `entry-${lastChargeIdFilter}` } : null, error: null };
          },
        };
        return node;
      },
      insert: (row: Record<string, unknown>) => {
        insertCalls.push({ table, row });
        return chain({ data: null, error: null });
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, insertCalls, selectCalls, existingChargeIds };
}

type FakePaymentIntent = {
  id: string;
  metadata?: Record<string, string>;
  latest_charge?: string | { id: string; balance_transaction?: { available_on: number } | string | null } | null;
};

function makeStripe(opts: {
  pages: FakePaymentIntent[][];
  sessionsByPaymentIntentId?: Record<string, { id: string } | undefined>;
  chargesById?: Record<string, { id: string; balance_transaction?: { available_on: number } | null }>;
  searchError?: Error;
}) {
  const searchCalls: Array<{ query: string; page?: string }> = [];
  const sessionListCalls: string[] = [];
  const chargeRetrieveCalls: string[] = [];
  let pageIndex = 0;

  const stripe = {
    paymentIntents: {
      search: async (params: { query: string; limit: number; page?: string }) => {
        searchCalls.push({ query: params.query, page: params.page });
        if (opts.searchError) throw opts.searchError;
        const data = opts.pages[pageIndex] ?? [];
        pageIndex += 1;
        const hasMore = pageIndex < opts.pages.length;
        return { data, has_more: hasMore, next_page: hasMore ? `page_${pageIndex}` : null };
      },
    },
    checkout: {
      sessions: {
        list: async (params: { payment_intent: string; limit: number }) => {
          sessionListCalls.push(params.payment_intent);
          const session = opts.sessionsByPaymentIntentId?.[params.payment_intent];
          return { data: session ? [session] : [] };
        },
      },
    },
    charges: {
      retrieve: async (id: string) => {
        chargeRetrieveCalls.push(id);
        const charge = opts.chargesById?.[id];
        if (!charge) throw new Error(`no such charge ${id}`);
        return charge;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Stripe;
  return { stripe, searchCalls, sessionListCalls, chargeRetrieveCalls };
}

describe("reconcilePlatformLedgerCharges", () => {
  const PREV_FLAG = process.env.PROPLANE_BALANCE_ENABLED;
  beforeEach(() => {
    process.env.PROPLANE_BALANCE_ENABLED = "1";
  });
  afterEach(() => {
    if (PREV_FLAG === undefined) delete process.env.PROPLANE_BALANCE_ENABLED;
    else process.env.PROPLANE_BALANCE_ENABLED = PREV_FLAG;
  });

  it("no-ops entirely when the flag is off — never calls Stripe or the DB", async () => {
    process.env.PROPLANE_BALANCE_ENABLED = "0";
    const { stripe, searchCalls } = makeStripe({ pages: [[]] });
    const { db } = makeDb();
    const result = await reconcilePlatformLedgerCharges(stripe, db);
    expect(result).toEqual({ scanned: 0, credited: 0, alreadyCredited: 0, skipped: 0, errors: [] });
    expect(searchCalls).toHaveLength(0);
  });

  it("credits a PaymentIntent with no matching ledger entry, using the checkout-session idempotency key", async () => {
    const pi: FakePaymentIntent = {
      id: "pi_1",
      metadata: { manager_user_id: "manager-1", manager_payout_cents: "5000" },
      latest_charge: { id: "ch_1", balance_transaction: { available_on: 1_800_000_000 } },
    };
    const { stripe } = makeStripe({
      pages: [[pi]],
      sessionsByPaymentIntentId: { pi_1: { id: "cs_1" } },
    });
    const { db, insertCalls } = makeDb();

    const result = await reconcilePlatformLedgerCharges(stripe, db);
    expect(result).toEqual({ scanned: 1, credited: 1, alreadyCredited: 0, skipped: 0, errors: [] });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.row).toMatchObject({
      amount_cents: 5000,
      kind: "resident_payment",
      status: "pending",
      stripe_object_id: "ch_1",
      idempotency_key: "resident-payment:cs_1",
      available_on: new Date(1_800_000_000 * 1000).toISOString(),
    });
  });

  it("skips (does not re-credit) a charge that already has a matching ledger entry", async () => {
    const pi: FakePaymentIntent = {
      id: "pi_2",
      metadata: { manager_user_id: "manager-1", manager_payout_cents: "5000" },
      latest_charge: "ch_already",
    };
    const { stripe, sessionListCalls } = makeStripe({ pages: [[pi]] });
    const { db, insertCalls } = makeDb({ existingChargeIds: new Set(["ch_already"]) });

    const result = await reconcilePlatformLedgerCharges(stripe, db);
    expect(result).toEqual({ scanned: 1, credited: 0, alreadyCredited: 1, skipped: 0, errors: [] });
    expect(insertCalls).toHaveLength(0);
    // Never even looks up the checkout session for an already-credited charge.
    expect(sessionListCalls).toHaveLength(0);
  });

  it("skips a PaymentIntent missing manager metadata, without touching the DB", async () => {
    const pi: FakePaymentIntent = { id: "pi_3", metadata: {}, latest_charge: "ch_3" };
    const { stripe } = makeStripe({ pages: [[pi]] });
    const { db, insertCalls, selectCalls } = makeDb();
    const result = await reconcilePlatformLedgerCharges(stripe, db);
    expect(result).toEqual({ scanned: 1, credited: 0, alreadyCredited: 0, skipped: 1, errors: [] });
    expect(insertCalls).toHaveLength(0);
    expect(selectCalls).toHaveLength(0);
  });

  it("skips when no checkout session is found for the PaymentIntent (never invents an idempotency key)", async () => {
    const pi: FakePaymentIntent = {
      id: "pi_4",
      metadata: { manager_user_id: "manager-1", manager_payout_cents: "5000" },
      latest_charge: "ch_4",
    };
    const { stripe } = makeStripe({ pages: [[pi]] }); // no session registered
    const { db, insertCalls } = makeDb();
    const result = await reconcilePlatformLedgerCharges(stripe, db);
    expect(result).toEqual({ scanned: 1, credited: 0, alreadyCredited: 0, skipped: 1, errors: [] });
    expect(insertCalls).toHaveLength(0);
  });

  it("records a per-PaymentIntent error and keeps processing the rest of the page", async () => {
    const ok: FakePaymentIntent = {
      id: "pi_ok",
      metadata: { manager_user_id: "manager-1", manager_payout_cents: "1000" },
      latest_charge: { id: "ch_ok" },
    };
    const bad: FakePaymentIntent = {
      id: "pi_bad",
      metadata: { manager_user_id: "manager-1", manager_payout_cents: "1000" },
      latest_charge: "ch_bad", // no charge registered -> charges.retrieve throws
    };
    const { stripe } = makeStripe({
      pages: [[bad, ok]],
      sessionsByPaymentIntentId: { pi_bad: { id: "cs_bad" }, pi_ok: { id: "cs_ok" } },
    });
    const { db, insertCalls } = makeDb();
    const result = await reconcilePlatformLedgerCharges(stripe, db);
    expect(result.scanned).toBe(2);
    expect(result.credited).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("pi_bad");
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.row.stripe_object_id).toBe("ch_ok");
  });

  it("walks multiple search pages up to the limit", async () => {
    const piFor = (n: number): FakePaymentIntent => ({
      id: `pi_${n}`,
      metadata: { manager_user_id: "manager-1", manager_payout_cents: "1000" },
      latest_charge: { id: `ch_${n}` },
    });
    const page1 = [piFor(1), piFor(2)];
    const page2 = [piFor(3)];
    const { stripe, searchCalls } = makeStripe({
      pages: [page1, page2],
      sessionsByPaymentIntentId: { pi_1: { id: "cs_1" }, pi_2: { id: "cs_2" }, pi_3: { id: "cs_3" } },
    });
    const { db } = makeDb();
    const result = await reconcilePlatformLedgerCharges(stripe, db, { limit: 10 });
    expect(result.scanned).toBe(3);
    expect(result.credited).toBe(3);
    expect(searchCalls).toHaveLength(2);
  });

  it("a search API failure is recorded as an error, not thrown", async () => {
    const { stripe } = makeStripe({ pages: [[]], searchError: new Error("stripe down") });
    const { db } = makeDb();
    const result = await reconcilePlatformLedgerCharges(stripe, db);
    expect(result.scanned).toBe(0);
    expect(result.errors).toEqual(["search: stripe down"]);
  });
});
