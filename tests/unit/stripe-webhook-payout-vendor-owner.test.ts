/**
 * `upsertStripePayoutRecord` stamps `vendor_user_id` only for a genuinely
 * vendor-owned Connect account, decided from `profile_roles` — never from
 * how many listings the owner has. A manager with zero listings (payouts set
 * up before the first listing, or every listing deleted) is still a manager,
 * so their payout rows never read as vendor rows to the purge manifest.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import { upsertStripePayoutRecord } from "@/lib/stripe-webhook-financials";

let roleRows: { role: string }[] = [];
let legacyRole: string | null = null;
let upserted: Record<string, unknown> | null = null;

function makeDb() {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        then(resolve: (v: { data: unknown; error: null }) => unknown) {
          return Promise.resolve({ data: table === "profile_roles" ? roleRows : [], error: null }).then(resolve);
        },
        maybeSingle: async () => ({
          data: table === "profiles" ? { role: legacyRole } : null,
          error: null,
        }),
        upsert: async (patch: Record<string, unknown>) => {
          if (table === "stripe_payouts") upserted = patch;
          return { error: null };
        },
      };
      return builder;
    },
  };
}

const payout = {
  id: "po_1",
  amount: 5000,
  currency: "usd",
  status: "paid",
  method: "standard",
  type: "bank_account",
  arrival_date: null,
  failure_code: null,
  failure_message: null,
  destination: null,
} as unknown as Stripe.Payout;

beforeEach(() => {
  roleRows = [];
  legacyRole = null;
  upserted = null;
});

describe("upsertStripePayoutRecord — vendor vs manager owner", () => {
  it("a manager with the manager role and no listings is NOT stamped as a vendor", async () => {
    roleRows = [{ role: "manager" }];
    await upsertStripePayoutRecord(makeDb() as never, "mgr-1", payout, "acct_1");
    expect(upserted).not.toBeNull();
    expect(upserted).not.toHaveProperty("vendor_user_id");
  });

  it("a vendor-only account is stamped with vendor_user_id", async () => {
    roleRows = [{ role: "vendor" }];
    await upsertStripePayoutRecord(makeDb() as never, "vendor-1", payout, "acct_2");
    expect(upserted).toMatchObject({ vendor_user_id: "vendor-1" });
  });

  it("an account holding both roles is treated as a manager", async () => {
    roleRows = [{ role: "vendor" }, { role: "manager" }];
    await upsertStripePayoutRecord(makeDb() as never, "both-1", payout, "acct_3");
    expect(upserted).not.toHaveProperty("vendor_user_id");
  });

  it("falls back to legacy profiles.role when no role rows exist", async () => {
    legacyRole = "vendor";
    await upsertStripePayoutRecord(makeDb() as never, "legacy-vendor", payout, "acct_4");
    expect(upserted).toMatchObject({ vendor_user_id: "legacy-vendor" });
  });
});
