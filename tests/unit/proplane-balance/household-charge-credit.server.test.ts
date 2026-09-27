import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { mockCheckoutSession } from "../../mocks/stripe/events";
import { creditProplaneBalanceFromHouseholdChargeSession } from "@/lib/proplane-balance/household-charge-credit.server";

type Result = { data: unknown; error: { code?: string; message: string } | null };

function chain(result: Result) {
  return { data: result.data, error: result.error, select: () => chain(result), maybeSingle: () => result, eq: () => chain(result) };
}

function makeDb() {
  const insertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "proplane_balance_ensure_account") return { data: "acct-workspace-1", error: null };
      throw new Error(`unexpected rpc ${name}`);
    },
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        insertCalls.push({ table, row });
        return chain({ data: null, error: null });
      },
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, insertCalls, rpcCalls };
}

function makeStripe(opts: { availableOnEpoch?: number | null; expandLatestCharge?: boolean }) {
  const stripe = {
    paymentIntents: {
      retrieve: async (id: string) => ({
        id,
        latest_charge:
          opts.expandLatestCharge === false
            ? "ch_unexpanded"
            : {
                id: "ch_test_1",
                balance_transaction:
                  opts.availableOnEpoch === null
                    ? null
                    : { available_on: opts.availableOnEpoch ?? 1_800_000_000 },
              },
      }),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any as Stripe;
  return stripe;
}

const platformLedgerSession = mockCheckoutSession({
  id: "cs_test_ledger_1",
  mode: "payment",
  payment_intent: "pi_test_1",
  metadata: { funding_model: "platform_ledger", manager_user_id: "manager-1", manager_payout_cents: "12000" },
});

describe("creditProplaneBalanceFromHouseholdChargeSession", () => {
  it("no-ops when the session never opted into platform_ledger funding", async () => {
    const { db, insertCalls, rpcCalls } = makeDb();
    const stripe = makeStripe({});
    const session = mockCheckoutSession({ metadata: { manager_user_id: "manager-1", manager_payout_cents: "12000" } });
    await creditProplaneBalanceFromHouseholdChargeSession(db, stripe, session);
    expect(insertCalls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it("no-ops when manager_payout_cents is missing or non-positive", async () => {
    const { db, insertCalls } = makeDb();
    const stripe = makeStripe({});
    const session = mockCheckoutSession({
      metadata: { funding_model: "platform_ledger", manager_user_id: "manager-1", manager_payout_cents: "0" },
    });
    await creditProplaneBalanceFromHouseholdChargeSession(db, stripe, session);
    expect(insertCalls).toHaveLength(0);
  });

  it("no-ops when there is no payment_intent on the session", async () => {
    const { db, insertCalls } = makeDb();
    const stripe = makeStripe({});
    const session = mockCheckoutSession({
      metadata: { funding_model: "platform_ledger", manager_user_id: "manager-1", manager_payout_cents: "12000" },
    });
    await creditProplaneBalanceFromHouseholdChargeSession(db, stripe, session);
    expect(insertCalls).toHaveLength(0);
  });

  it("credits a pending resident_payment entry, available_on from the charge's balance transaction", async () => {
    const { db, insertCalls } = makeDb();
    const stripe = makeStripe({ availableOnEpoch: 1_800_000_000 });
    await creditProplaneBalanceFromHouseholdChargeSession(db, stripe, platformLedgerSession);
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]?.row).toMatchObject({
      account_id: "acct-workspace-1",
      amount_cents: 12_000,
      kind: "resident_payment",
      status: "pending",
      available_on: new Date(1_800_000_000 * 1000).toISOString(),
      stripe_object_id: "ch_test_1",
      idempotency_key: "resident-payment:cs_test_ledger_1",
    });
  });

  it("falls back to 'now' when Stripe has not enriched the charge with a balance transaction yet", async () => {
    const { db, insertCalls } = makeDb();
    const stripe = makeStripe({ availableOnEpoch: null });
    const before = Date.now();
    await creditProplaneBalanceFromHouseholdChargeSession(db, stripe, platformLedgerSession);
    const availableOn = Date.parse(String(insertCalls[0]?.row.available_on));
    expect(availableOn).toBeGreaterThanOrEqual(before);
    expect(availableOn).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("no-ops when the payment intent has no charge at all", async () => {
    const { db, insertCalls } = makeDb();
    const stripe = {
      paymentIntents: { retrieve: async () => ({ id: "pi_test_1", latest_charge: null }) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as Stripe;
    await creditProplaneBalanceFromHouseholdChargeSession(db, stripe, platformLedgerSession);
    expect(insertCalls).toHaveLength(0);
  });
});
