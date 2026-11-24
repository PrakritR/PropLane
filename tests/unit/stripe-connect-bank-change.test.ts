import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  bankChangeAccountLinkParams,
  bankChangeErrorMessage,
  bankChangeReturnUrl,
  planBankChange,
} from "@/lib/stripe-connect-bank-change";

describe("planBankChange", () => {
  it("an application-collected account changes its bank in PropLane's own sheet", () => {
    expect(planBankChange({ details_submitted: true, controller: { stripe_dashboard: { type: "none" } } as never })).toEqual({ mode: "in_app" });
  });
  it("a legacy Express account that finished onboarding opens the Express dashboard, then an update link", () => {
    expect(planBankChange({ details_submitted: true, controller: { stripe_dashboard: { type: "express" } } as never })).toEqual({
      mode: "hosted",
      attempts: [{ kind: "login_link" }, { kind: "account_link", type: "account_update" }],
    });
  });
  it("an account that has not finished onboarding can only use the onboarding link (Stripe refuses a login link)", () => {
    expect(planBankChange({ details_submitted: false, controller: { stripe_dashboard: { type: "express" } } as never })).toEqual({
      mode: "hosted",
      attempts: [{ kind: "account_link", type: "account_onboarding" }],
    });
  });
  it("any other submitted account tries an update link, then onboarding", () => {
    expect(planBankChange({ details_submitted: true, controller: null })).toEqual({
      mode: "hosted",
      attempts: [{ kind: "account_link", type: "account_update" }, { kind: "account_link", type: "account_onboarding" }],
    });
  });
});

describe("account link URLs", () => {
  it("returns to the payments tab of the given origin with a bank marker, one per outcome", () => {
    expect(bankChangeReturnUrl("https://proplane.ai", "returned")).toBe("https://proplane.ai/portal/profile?tab=payments&bank=returned");
    expect(bankChangeReturnUrl("https://proplane.ai/", "refresh", "ws 1")).toBe("https://proplane.ai/portal/profile?tab=payments&workspace=ws+1&bank=refresh");
  });
  it("builds Stripe's params with distinct return and refresh URLs on the canonical origin", () => {
    const params = bankChangeAccountLinkParams("acct_1", "account_update", "https://proplane.ai", "w1");
    expect(params).toMatchObject({ account: "acct_1", type: "account_update" });
    expect(params.return_url).toBe("https://proplane.ai/portal/profile?tab=payments&workspace=w1&bank=returned");
    expect(params.refresh_url).toBe("https://proplane.ai/portal/profile?tab=payments&workspace=w1&bank=refresh");
    expect(params.return_url).not.toBe(params.refresh_url);
  });
});

describe("bankChangeErrorMessage", () => {
  it("never answers blank and names the cause", () => {
    expect(bankChangeErrorMessage(null)).toMatch(/try again/i);
    expect(bankChangeErrorMessage(new Error("You can only create login links for accounts that have completed onboarding. Login link"))).toMatch(/onboarding/i);
    expect(bankChangeErrorMessage(new Error("Invalid URL: must be https"))).toMatch(/public address/i);
    expect(bankChangeErrorMessage(new Error("boom"))).toContain("boom");
  });
});

const state = vi.hoisted(() => ({
  user: { id: "owner-1" } as { id: string } | null,
  payout: { payoutOwnerUserId: "owner-1" } as { payoutOwnerUserId: string; unresolvedReason?: string },
  account: { id: "acct_1", metadata: { axis_user_id: "owner-1" }, details_submitted: true, controller: { stripe_dashboard: { type: "express" } } } as Record<string, unknown>,
  accountId: "acct_1" as string | null,
  loginLink: vi.fn(),
  accountLink: vi.fn(),
  staffContext: { staff: false } as { staff: boolean; workspaceId?: string; workspaceName?: string; ownerUserId?: string },
  sendOwnerLink: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/auth/manager-stripe-payout-access.server", () => ({
  resolveStripePayoutContext: async () => state.payout,
  stripePayoutContextStatus: () => 403,
  stripePayoutContextError: () => "Payout setup belongs to the owner.",
}));
vi.mock("@/lib/auth/co-manager-bank-account-access", () => ({ assertCoManagerBankAccountAccess: async () => ({ ok: true }) }));
vi.mock("@/lib/managed-finance/payout-setup.server", () => ({
  activeWorkspaceIdFromCookie: async () => "ws-1",
  resolveManagedPayoutStaffContext: async () => state.staffContext,
  sendOwnerPayoutSetupLink: state.sendOwnerLink,
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({ accounts: { createLoginLink: state.loginLink }, accountLinks: { create: state.accountLink } }),
}));
vi.mock("@/lib/stripe-connect", () => ({ resolveManagerConnectAccountId: async () => state.accountId }));
vi.mock("@/lib/stripe-external-accounts.server", () => ({ assertOwnedPayoutAccount: async () => state.account }));

import { POST } from "@/app/api/stripe/connect/change-bank/route";

const call = () => POST(new Request("https://proplane.ai/api/stripe/connect/change-bank", { method: "POST", body: "{}" }));

beforeEach(() => {
  state.user = { id: "owner-1" };
  state.payout = { payoutOwnerUserId: "owner-1" };
  state.accountId = "acct_1";
  state.account = { id: "acct_1", metadata: { axis_user_id: "owner-1" }, details_submitted: true, controller: { stripe_dashboard: { type: "express" } } };
  state.staffContext = { staff: false };
  state.sendOwnerLink.mockReset().mockResolvedValue({ ok: true, status: "sent" });
  state.loginLink.mockReset().mockResolvedValue({ url: "https://connect.stripe.com/express/login" });
  state.accountLink.mockReset().mockResolvedValue({ url: "https://connect.stripe.com/setup/abc" });
});

describe("POST /api/stripe/connect/change-bank", () => {
  it("401 signed out, and a staff/unresolved owner is refused before Stripe is touched", async () => {
    state.user = null;
    expect((await call()).status).toBe(401);
    state.user = { id: "staff-1" };
    state.payout = { payoutOwnerUserId: "", unresolvedReason: "staff_managed_workspace" };
    const res = await call();
    expect(res.status).toBe(403);
    expect(state.loginLink).not.toHaveBeenCalled();
    expect(state.accountLink).not.toHaveBeenCalled();
  });

  it("a legacy Express account gets the Express dashboard link", async () => {
    const res = await call();
    expect(await res.json()).toEqual({ mode: "redirect", url: "https://connect.stripe.com/express/login", via: "login_link" });
    expect(state.accountLink).not.toHaveBeenCalled();
  });

  it("falls back to an update link on the canonical origin when the login link fails", async () => {
    state.loginLink.mockRejectedValue(new Error("no login"));
    const res = await call();
    expect(await res.json()).toMatchObject({ mode: "redirect", via: "account_update" });
    expect(state.accountLink).toHaveBeenCalledWith({
      account: "acct_1",
      type: "account_update",
      return_url: "https://proplane.ai/portal/profile?tab=payments&workspace=ws-1&bank=returned",
      refresh_url: "https://proplane.ai/portal/profile?tab=payments&workspace=ws-1&bank=refresh",
    });
  });

  it("an application-collected account answers in_app and no hosted link is minted", async () => {
    state.account = { ...state.account, controller: { stripe_dashboard: { type: "none" } } };
    expect(await (await call()).json()).toEqual({ mode: "in_app" });
    expect(state.loginLink).not.toHaveBeenCalled();
    expect(state.accountLink).not.toHaveBeenCalled();
  });

  it("every Stripe failure is a real message, never a blank", async () => {
    state.loginLink.mockRejectedValue(new Error("nope"));
    state.accountLink.mockRejectedValue(new Error("Stripe is down"));
    const res = await call();
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe("BANK_CHANGE_UNAVAILABLE");
    expect(body.error).toContain("Stripe is down");
  });

  it("422 when there is no payout account to change", async () => {
    state.accountId = null;
    expect((await call()).status).toBe(422);
  });
});

// A bank change moves where somebody else's money lands, and the hosted paths are worse than that: an Express
// login link signs the holder into their WHOLE Stripe dashboard (balance, payout history, tax and account
// settings) and an Account Link re-onboards the account. Oracle: this change's own rule for staff on a managed
// workspace — "Staff never change an owner's bank (Stripe needs the account holder): the owner does, signed in as
// themselves" (portal-payouts-settings-page.tsx) — applied to every non-owner. Plausible wrong behaviour this
// rejects: a co-manager holding `bankAccount:edit` receiving the owner's dashboard session.
describe("only the account holder changes the bank", () => {
  it("refuses a co-manager with bank-edit permission before Stripe is touched, and sends the owner the link", async () => {
    state.user = { id: "co-manager-1" };
    state.staffContext = { staff: true, workspaceId: "ws-1", workspaceName: "Ambika", ownerUserId: "owner-1" };
    const res = await call();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      code: "OWNER_ONLY",
      error: "Only the account owner can change the payout bank. We emailed them a link.",
    });
    expect(state.sendOwnerLink).toHaveBeenCalledTimes(1);
    expect(state.sendOwnerLink.mock.calls[0]![1]).toMatchObject({ ownerUserId: "owner-1", staffUserId: "co-manager-1" });
    expect(state.loginLink).not.toHaveBeenCalled();
    expect(state.accountLink).not.toHaveBeenCalled();
  });

  it("claims no email it did not send, and still refuses", async () => {
    state.user = { id: "co-manager-1" };
    const res = await call();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe(
      "Only the account owner can change the payout bank. Send them a link from Owner payouts.",
    );
    expect(state.sendOwnerLink).not.toHaveBeenCalled();
    expect(state.loginLink).not.toHaveBeenCalled();
  });

  it("still serves the owner themselves", async () => {
    const res = await call();
    expect(await res.json()).toMatchObject({ mode: "redirect", via: "login_link" });
    expect(state.sendOwnerLink).not.toHaveBeenCalled();
  });
});
