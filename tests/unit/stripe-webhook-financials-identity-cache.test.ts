import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { handleStripeAccountUpdated } from "@/lib/stripe-webhook-financials";

/**
 * `account.updated` refreshes `payout_identity_status` scoped to THAT event's
 * own account/owner only — never touches another owner's cached row.
 */
function fakeDb() {
  const profileByAccountId: Record<string, { id: string }> = {
    acct_owner_a: { id: "owner-a" },
    acct_owner_b: { id: "owner-b" },
  };
  const upserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const profileUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const db = {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: (_col: string, accountId: string) => ({
              maybeSingle: async () => ({ data: profileByAccountId[accountId] ?? null, error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              profileUpdates.push({ id, patch });
              return { error: null };
            },
          }),
        };
      }
      if (table === "payout_identity_status") {
        return {
          upsert: async (row: Record<string, unknown>) => {
            upserts.push({ table, row });
            return { error: null };
          },
        };
      }
      if (table === "test_workspace_members") {
        // The webhook now checks test-workspace classification before every
        // financial mutation. No fixture here is a member, so every account
        // resolves to a normal (non-test) workspace and the real assertions
        // below are unaffected.
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { db, upserts, profileUpdates };
}

function account(overrides: Partial<Stripe.Account>): Stripe.Account {
  return {
    id: "acct_x",
    object: "account",
    charges_enabled: true,
    payouts_enabled: true,
    capabilities: { transfers: "active" },
    requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null },
    details_submitted: true,
    metadata: {},
    ...overrides,
  } as unknown as Stripe.Account;
}

describe("handleStripeAccountUpdated — payout_identity_status cache refresh is scoped per event", () => {
  it("upserts only the row for THIS event's account, never a different owner's", async () => {
    const { db, upserts } = fakeDb();

    await handleStripeAccountUpdated(db as never, account({
      id: "acct_owner_a",
      requirements: { currently_due: ["individual.ssn_last_4"], past_due: [], pending_verification: [], disabled_reason: null },
      details_submitted: true,
    }));

    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.row).toMatchObject({ owner_user_id: "owner-a", status: "needs_info" });

    await handleStripeAccountUpdated(db as never, account({
      id: "acct_owner_b",
      requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null },
      details_submitted: true,
    }));

    expect(upserts).toHaveLength(2);
    expect(upserts[1]!.row).toMatchObject({ owner_user_id: "owner-b", status: "verified" });
    // The first owner's row is untouched by the second event.
    expect(upserts[0]!.row.owner_user_id).toBe("owner-a");
  });

  it("does nothing when the account cannot be resolved to any owner", async () => {
    const { db, upserts } = fakeDb();
    await handleStripeAccountUpdated(db as never, account({ id: "acct_unknown" }));
    expect(upserts).toHaveLength(0);
  });
});
