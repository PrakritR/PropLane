import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PLAN-0920-0853: the onboard routes must never mint or return a
 * Stripe-hosted URL (an Account Link to connect.stripe.com, or an Express
 * Dashboard login link) — identity and bank linking are Stripe's embedded
 * components mounted inside PropLane's own modal via the account-session
 * routes instead.
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

const stripe = {
  accountLinks: { create: vi.fn() },
  accounts: { createLoginLink: vi.fn() },
};
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe, stripeConnectRedirectOriginError: () => null }));

vi.mock("@/lib/stripe-connect-account", () => ({
  ensureManagerConnectAccountId: vi.fn().mockResolvedValue("acct_1"),
  ensureVendorConnectAccountId: vi.fn().mockResolvedValue("acct_v1"),
}));

const account = {
  id: "acct_1",
  details_submitted: true,
  payouts_enabled: true,
  capabilities: { transfers: "active" as const },
};
vi.mock("@/lib/stripe-connect", () => ({
  connectAccountReadyForAchPayouts: () => true,
  connectAccountTransfersActive: () => true,
  ensureConnectAccountTransfersRequested: async () => account,
  isStripeConnectAccountAccessError: () => false,
  clearManagerConnectAccountId: vi.fn(),
  resolveManagerConnectAccountId: vi.fn().mockResolvedValue(null),
}));

import { POST as managerOnboard } from "@/app/api/stripe/connect/onboard/route";
import { POST as vendorOnboard } from "@/app/api/vendor/stripe-connect/onboard/route";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/stripe/connect/onboard", () => {
  it("never returns a hosted Stripe URL — reports embedded mode instead", async () => {
    const req = new Request("http://x/api/stripe/connect/onboard", { method: "POST" });
    const body = await (await managerOnboard(req)).json();
    expect(body).toMatchObject({ mode: "embedded", accountId: "acct_1", connected: true, paymentReady: true });
    expect(body.url).toBeUndefined();
    expect(stripe.accountLinks.create).not.toHaveBeenCalled();
    expect(stripe.accounts.createLoginLink).not.toHaveBeenCalled();
  });
});

describe("POST /api/vendor/stripe-connect/onboard", () => {
  it("never returns a hosted Stripe URL — reports embedded mode instead", async () => {
    const req = new Request("http://x/api/vendor/stripe-connect/onboard", { method: "POST" });
    const body = await (await vendorOnboard(req)).json();
    expect(body).toMatchObject({ mode: "embedded", accountId: "acct_v1", connected: true, paymentReady: true });
    expect(body.url).toBeUndefined();
    expect(stripe.accountLinks.create).not.toHaveBeenCalled();
    expect(stripe.accounts.createLoginLink).not.toHaveBeenCalled();
  });
});

describe("guard: no hosted Stripe URL anywhere in the onboard route source", () => {
  it("the onboard route files never reference connect.stripe.com or createLoginLink", async () => {
    const fs = await import("node:fs/promises");
    const managerSrc = await fs.readFile("src/app/api/stripe/connect/onboard/route.ts", "utf8");
    const vendorSrc = await fs.readFile("src/app/api/vendor/stripe-connect/onboard/route.ts", "utf8");
    for (const src of [managerSrc, vendorSrc]) {
      expect(src).not.toMatch(/connect\.stripe\.com/);
      expect(src).not.toMatch(/accountLinks\.create/);
      expect(src).not.toMatch(/createLoginLink/);
    }
  });
});
