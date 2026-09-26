import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET status is a READ. `ensureConnectAccountTransfersRequested` is not: it PATCHes
 * the Connect account when the transfers capability has never been requested, so
 * calling it unconditionally let a co-manager with no `bankAccount` grant mutate the
 * owner's Stripe account merely by loading the payments page.
 *
 * A SEPARATE bug this file now also guards: this route used to have NO
 * permission gate at all before reading the owner's Stripe status/balance —
 * `resolveStripePayoutContext` resolving to a real owner id (true for ANY
 * accepted co-manager, regardless of module grants) was enough on its own.
 * A "Leasing"-role co-manager, whose grant never touches `bankAccount`, could
 * see the property owner's full Connect readiness state. The route must now
 * refuse (403) before reading anything when the caller lacks even `read`.
 */
const payout = {
  payoutOwnerUserId: "owner-1",
  canEditBankAccount: true,
  canViewBankAccount: true,
  isCoManagerForPayout: false,
  unresolvedReason: undefined as string | undefined,
};
vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  resolveStripePayoutContext: async () => payout,
  stripePayoutContextError: () => "unresolved",
}));
vi.mock("@/lib/auth/co-manager-bank-account-access", () => ({
  assertCoManagerBankAccountAccess: async () => {
    if (!payout.isCoManagerForPayout) return { ok: true };
    if (payout.canViewBankAccount) return { ok: true };
    return { ok: false, status: 403, error: "You do not have permission to view this account's payout details." };
  },
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "caller-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { stripe_connect_account_id: "acct_1" } }) }) }),
    }),
  }),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe }));

const accountsUpdate = vi.fn();
const stripe = { accounts: { update: accountsUpdate } };

const retrieved = {
  id: "acct_1",
  charges_enabled: true,
  payouts_enabled: true,
  details_submitted: true,
  // Never requested — exactly the shape that makes the helper issue an update.
  capabilities: { transfers: "inactive" as const },
};
const retrieveManagerConnectAccountOrNull = vi.fn(async () => retrieved);
const ensureConnectAccountTransfersRequested = vi.fn(async () => {
  await stripe.accounts.update("acct_1", { capabilities: { transfers: { requested: true } } });
  return { ...retrieved, capabilities: { transfers: "pending" as const } };
});
vi.mock("@/lib/stripe-connect", () => ({
  clearManagerConnectAccountId: vi.fn(),
  connectAccountReadyForAchPayouts: () => false,
  connectAccountTransfersActive: (account: { capabilities?: { transfers?: string } }) =>
    account.capabilities?.transfers === "active",
  ensureConnectAccountTransfersRequested: (...args: unknown[]) =>
    ensureConnectAccountTransfersRequested(...(args as [])),
  isStripeConnectAccountAccessError: () => false,
  retrieveManagerConnectAccountOrNull: (...args: unknown[]) =>
    retrieveManagerConnectAccountOrNull(...(args as [])),
}));

import { GET } from "@/app/api/stripe/connect/status/route";

beforeEach(() => {
  vi.clearAllMocks();
  payout.payoutOwnerUserId = "owner-1";
  payout.canEditBankAccount = true;
  payout.canViewBankAccount = true;
  payout.isCoManagerForPayout = false;
});

describe("GET /api/stripe/connect/status", () => {
  it("refuses a co-manager with no bankAccount grant at all before reading anything — never touches Stripe", async () => {
    payout.canEditBankAccount = false;
    payout.canViewBankAccount = false;
    payout.isCoManagerForPayout = true;

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({ isCoManagerForPayout: true, canViewBankAccount: false });
    expect(retrieveManagerConnectAccountOrNull).not.toHaveBeenCalled();
    expect(ensureConnectAccountTransfersRequested).not.toHaveBeenCalled();
    expect(accountsUpdate).not.toHaveBeenCalled();
  });

  it("never mutates the owner's Stripe account for a read-only co-manager", async () => {
    payout.canEditBankAccount = false;
    payout.canViewBankAccount = true;
    payout.isCoManagerForPayout = true;

    const body = await (await GET()).json();

    expect(ensureConnectAccountTransfersRequested).not.toHaveBeenCalled();
    expect(accountsUpdate).not.toHaveBeenCalled();
    // The read still succeeds, reporting the account exactly as retrieved.
    expect(body).toMatchObject({
      connected: true,
      accountId: "acct_1",
      transfersEnabled: false,
      transfersStatus: "inactive",
      canEditBankAccount: false,
      isCoManagerForPayout: true,
    });
  });

  it("still requests the transfers capability for a caller who may change bank details", async () => {
    const body = await (await GET()).json();

    expect(ensureConnectAccountTransfersRequested).toHaveBeenCalledTimes(1);
    expect(accountsUpdate).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ connected: true, accountId: "acct_1", transfersStatus: "pending" });
  });

  it("the property owner (not a co-manager) always passes, with no grant lookup needed", async () => {
    payout.isCoManagerForPayout = false;
    payout.canEditBankAccount = true;
    payout.canViewBankAccount = true;

    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ connected: true, accountId: "acct_1" });
  });
});
