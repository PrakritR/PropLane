/**
 * `handleExternalAccountEvent` — the `account.external_account.created|updated|deleted`
 * webhook (PLAN-0920-1500 part B). Scoped by `event.account` (the Connect
 * account the event happened on), never by anything in the payload body, and
 * it must never write anything beyond what a live Stripe read already
 * returns (no full account/card numbers).
 */
import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { handleExternalAccountEvent } from "@/lib/stripe-webhook-financials";

type Row = Record<string, unknown>;

function makeDb(opts: { ownerUserId: string | null }) {
  const cache: Row[] = [];
  let nextVersion = 0;
  let appliedVersion = 0;
  return {
    cache,
    client: {
      async rpc(name: string, args: Record<string, unknown>) {
        if (name === "begin_payout_destination_cache_refresh") return { data: ++nextVersion, error: null };
        if (name === "finish_payout_destination_cache_refresh") {
          const version = Number(args.p_version);
          if (version <= appliedVersion) return { data: false, error: null };
          cache.splice(0, cache.length, ...(args.p_destinations as Row[]).map((row) => ({
            owner_user_id: args.p_owner_user_id, stripe_external_account_id: row.id,
            kind: row.kind, label: row.label, last4: row.last4,
            status: row.status, is_default: row.is_default,
          })));
          appliedVersion = version;
          return { data: true, error: null };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
      from(table: string) {
        if (table === "profiles") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: opts.ownerUserId ? { id: opts.ownerUserId } : null, error: null }),
              }),
            }),
          };
        }
        if (table === "payout_destinations_cache") {
          return {
            delete: () => ({
              eq: (col: string, value: unknown) => {
                for (let i = cache.length - 1; i >= 0; i -= 1) {
                  if (cache[i]![col] === value) cache.splice(i, 1);
                }
                return Promise.resolve({ error: null });
              },
            }),
            insert: (rows: Row | Row[]) => {
              const list = Array.isArray(rows) ? rows : [rows];
              cache.push(...list);
              return Promise.resolve({ error: null });
            },
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    },
  };
}

function makeStripe(externalAccounts: Stripe.ExternalAccount[]) {
  return {
    accounts: {
      retrieve: vi.fn().mockResolvedValue({ id: "acct_1", metadata: { axis_user_id: "owner-1" }, external_accounts: { data: externalAccounts } }),
    },
  } as unknown as Stripe;
}

const bankAccount = {
  id: "ba_1",
  object: "bank_account",
  bank_name: "Chase",
  last4: "4321",
  status: "verified",
  default_for_currency: true,
} as unknown as Stripe.BankAccount;

describe("handleExternalAccountEvent", () => {
  it("no-ops when the connected account id is missing", async () => {
    const db = makeDb({ ownerUserId: "owner-1" });
    const stripe = makeStripe([bankAccount]);
    await handleExternalAccountEvent(stripe, db.client as never, null);
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(db.cache).toHaveLength(0);
  });

  it("no-ops when no profile owns this Connect account id", async () => {
    const db = makeDb({ ownerUserId: null });
    const stripe = makeStripe([bankAccount]);
    await handleExternalAccountEvent(stripe, db.client as never, "acct_1");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(db.cache).toHaveLength(0);
  });

  it("refreshes the display cache from a live Stripe read, scoped by event.account", async () => {
    const db = makeDb({ ownerUserId: "owner-1" });
    const stripe = makeStripe([bankAccount]);
    await handleExternalAccountEvent(stripe, db.client as never, "acct_1");
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith("acct_1");
    expect(db.cache).toEqual([
      expect.objectContaining({
        owner_user_id: "owner-1",
        stripe_external_account_id: "ba_1",
        kind: "bank",
        label: "Chase",
        last4: "4321",
        status: "verified",
        is_default: true,
      }),
    ]);
    // No full account number ever lands in the cache.
    expect(JSON.stringify(db.cache)).not.toMatch(/\d{6,}/);
  });

  it("an account.external_account.deleted event clears a removed destination from the cache", async () => {
    const db = makeDb({ ownerUserId: "owner-1" });
    db.cache.push({ owner_user_id: "owner-1", stripe_external_account_id: "ba_1", kind: "bank" });
    const stripe = makeStripe([]); // Stripe now reports zero external accounts.
    await handleExternalAccountEvent(stripe, db.client as never, "acct_1");
    expect(db.cache).toHaveLength(0);
  });
});
