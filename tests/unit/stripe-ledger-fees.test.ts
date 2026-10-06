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

type Hold = {
  source_fee_payer: string | null;
  source_verified_at: string | null;
  source_components: Array<{ source_id: string; principal_cents: number; recipient_net_cents: number }> | null;
};

function captureDb(holds: Hold[] = []) {
  const patches: Record<string, unknown>[] = [];
  const eqs: [string, unknown][] = [];
  const makeQuery = (table: string) => {
    let reading = false;
    const query = {
      update(patch: Record<string, unknown>) {
        patches.push(patch);
        return query;
      },
      eq(column: string, value: unknown) {
        if (!reading) eqs.push([column, value]);
        return query;
      },
      select() {
        return query;
      },
      limit() {
        return Promise.resolve(reading
          ? { data: holds, error: null }
          : { data: [{ id: "ledger-1" }], error: null });
      },
    };
    reading = table === "platform_payment_holds";
    return query;
  };
  const db = { from: (table: string) => makeQuery(table) } as unknown as SupabaseClient;
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

/**
 * A platform capture is created on PropLane's own account, so Stripe's fee is
 * PropLane's cost. The manager's row carries the capture's FROZEN per-charge
 * recipient net and only the fee the manager bears under the frozen fee payer —
 * never Stripe's balance-transaction net, which is the platform's figure.
 */
describe("platform capture (marked household payments): the frozen recipient terms, or unknown", () => {
  const platform = { destination: false };
  const verified = "2026-10-04T00:00:00Z";

  it("records the frozen recipient net and no manager fee when the resident paid it", async () => {
    const { db, patches } = captureDb([{
      source_fee_payer: "resident", source_verified_at: verified,
      source_components: [{ source_id: "chg-1", principal_cents: 100_000, recipient_net_cents: 100_000 }],
    }]);
    // Gross $1,029.50; Stripe nets PropLane $999.34. The manager is paid the
    // full $1,000.00 principal, so that — not $999.34 — is their net.
    await enrichLedgerFromCheckoutSession(db,
      stripeWith({ amount: 102_950, balance_transaction: { id: "txn_1", fee: 3_016, net: 99_934 } }, null, platform),
      session);

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ stripe_charge_id: "ch_test", net_cents: 100_000, stripe_fee_cents: 0 });
  });

  it("charges the manager only the processing fee they bear under a manager fee payer", async () => {
    const { db, patches } = captureDb([{
      source_fee_payer: "manager", source_verified_at: verified,
      source_components: [{ source_id: "chg-1", principal_cents: 100_000, recipient_net_cents: 97_050 }],
    }]);
    await enrichLedgerFromCheckoutSession(db,
      stripeWith({ amount: 100_000, balance_transaction: { id: "txn_1", fee: 3_200, net: 96_800 } }, null, platform),
      session);

    expect(patches[0]).toMatchObject({ net_cents: 97_050, stripe_fee_cents: 2_950 });
  });

  it("writes each charge of a whole-cart capture from its own component", async () => {
    const { db, patches, eqs } = captureDb([{
      source_fee_payer: "manager", source_verified_at: verified,
      source_components: [
        { source_id: "chg-a", principal_cents: 100_000, recipient_net_cents: 97_050 },
        { source_id: "chg-b", principal_cents: 20_000, recipient_net_cents: 19_410 },
      ],
    }]);
    await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 120_000 }, null, platform), session);

    expect(patches).toHaveLength(2);
    expect(patches[0]).toMatchObject({ net_cents: 97_050, stripe_fee_cents: 2_950 });
    expect(patches[1]).toMatchObject({ net_cents: 19_410, stripe_fee_cents: 590 });
    expect(eqs).toContainEqual(["source_charge_id", "chg-a"]);
    expect(eqs).toContainEqual(["source_charge_id", "chg-b"]);
  });

  it("leaves fee and net UNKNOWN (not 0, not gross) while the capture has no verified frozen terms", async () => {
    for (const hold of [[], [{ source_fee_payer: "manager", source_verified_at: null,
      source_components: [{ source_id: "chg-1", principal_cents: 100_000, recipient_net_cents: 97_050 }] }]]) {
      const { db, patches } = captureDb(hold as Hold[]);
      await enrichLedgerFromCheckoutSession(db,
        stripeWith({ amount: 544, balance_transaction: { id: "txn_1", fee: 44, net: 500 } }, null, platform), session);

      expect(patches[0]).toMatchObject({ stripe_charge_id: "ch_test" });
      expect(patches[0]).not.toHaveProperty("stripe_fee_cents");
      expect(patches[0]).not.toHaveProperty("net_cents");
    }
  });

  it("never records the platform's own balance-transaction net on the manager's book", async () => {
    const { db, patches } = captureDb();
    await enrichLedgerFromCheckoutSession(db,
      stripeWith({ amount: 544, balance_transaction: { id: "txn_1", fee: 44, net: 500 } }, null, platform), session);

    expect(patches[0]!.net_cents).toBeUndefined();
    expect(patches.some((patch) => patch.net_cents === 500 || patch.stripe_fee_cents === 44)).toBe(false);
  });

  it("leaves a malformed component unknown rather than recording a figure it does not support", async () => {
    const { db, patches } = captureDb([{
      source_fee_payer: "manager", source_verified_at: verified,
      source_components: [{ source_id: "chg-1", principal_cents: 100_000, recipient_net_cents: 100_001 }],
    }]);
    await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 100_000 }, null, platform), session);

    expect(patches[0]).toMatchObject({ stripe_charge_id: "ch_test" });
    expect(patches[0]).not.toHaveProperty("net_cents");
  });

  it("refuses to guess when the charge has ambiguous allocations", async () => {
    const twice: Hold[] = [1, 2].map(() => ({
      source_fee_payer: "manager", source_verified_at: verified,
      source_components: [{ source_id: "chg-1", principal_cents: 100_000, recipient_net_cents: 97_050 }],
    }));
    const { db, patches } = captureDb(twice);
    await enrichLedgerFromCheckoutSession(db, stripeWith({ amount: 100_000 }, null, platform), session);

    expect(patches[0]).toMatchObject({ stripe_charge_id: "ch_test" });
    expect(patches[0]).not.toHaveProperty("net_cents");
  });
});
