import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: null as { id: string; email?: string } | null,
  payout: { payoutOwnerUserId: "owner-1" } as { payoutOwnerUserId: string; unresolvedReason?: string },
  access: { ok: true } as { ok: boolean; error?: string; status?: number },
  create: vi.fn(),
  ensure: vi.fn(),
  levels: [] as string[],
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: "o@example.com" } }) }) }) }) }),
}));
vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  resolveStripePayoutContext: async () => state.payout,
  stripePayoutContextStatus: (r?: string) => (r === "staff_managed_workspace" ? 403 : 409),
  stripePayoutContextError: () => "refused",
}));
vi.mock("@/lib/auth/co-manager-bank-account-access", () => ({
  assertCoManagerBankAccountAccess: async (_db: unknown, _u: string, _o: string, level: string) => { state.levels.push(level); return state.access; },
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    accounts: { retrieve: async () => ({ controller: { requirement_collection: "application", stripe_dashboard: { type: "none" } } }) },
    accountSessions: { create: state.create },
  }),
}));
vi.mock("@/lib/stripe-connect-account", () => ({ ensureManagerConnectAccountId: (...a: unknown[]) => state.ensure(...a) }));
vi.mock("@/lib/stripe-connect", () => ({
  ensureConnectAccountTransfersRequested: async () => ({}),
  isStripeConnectAccountAccessError: () => false,
}));

import { POST } from "@/app/api/stripe/connect/account-session/route";

const call = (component: unknown) =>
  POST(new Request("http://x/api/stripe/connect/account-session", { method: "POST", body: JSON.stringify({ component }) }));

beforeEach(() => {
  state.user = { id: "owner-1", email: "o@example.com" };
  state.payout = { payoutOwnerUserId: "owner-1" };
  state.access = { ok: true };
  state.levels = [];
  state.create.mockReset().mockResolvedValue({ client_secret: "cs_test_secret" });
  state.ensure.mockReset().mockResolvedValue("acct_own");
  process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY = "pk_test_123";
});

describe("account-session route authorization", () => {
  it("401 when signed out and never reaches Stripe", async () => {
    state.user = null;
    expect((await call("payouts")).status).toBe(401);
    expect(state.ensure).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("403 for PropLane staff in a managed workspace: no account is created or opened", async () => {
    state.payout = { payoutOwnerUserId: "", unresolvedReason: "staff_managed_workspace" };
    expect((await call("payouts")).status).toBe(403);
    expect(state.ensure).not.toHaveBeenCalled();
    expect(state.create).not.toHaveBeenCalled();
  });

  it("opens a session only for the resolved payout owner's own account", async () => {
    const res = await call("payouts");
    expect(res.status).toBe(200);
    expect(state.ensure.mock.calls[0]![2]).toMatchObject({ userId: "owner-1", allowClearStale: false });
    expect(state.create.mock.calls[0]![0]).toMatchObject({ account: "acct_own" });
  });

  it("payouts is read-only: read level, no money-moving features", async () => {
    await call("payouts");
    expect(state.levels).toEqual(["read"]);
    const params = state.create.mock.calls[0]![0] as { components: Record<string, { features: Record<string, boolean> }> };
    expect(Object.keys(params.components)).toEqual(["payouts"]);
    expect(params.components.payouts!.features).toMatchObject({ instant_payouts: false, standard_payouts: false, edit_payout_schedule: false, external_account_collection: false });
  });

  it("onboarding needs the edit grant", async () => {
    await call("account_onboarding");
    expect(state.levels).toEqual(["edit"]);
  });

  it("a refused co-manager never reaches Stripe", async () => {
    state.access = { ok: false, error: "no", status: 403 };
    expect((await call("account_onboarding")).status).toBe(403);
    expect(state.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown component", async () => {
    expect((await call("balances")).status).toBe(400);
  });

  it("the response carries only the client secret and publishable key, no bank or account detail", async () => {
    const body = await (await call("payouts")).json();
    expect(Object.keys(body).sort()).toEqual(["clientSecret", "publishableKey"]);
    expect(JSON.stringify(body)).not.toMatch(/acct_|routing|account_number/i);
  });
});
