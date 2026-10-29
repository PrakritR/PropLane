/**
 * Captain, Oct 28: "FREE100 should give full access to just Pro, not Business." Every waiver redeem path
 * writes Pro whatever was picked, an expired code is refused, a policy that cannot be read refuses a NEW
 * redemption (fail closed), and an account whose promo staff ended cannot redeem again on ANY of the
 * three paths: `update-tier`, `signup-intent`, `pricing-oauth-continue`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  setManagerPurchaseTier: vi.fn(),
  getManagerPurchaseSku: vi.fn(),
  check: vi.fn(),
  accountEnded: vi.fn(),
  emailEnded: vi.fn(),
  completeFree: vi.fn(),
  inserted: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: () => ({ eq: async () => ({ data: [], error: null }) }),
      insert: async (row: Record<string, unknown>) => {
        mocks.inserted.push(row);
        return { error: null };
      },
    }),
  }),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: mocks.getManagerPurchaseSku,
  setManagerPurchaseTier: mocks.setManagerPurchaseTier,
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    throw new Error("Stripe must not be called");
  },
}));
vi.mock("@/lib/manager-stripe-subscription-sync", () => ({ reconcileManagerPurchaseWithStripe: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/promo-code-policy.server", async () => {
  const actual = await vi.importActual<typeof import("@/lib/promo-code-expiry")>("@/lib/promo-code-expiry");
  return {
    checkPromoCodeRedeemable: mocks.check,
    accountPromoEnded: mocks.accountEnded,
    accountPromoEndedForEmail: mocks.emailEnded,
    promoRedeemRefusal: (check: { reason: "expired" | "unreadable" }) =>
      check.reason === "expired"
        ? { error: actual.PROMO_CODE_EXPIRED_MESSAGE, code: "PROMO_EXPIRED", status: 400 }
        : { error: actual.PROMO_CODE_UNREADABLE_MESSAGE, code: "PROMO_UNREADABLE", status: 503 },
  };
});
vi.mock("@/lib/auth/manager-pricing-selection", () => ({
  completeFreeManagerTierForUser: mocks.completeFree,
  ensureProvisionedManagerForPricing: vi.fn(async () => ({ kind: "pending", managerId: "MGR-1" })),
}));
vi.mock("@/lib/auth/manager-onboarding", () => ({ findManagerPurchaseForAccount: vi.fn() }));
vi.mock("@/lib/auth/manager-signup-trial", () => ({
  completeManagerSignupTrial: vi.fn(),
  isManagerSignupTrialTier: () => false,
}));
vi.mock("@/lib/stripe/manager-checkout", () => ({
  createManagerCheckoutSession: vi.fn(async () => {
    throw new Error("checkout must not start for a waiver");
  }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: async () => ({ kind: "normal" }),
}));

import { POST as updateTier } from "@/app/api/stripe/subscription/update-tier/route";
import { POST as signupIntent } from "@/app/api/manager/signup-intent/route";
import { POST as oauthContinue } from "@/app/api/manager/pricing-oauth-continue/route";
import {
  waiverGrantTier,
  waiverRedeemedMessage,
  waiverTierForRequest,
} from "@/lib/payment-waiver-grant";

const post = (url: string, body: unknown) =>
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inserted.length = 0;
  mocks.getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "m@example.com", user_metadata: {} } } });
  mocks.getManagerPurchaseSku.mockResolvedValue({ stripeSubscriptionId: null });
  mocks.setManagerPurchaseTier.mockResolvedValue({ ok: true });
  mocks.check.mockResolvedValue({ ok: true });
  mocks.accountEnded.mockResolvedValue(false);
  mocks.emailEnded.mockResolvedValue(false);
  mocks.completeFree.mockResolvedValue({ managerId: "MGR-1", alreadyLinked: true });
});

describe("the waiver rule", () => {
  it("a waiver grants Pro, never Business, and never upgrades a Free pick", () => {
    expect(waiverGrantTier()).toBe("pro");
    expect(waiverTierForRequest("business")).toBe("pro");
    expect(waiverTierForRequest("pro")).toBe("pro");
    expect(waiverTierForRequest("free")).toBe("free");
  });

  it("says FREE100 covers Pro when Business was picked", () => {
    expect(waiverRedeemedMessage("business", "FREE100")).toContain("FREE100 covers Pro.");
    expect(waiverRedeemedMessage("business", "FREE100")).toContain("Your plan is Pro.");
  });
});

describe("update-tier (an existing account)", () => {
  const url = "http://test/api/stripe/subscription/update-tier";

  it("writes Pro when Business is picked with FREE100", async () => {
    const res = await updateTier(post(url, { tier: "business", billing: "monthly", promo: "free100" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, waiverApplied: true, tier: "pro" });
    expect(body.message).toContain("FREE100 covers Pro.");
    expect(mocks.setManagerPurchaseTier).toHaveBeenCalledWith("mgr-1", "pro", {
      waiver: { promoCode: "FREE100", billing: "monthly" },
    });
  });

  it("refuses an expired code and writes nothing", async () => {
    mocks.check.mockResolvedValue({ ok: false, reason: "expired" });
    const res = await updateTier(post(url, { tier: "pro", billing: "monthly", promo: "FREE100" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This code has expired.");
    expect(mocks.setManagerPurchaseTier).not.toHaveBeenCalled();
  });

  it("refuses a new redemption when the policy cannot be read", async () => {
    mocks.check.mockResolvedValue({ ok: false, reason: "unreadable" });
    const res = await updateTier(post(url, { tier: "pro", billing: "monthly", promo: "FREE100" }));
    expect(res.status).toBe(503);
    expect(mocks.setManagerPurchaseTier).not.toHaveBeenCalled();
  });

  it("refuses an account whose promo staff already ended", async () => {
    mocks.accountEnded.mockResolvedValue(true);
    const res = await updateTier(post(url, { tier: "pro", billing: "monthly", promo: "FREE100" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This code has expired.");
    expect(mocks.setManagerPurchaseTier).not.toHaveBeenCalled();
    // A new redemption asks the ended-promo question fail-closed (an unreadable read refuses).
    expect(mocks.accountEnded).toHaveBeenCalledWith(expect.anything(), "mgr-1", expect.any(Number), { failClosed: true });
  });
});

describe("signup-intent (a new account)", () => {
  const url = "http://test/api/manager/signup-intent";
  const body = (tier: string, promo = "FREE100") => ({
    tier,
    billing: "monthly",
    email: "new@example.com",
    fullName: "New Manager",
    promo,
  });

  it("stores Pro when Business is picked with FREE100", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await signupIntent(post(url, body("business")));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.tier).toBe("pro");
    expect(json.message).toContain("FREE100 covers Pro.");
    expect(mocks.inserted).toHaveLength(1);
    expect(mocks.inserted[0]).toMatchObject({ tier: "pro", promo_code: "FREE100" });
  });

  it("completes a signed-in account as Pro too", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: { id: "mgr-1", email: "new@example.com" } } });
    const res = await signupIntent(post(url, body("business")));
    expect(res.status).toBe(200);
    expect(mocks.completeFree).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tier: "pro", promo: "FREE100" }));
  });

  it("refuses an expired code", async () => {
    mocks.check.mockResolvedValue({ ok: false, reason: "expired" });
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await signupIntent(post(url, body("pro")));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This code has expired.");
    expect(mocks.inserted).toHaveLength(0);
  });

  it("refuses when the policy is unreadable", async () => {
    mocks.check.mockResolvedValue({ ok: false, reason: "unreadable" });
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await signupIntent(post(url, body("pro")));
    expect(res.status).toBe(503);
    expect(mocks.inserted).toHaveLength(0);
  });

  it("refuses a signup whose promo staff already ended, asked by email and fail-closed", async () => {
    mocks.emailEnded.mockResolvedValue(true);
    mocks.getUser.mockResolvedValue({ data: { user: null } });
    const res = await signupIntent(post(url, body("pro")));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This code has expired.");
    expect(mocks.inserted).toHaveLength(0);
    expect(mocks.emailEnded).toHaveBeenCalledWith(expect.anything(), "new@example.com", expect.any(Number), {
      failClosed: true,
    });
  });
});

describe("pricing-oauth-continue (Google sign-in on pricing)", () => {
  const url = "http://test/api/manager/pricing-oauth-continue";

  it("completes Pro when Business is picked with FREE100", async () => {
    const res = await oauthContinue(post(url, { tier: "business", billing: "annual", promo: "free100" }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.tier).toBe("pro");
    expect(json.message).toContain("FREE100 covers Pro.");
    expect(mocks.completeFree).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tier: "pro", promo: "FREE100", billing: "annual" }),
    );
  });

  it("refuses an expired code without completing the account", async () => {
    mocks.check.mockResolvedValue({ ok: false, reason: "expired" });
    const res = await oauthContinue(post(url, { tier: "pro", billing: "monthly", promo: "FREE100" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This code has expired.");
    expect(mocks.completeFree).not.toHaveBeenCalled();
  });

  it("refuses an account whose promo staff already ended, fail-closed", async () => {
    mocks.accountEnded.mockResolvedValue(true);
    const res = await oauthContinue(post(url, { tier: "pro", billing: "monthly", promo: "FREE100" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This code has expired.");
    expect(mocks.completeFree).not.toHaveBeenCalled();
    expect(mocks.accountEnded).toHaveBeenCalledWith(expect.anything(), "mgr-1", expect.any(Number), { failClosed: true });
  });
});
