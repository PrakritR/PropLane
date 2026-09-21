import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Identity is personal to the payout owner (legal name, DOB, SSN) — unlike
 * bank-account edits, a co-manager's `bankAccount` grant never authorizes
 * submitting or uploading someone else's identity details. GET (read-only
 * field labels/status, never a filled-in value) still allows a co-manager
 * with read access, same as the other Payouts settings routes.
 */

const payout: {
  payoutOwnerUserId: string;
  canEditBankAccount: boolean;
  isCoManagerForPayout: boolean;
  unresolvedReason: string | undefined;
} = {
  payoutOwnerUserId: "owner-1",
  canEditBankAccount: true,
  isCoManagerForPayout: false,
  unresolvedReason: undefined,
};

vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  resolveStripePayoutContext: async () => payout,
  stripePayoutContextError: () => "unresolved",
}));
vi.mock("@/lib/auth/co-manager-bank-account-access", () => ({
  assertCoManagerBankAccountAccess: async (_db: unknown, _userId: string, _ownerId: string, level: string) => {
    if (level === "read") return { ok: true };
    return { ok: true };
  },
}));

let callerId = "owner-1";
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: callerId } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "owner@example.com" } }) }) }) }),
  }),
}));

const stripe = { accounts: { retrieve: vi.fn(), update: vi.fn(), updatePerson: vi.fn() } };
vi.mock("@/lib/stripe", () => ({ getStripe: () => stripe }));
vi.mock("@/lib/stripe-connect-account", () => ({
  ensureManagerConnectAccountId: vi.fn().mockResolvedValue("acct_1"),
}));
vi.mock("@/lib/stripe-connect", () => ({
  isStripeConnectAccountAccessError: () => false,
}));

const getIdentityRequirements = vi.fn().mockResolvedValue({
  status: "needs_info",
  fields: [],
  fallbackToEmbedded: false,
  currentlyDue: [],
  disabledReason: null,
  isApplicationCollected: true,
});
const submitIdentity = vi.fn().mockResolvedValue({ ok: true, status: "pending", fallbackToEmbedded: false });
vi.mock("@/lib/stripe-connect-identity.server", () => ({
  getIdentityRequirements: (...args: unknown[]) => getIdentityRequirements(...args),
  submitIdentity: (...args: unknown[]) => submitIdentity(...args),
}));

import { GET, POST } from "@/app/api/stripe/connect/identity/route";

beforeEach(() => {
  vi.clearAllMocks();
  getIdentityRequirements.mockResolvedValue({
    status: "needs_info",
    fields: [],
    fallbackToEmbedded: false,
    currentlyDue: [],
    disabledReason: null,
    isApplicationCollected: true,
  });
  submitIdentity.mockResolvedValue({ ok: true, status: "pending", fallbackToEmbedded: false });
  payout.payoutOwnerUserId = "owner-1";
  payout.isCoManagerForPayout = false;
  callerId = "owner-1";
});

describe("GET /api/stripe/connect/identity", () => {
  it("returns the requirements spec for the owner", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isApplicationCollected).toBe(true);
  });

  it("allows a co-manager with read access", async () => {
    payout.isCoManagerForPayout = true;
    callerId = "comgr-1";
    const res = await GET();
    expect(res.status).toBe(200);
  });
});

describe("POST /api/stripe/connect/identity — 403 for a foreign user and for a co-manager", () => {
  it("403s a caller who is not the payout owner (plain foreign user)", async () => {
    callerId = "someone-else";
    payout.payoutOwnerUserId = "owner-1";
    const req = new Request("http://x/api/stripe/connect/identity", {
      method: "POST",
      body: JSON.stringify({ fields: { business_type: "individual" } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(submitIdentity).not.toHaveBeenCalled();
  });

  it("403s a co-manager even with an edit grant — identity is never delegated", async () => {
    callerId = "comgr-1";
    payout.payoutOwnerUserId = "owner-1";
    payout.isCoManagerForPayout = true;
    payout.canEditBankAccount = true; // has bank-edit access, but identity is stricter
    const req = new Request("http://x/api/stripe/connect/identity", {
      method: "POST",
      body: JSON.stringify({ fields: { business_type: "individual" } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(submitIdentity).not.toHaveBeenCalled();
  });

  it("allows the owner and forwards the token/fields to submitIdentity", async () => {
    callerId = "owner-1";
    payout.payoutOwnerUserId = "owner-1";
    const req = new Request("http://x/api/stripe/connect/identity", {
      method: "POST",
      body: JSON.stringify({ accountToken: "acct_tok_1", fields: { business_type: "individual" } }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(submitIdentity).toHaveBeenCalledTimes(1);
    const [, , input] = submitIdentity.mock.calls[0]!;
    expect(input.accountToken).toBe("acct_tok_1");
    expect(input.tosAcceptance).toBeTruthy();
  });
});
