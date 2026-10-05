import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { enrichLedgerFromCheckoutSession } from "@/lib/stripe-ledger-fees";

// `ledger_entries` is the MANAGER's book. Resident payments are Connect
// destination charges created on PropLane's platform account, so Stripe's
// processing fee is debited from PropLane — never from the manager's payout.
// The manager's row must therefore show a 0 Stripe fee and a net equal to the
// destination transfer, or the ledger tells them they paid a fee that never
// left their money.

function captureDb() {
  const patches: Record<string, unknown>[] = [];
  const eqs: [string, unknown][] = [];
  const query = {
    update(patch: Record<string, unknown>) {
      patches.push(patch);
      return query;
    },
    eq(column: string, value: unknown) {
      eqs.push([column, value]);
      return query;
    },
    select() {
      return query;
    },
    limit() {
      return Promise.resolve({ data: [{ id: "ledger-1" }], error: null });
    },
  };
  const db = { from: () => query } as unknown as SupabaseClient;
  return { db, patches, eqs };
}

// `destination` models a Connect destination charge (legacy model); without it the PaymentIntent is a
// platform capture, which is how every marked household payment is created.
function stripeWith(
  charge: { amount: number; balance_transaction?: unknown },
  applicationFeeCents: number | null,
  opts: { destination?: boolean; balanceTransactions?: { retrieve: () => Promise<unknown> } } = { destination: true },
) {
  return {
    paymentIntents: {
      retrieve: async () => ({
        latest_charge: "ch_test", application_fee_amount: applicationFeeCents,
        transfer_data: opts.destination ? { destination: "acct_manager" } : null,
      }),
    },
    charges: {
      retrieve: async () => charge,
    },
    balanceTransactions: opts.balanceTransactions ?? { retrieve: async () => { throw new Error("no balance transaction"); } },
  } as unknown as Stripe;
}

const session = { id: "cs_test", payment_intent: "pi_test" } as Stripe.Checkout.Session;

describe("ledger fee attribution — PropLane bears Stripe's processing cost", () => {
  it("records a 0 Stripe fee and a net equal to the full subtotal", async () => {
    const { db, patches } = captureDb();
    // Face-value $1,800 rent: charged $1,800, no application fee, $1,800 transferred.
    await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 180_000 }, null), session);

    expect(patches).toHaveLength(1);
    expect(patches[0]!.stripe_fee_cents).toBe(0);
    expect(patches[0]!.net_cents).toBe(180_000);
    expect(patches[0]!.stripe_charge_id).toBe("ch_test");
  });

  it("nets out only what PropLane actually retained, never Stripe's fee", async () => {
    const { db, patches } = captureDb();
    // Defensive: if a platform fee were ever reintroduced, only THAT reduces the
    // manager's net. Stripe's own fee still stays off their book.
    await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 100_000 }, 500), session);

    expect(patches[0]!.stripe_fee_cents).toBe(0);
    expect(patches[0]!.axis_fee_cents).toBe(500);
    expect(patches[0]!.net_cents).toBe(99_500);
  });

  it("scopes the update to the payment row for this checkout session", async () => {
    const { db, eqs } = captureDb();
    await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 5_000 }, null), session);

    expect(eqs).toContainEqual(["entry_type", "payment"]);
    expect(eqs).toContainEqual(["stripe_checkout_session_id", "cs_test"]);
  });

  it("no-ops when the payment intent has no charge yet", async () => {
    const { db, patches } = captureDb();
    const stripe = {
      paymentIntents: { retrieve: async () => ({ latest_charge: null, application_fee_amount: null, transfer_data: null }) },
      charges: { retrieve: async () => ({ amount: 5_000 }) },
    } as unknown as Stripe;

    await enrichLedgerFromCheckoutSession(db, stripe, session);
    expect(patches).toHaveLength(0);
  });
});

describe("platform capture (marked household payments): Stripe's real fee/net, or unknown", () => {
  const platform = { destination: false };

  it("records the balance transaction's fee and net, and the charge id", async () => {
    const { db, patches } = captureDb();
    await enrichLedgerFromCheckoutSession(db,
      stripeWith({ amount: 544, balance_transaction: { id: "txn_1", fee: 44, net: 500 } }, null, platform), session);
    expect(patches[0]).toMatchObject({ stripe_charge_id: "ch_test", stripe_fee_cents: 44, net_cents: 500 });
  });

  it("reads a balance transaction that arrives as an id", async () => {
    const { db, patches } = captureDb();
    const retrieve = async () => ({ id: "txn_2", fee: 31, net: 469 });
    await enrichLedgerFromCheckoutSession(db,
      stripeWith({ amount: 500, balance_transaction: "txn_2" }, null, { destination: false, balanceTransactions: { retrieve } }), session);
    expect(patches[0]).toMatchObject({ stripe_fee_cents: 31, net_cents: 469 });
  });

  it("leaves fee and net UNKNOWN (not 0, not gross) while Stripe has posted no balance transaction", async () => {
    for (const balance_transaction of [null, undefined]) {
      const { db, patches } = captureDb();
      await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 544, balance_transaction }, null, platform), session);
      expect(patches[0]).toMatchObject({ stripe_charge_id: "ch_test" });
      expect(patches[0]).not.toHaveProperty("stripe_fee_cents");
      expect(patches[0]).not.toHaveProperty("net_cents");
    }
  });

  it("leaves fee and net unknown when the balance transaction cannot be read, and still records the charge", async () => {
    const { db, patches } = captureDb();
    await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 544, balance_transaction: "txn_missing" }, null, platform), session);
    expect(patches[0]).toMatchObject({ stripe_charge_id: "ch_test" });
    expect(patches[0]).not.toHaveProperty("stripe_fee_cents");
    expect(patches[0]).not.toHaveProperty("net_cents");
  });

  it("never reads a malformed balance transaction as zero", async () => {
    const { db, patches } = captureDb();
    await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 544, balance_transaction: { id: "txn_x", fee: null, net: "500" } }, null, platform), session);
    expect(patches[0]).not.toHaveProperty("stripe_fee_cents");
    expect(patches[0]).not.toHaveProperty("net_cents");
  });
});
