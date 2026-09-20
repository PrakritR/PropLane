import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PLAN-0920-1500 Part C: a NEW (application-collected) account never gets
 * `mode: "embedded"` from the onboard routes — it 409s `USE_IN_APP_IDENTITY`
 * so the client opens the Verify-identity sheet instead. A legacy
 * `stripe_dashboard.type: "express"` account is unaffected (see
 * stripe-connect-onboard-embedded.test.ts).
 */

const payout = {
  payoutOwnerUserId: "owner-1",
  canEditBankAccount: true,
  isCoManagerForPayout: false,
  unresolvedReason: undefined as string | undefined,
};
vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  resolveStripePayoutContext: async () => payout,
  stripePayoutContextError: () => "unresolved",
}));
vi.mock("@/lib/auth/co-manager-bank-account-access", () => ({
  assertCoManagerBankAccountAccess: async () => ({ ok: true }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "caller-1" } } }) },
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "vendor" } }) }) }) }),
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "m@example.com" } }) }) }) }),
  }),
}));

const stripe = { accountLinks: { create: vi.fn() }, accounts: { createLoginLink: vi.fn() } };
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe, stripeConnectRedirectOriginError: () => null }));

vi.mock("@/lib/stripe-connect-account", () => ({
  ensureManagerConnectAccountId: vi.fn().mockResolvedValue("acct_1"),
  ensureVendorConnectAccountId: vi.fn().mockResolvedValue("acct_v1"),
}));

const applicationCollectedAccount = {
  id: "acct_1",
  details_submitted: false,
  payouts_enabled: false,
  capabilities: { transfers: "pending" as const },
  controller: { type: "application" as const, stripe_dashboard: { type: "none" as const } },
};
vi.mock("@/lib/stripe-connect", () => ({
  connectAccountReadyForAchPayouts: () => false,
  connectAccountTransfersActive: () => false,
  ensureConnectAccountTransfersRequested: async () => applicationCollectedAccount,
  isApplicationCollected: (account: { controller?: { stripe_dashboard?: { type?: string } } }) =>
    account.controller?.stripe_dashboard?.type === "none",
  isStripeConnectAccountAccessError: () => false,
  clearManagerConnectAccountId: vi.fn(),
  resolveManagerConnectAccountId: vi.fn().mockResolvedValue(null),
}));

import { POST as managerOnboard } from "@/app/api/stripe/connect/onboard/route";
import { POST as vendorOnboard } from "@/app/api/vendor/stripe-connect/onboard/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/stripe/connect/onboard — application-collected account", () => {
  it("409s USE_IN_APP_IDENTITY instead of returning mode: embedded", async () => {
    const req = new Request("http://x/api/stripe/connect/onboard", { method: "POST" });
    const res = await managerOnboard(req);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "USE_IN_APP_IDENTITY", accountId: "acct_1" });
    expect(body.mode).toBeUndefined();
  });
});

describe("POST /api/vendor/stripe-connect/onboard — application-collected account", () => {
  it("409s USE_IN_APP_IDENTITY instead of returning mode: embedded", async () => {
    const req = new Request("http://x/api/vendor/stripe-connect/onboard", { method: "POST" });
    const res = await vendorOnboard(req);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "USE_IN_APP_IDENTITY", accountId: "acct_v1" });
    expect(body.mode).toBeUndefined();
  });
});
