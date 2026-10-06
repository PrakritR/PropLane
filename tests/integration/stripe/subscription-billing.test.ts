import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";
import { mockCheckoutSession, mockCheckoutSessionCompletedEvent } from "../../mocks/stripe/events";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers({ "stripe-signature": "sig_test" })),
}));

vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: vi.fn(),
}));

vi.mock("@/lib/manager-stripe-customer.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-stripe-customer.server")>()),
  ensureManagerBillingCustomer: vi.fn(),
}));

vi.mock("@/lib/manager-purchase-from-session", () => ({
  recordPaidManagerCheckoutSession: vi.fn().mockResolvedValue(undefined),
  resolveManagerCheckoutPurchase: vi.fn().mockResolvedValue({
    row: { id: "purchase_1", user_id: "user_1", manager_id: "MGR-123", email: "mgr@example.com" },
    userId: "user_1",
    expectedManagerId: "MGR-123",
    expectedEmail: "mgr@example.com",
  }),
}));

vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  applyScheduledDowngradeAfterInvoicePaid: vi.fn(),
  reconcileManagerPurchaseByStripeSubscriptionId: vi.fn(),
  reconcileManagerPurchaseWithStripe: vi.fn(),
}));

vi.mock("@/lib/stripe-application-fee", () => ({
  markApplicationFeePaidFromStripeSession: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/stripe-household-charge", () => ({
  markHouseholdChargePaidFromStripeSession: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn().mockResolvedValue({ kind: "normal" }),
}));

vi.mock("@/lib/test-workspaces/effects.server", () => ({
  assertTestWorkspaceProviderEffectAllowed: vi.fn().mockResolvedValue(undefined),
  captureTestWorkspaceEffectForUser: vi.fn().mockResolvedValue({ captured: false }),
}));

vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  reconcileManagerSmsEntitlement: vi.fn().mockResolvedValue({ eligible: true }),
}));

import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { ensureManagerBillingCustomer } from "@/lib/manager-stripe-customer.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { reconcileManagerPurchaseByStripeSubscriptionId } from "@/lib/manager-stripe-subscription-sync";
import {
  assertTestWorkspaceProviderEffectAllowed,
  captureTestWorkspaceEffectForUser,
} from "@/lib/test-workspaces/effects.server";
import { POST as checkout } from "@/app/api/stripe/checkout/route";
import { POST as checkoutPortal } from "@/app/api/stripe/checkout-portal/route";
import { POST as billingPortal } from "@/app/api/stripe/billing-portal/route";
import { POST as webhook } from "@/app/api/stripe/webhook/route";

/**
 * The subscription webhook reads `manager_purchases` to find the manager behind
 * the subscription before doing anything else, so a mock that only models
 * `update` makes the handler throw and answer 500. `rows` is what that lookup
 * returns; `update` is captured so the deleted-event test can assert on it.
 */
function serviceRoleDbMock(opts: { user_id?: string | null; update?: ReturnType<typeof vi.fn> } = {}) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: {
      id: "purchase_1",
      user_id: opts.user_id === undefined ? "user_1" : opts.user_id,
      manager_id: "MGR-123",
      email: "mgr@example.com",
    },
    error: null,
  });
  const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) });
  return {
    from: vi.fn().mockReturnValue({ select, update: opts.update ?? vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }),
  };
}

function billingIdentityDbMock(opts: { reserveFails?: boolean; tier?: string; sessionId?: string } = {}) {
  const purchase = {
    id: "purchase_1", user_id: "user_1", email: "mgr@example.com", manager_id: "MGR-123",
    tier: opts.tier ?? "free", stripe_subscription_id: null, stripe_checkout_session_id: opts.sessionId ?? "axis_intent_initial",
  };
  return {
    purchase,
    from: vi.fn((table: string) => {
      const rows = [{ user_id: "user_1", stripe_customer_id: "cus_test_123", stripe_subscription_id: "sub_test_123" }];
      let isUpdate = false;
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query),
        not: vi.fn(() => query), or: vi.fn(() => query), is: vi.fn(() => query), in: vi.fn(() => query), order: vi.fn(() => query),
        limit: vi.fn(() => query),
        update: vi.fn((patch: Record<string, unknown>) => {
          isUpdate = true;
          if (table === "manager_purchases" && !opts.reserveFails) Object.assign(purchase, patch);
          return query;
        }),
        maybeSingle: vi.fn(async () => ({ data: table === "manager_comms_billing_accounts" ? null :
          table === "manager_purchases" ? (opts.reserveFails && isUpdate ? null : purchase) : {}, error: null })),
        upsert: vi.fn().mockResolvedValue({ error: null }),
        then: (onfulfilled: (value: { data: typeof rows; error: null }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(onfulfilled),
      };
      return query;
    }),
  };
}
const stripeIdentityMock = () => ({
  customers: { retrieve: vi.fn().mockResolvedValue({ id: "cus_test_123", metadata: { manager_user_id: "user_1" } }) },
  subscriptions: {
    retrieve: vi.fn().mockResolvedValue({ id: "sub_test_123", customer: "cus_test_123" }),
    list: vi.fn().mockResolvedValue({ data: [], has_more: false }),
  },
  prices: { retrieve: vi.fn(async (id: string) => {
    const tier = id.includes("business") ? "business" : "pro";
    const annual = id.includes("annual");
    return { id, active: true, currency: "usd", type: "recurring",
      unit_amount: tier === "business" ? (annual ? 249_000 : 24_900) : (annual ? 49_000 : 4_900),
      recurring: { interval: annual ? "year" : "month", interval_count: 1 },
      product: { id: `prod_${tier}`, metadata: { axis_plan: `axis_${tier}` } } };
  }) },
});

describe("Stripe subscription billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireManagerRouteUser).mockResolvedValue(null);
    vi.mocked(ensureManagerBillingCustomer).mockResolvedValue("cus_test_123");
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(billingIdentityDbMock() as never);
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);
    process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
    process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_monthly_test";
    process.env.STRIPE_PRICE_PRO_ANNUAL = "price_pro_annual_test";
    process.env.STRIPE_PRICE_BUSINESS_MONTHLY = "price_business_monthly_test";
    process.env.STRIPE_PRICE_BUSINESS_ANNUAL = "price_business_annual_test";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
  });

  it("POST /api/stripe/checkout creates embedded subscription session for Pro monthly", async () => {
    const create = vi.fn().mockResolvedValue({
      id: "cs_test_embedded",
      client_secret: "cs_test_secret",
    });
    vi.mocked(getStripe).mockReturnValue({
      ...stripeIdentityMock(),
      checkout: { sessions: { create } },
    } as never);

    const req = jsonRequest("http://localhost/api/stripe/checkout", {
      method: "POST",
      body: {
        tier: "pro",
        billing: "monthly",
        email: "mgr@example.com",
        fullName: "Test Manager",
        embedded: true,
      },
    });
    const res = await checkout(req);
    const { status, data } = await parseJsonResponse<{ clientSecret?: string; sessionId?: string }>(res);

    expect(status, JSON.stringify(data)).toBe(200);
    expect(data.clientSecret).toBe("cs_test_secret");
    expect(data.sessionId).toBe("cs_test_embedded");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        ui_mode: "embedded_page",
        line_items: [{ price: "price_pro_monthly_test", quantity: 1 }],
        metadata: expect.objectContaining({ tier: "pro", billing: "monthly" }),
      }),
    );
    expect(create.mock.calls[0]?.[0]).toHaveProperty("payment_method_types", ["card"]);
  });

  it("POST /api/stripe/checkout rejects missing price env", async () => {
    delete process.env.STRIPE_PRICE_BUSINESS_ANNUAL;
    const req = jsonRequest("http://localhost/api/stripe/checkout", {
      method: "POST",
      body: { tier: "business", billing: "annual", email: "x@y.com" },
    });
    const res = await checkout(req);
    expect(res.status).toBe(500);
  });

  it("POST /api/stripe/checkout-portal requires auth", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);

    const req = jsonRequest("http://localhost/api/stripe/checkout-portal", {
      method: "POST",
      body: { tier: "pro", billing: "monthly" },
    });
    const res = await checkoutPortal(req);
    expect(res.status).toBe(401);
  });

  it.each(["resident", "vendor"])(
    "POST /api/stripe/checkout-portal rejects a %s-only user before billing or Stripe side effects",
    async () => {
      vi.mocked(createSupabaseServerClient).mockResolvedValue({
        auth: {
          getUser: vi.fn().mockResolvedValue({
            data: { user: { id: "user_1", email: "non-manager@example.com" } },
          }),
        },
      } as never);
      vi.mocked(requireManagerRouteUser).mockResolvedValue(null);

      const req = jsonRequest("http://localhost/api/stripe/checkout-portal", {
        method: "POST",
        body: { tier: "pro", billing: "monthly" },
      });
      const res = await checkoutPortal(req);

      expect(res.status).toBe(403);
      expect(ensureManagerBillingCustomer).not.toHaveBeenCalled();
      expect(getStripe).not.toHaveBeenCalled();
      expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
    },
  );

  it("POST /api/stripe/checkout-portal starts hosted checkout for authenticated manager", async () => {
    const managerDb = billingIdentityDbMock();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }),
      },
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: { email: "mgr@example.com", manager_id: "MGR-123", full_name: "Mgr" },
              error: null,
            }),
          }),
        }),
      }),
    } as never);
    vi.mocked(requireManagerRouteUser).mockResolvedValue({
      userId: "user_1",
      // The canonical guard admits additive multi-role accounts whenever one
      // of their profile_roles rows is manager.
      db: managerDb,
    } as never);

    const create = vi.fn().mockResolvedValue({ id: "cs_portal", url: "https://checkout.stripe.test/session" });
    vi.mocked(getStripe).mockReturnValue({
      ...stripeIdentityMock(),
      checkout: { sessions: { create } },
    } as never);

    const req = jsonRequest("http://localhost/api/stripe/checkout-portal", {
      method: "POST",
      body: { tier: "business", billing: "annual", embedded: false },
    });
    const res = await checkoutPortal(req);
    const { status, data } = await parseJsonResponse<{ url?: string }>(res);

    expect(status, JSON.stringify(data)).toBe(200);
    expect(data.url).toContain("checkout.stripe");
    expect(requireManagerRouteUser).toHaveBeenCalledOnce();
    expect(assertTestWorkspaceProviderEffectAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", kind: "payment" }),
    );
    expect(ensureManagerBillingCustomer).toHaveBeenCalledWith(managerDb, "user_1");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_business_annual_test", quantity: 1 }],
        metadata: expect.objectContaining({ userId: "user_1", tier: "business" }),
      }),
    );
    expect(create.mock.calls[0]?.[0]).toHaveProperty("payment_method_types", ["card"]);
    expect(managerDb.purchase.stripe_checkout_session_id).toBe("cs_portal");
  });

  it("never exposes a Checkout URL when the durable owner reservation loses its compare-and-swap", async () => {
    const managerDb = billingIdentityDbMock({ reserveFails: true });
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }) },
      from: vi.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: { email: "mgr@example.com", manager_id: "MGR-123" }, error: null,
      }) }) }) }),
    } as never);
    vi.mocked(requireManagerRouteUser).mockResolvedValue({ userId: "user_1", db: managerDb } as never);
    const expire = vi.fn().mockResolvedValue({ id: "cs_lost", status: "expired" });
    vi.mocked(getStripe).mockReturnValue({ ...stripeIdentityMock(), checkout: { sessions: {
      create: vi.fn().mockResolvedValue({ id: "cs_lost", url: "https://checkout.stripe.test/lost" }), expire,
    } } } as never);
    const response = await checkoutPortal(jsonRequest("http://localhost/api/stripe/checkout-portal", {
      method: "POST", body: { tier: "pro", billing: "monthly", embedded: false },
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("url");
    expect(expire).toHaveBeenCalledWith("cs_lost");
  });

  it("resumes the same owned open Checkout instead of creating another subscription", async () => {
    const managerDb = billingIdentityDbMock({ sessionId: "cs_prior" });
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }) },
      from: vi.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: { email: "mgr@example.com", manager_id: "MGR-123" }, error: null,
      }) }) }) }),
    } as never);
    vi.mocked(requireManagerRouteUser).mockResolvedValue({ userId: "user_1", db: managerDb } as never);
    const create = vi.fn();
    vi.mocked(getStripe).mockReturnValue({ ...stripeIdentityMock(), checkout: { sessions: {
      create, retrieve: vi.fn().mockResolvedValue({ id: "cs_prior", status: "open", mode: "subscription",
        customer: "cus_test_123", client_secret: "cs_prior_secret",
        metadata: { userId: "user_1", manager_id: "MGR-123", tier: "pro", billing: "monthly", floor_price_id: "price_pro_monthly_test" } }),
    } } } as never);
    const response = await checkoutPortal(jsonRequest("http://localhost/api/stripe/checkout-portal", {
      method: "POST", body: { tier: "pro", billing: "monthly", embedded: true },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ clientSecret: "cs_prior_secret", sessionId: "cs_prior" });
    expect(create).not.toHaveBeenCalled();
  });

  it("reserves Checkout for an authenticated legacy Free manager with no purchase row", async () => {
    const insert = vi.fn();
    const managerDb = { from: vi.fn(() => {
      let inserting = false;
      const query = {
        select: vi.fn(() => query), eq: vi.fn(() => query), limit: vi.fn(() => query),
        insert: vi.fn((row: Record<string, unknown>) => { inserting = true; insert(row); return query; }),
        maybeSingle: vi.fn(async () => ({ data: inserting ? { id: "new-purchase" } : null, error: null })),
        then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return query;
    }) };
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }) },
      from: vi.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: { email: "mgr@example.com", manager_id: "MGR-123" }, error: null,
      }) }) }) }),
    } as never);
    vi.mocked(requireManagerRouteUser).mockResolvedValue({ userId: "user_1", db: managerDb } as never);
    vi.mocked(getStripe).mockReturnValue({ ...stripeIdentityMock(), checkout: { sessions: {
      create: vi.fn().mockResolvedValue({ id: "cs_new_free", client_secret: "secret_new" }),
    } } } as never);
    const response = await checkoutPortal(jsonRequest("http://localhost/api/stripe/checkout-portal", {
      method: "POST", body: { tier: "pro", billing: "monthly", embedded: true },
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ clientSecret: "secret_new", sessionId: "cs_new_free" });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: "user_1", manager_id: "MGR-123", stripe_checkout_session_id: "cs_new_free", tier: "free",
    }));
  });

  it("blocks an unrecorded active subscription on the authenticated customer", async () => {
    const managerDb = billingIdentityDbMock();
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }) },
      from: vi.fn().mockReturnValue({ select: () => ({ eq: () => ({ maybeSingle: async () => ({
        data: { email: "mgr@example.com", manager_id: "MGR-123" }, error: null,
      }) }) }) }),
    } as never);
    vi.mocked(requireManagerRouteUser).mockResolvedValue({ userId: "user_1", db: managerDb } as never);
    const stripeMock = stripeIdentityMock();
    stripeMock.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_orphan", status: "active" }], has_more: false } as never);
    const create = vi.fn();
    vi.mocked(getStripe).mockReturnValue({ ...stripeMock, checkout: { sessions: { create } } } as never);
    const response = await checkoutPortal(jsonRequest("http://localhost/api/stripe/checkout-portal", {
      method: "POST", body: { tier: "pro", billing: "monthly", embedded: true },
    }));
    expect(response.status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });

  it("POST /api/stripe/checkout-portal refuses a mismatched canonical manager identity", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: {
        getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1", email: "mgr@example.com" } } }),
      },
    } as never);
    vi.mocked(requireManagerRouteUser).mockResolvedValue({
      userId: "different-user",
      db: billingIdentityDbMock(),
    } as never);

    const req = jsonRequest("http://localhost/api/stripe/checkout-portal", {
      method: "POST",
      body: { tier: "pro", billing: "monthly" },
    });
    const res = await checkoutPortal(req);

    expect(res.status).toBe(403);
    expect(ensureManagerBillingCustomer).not.toHaveBeenCalled();
    expect(getStripe).not.toHaveBeenCalled();
    expect(createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("POST /api/stripe/billing-portal opens portal for Stripe customer", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1" } } }) },
    } as never);
    vi.mocked(requireManagerRouteUser).mockResolvedValue({ userId: "user_1", db: billingIdentityDbMock() } as never);

    const create = vi.fn().mockResolvedValue({ url: "https://billing.stripe.test/portal" });
    vi.mocked(getStripe).mockReturnValue({
      ...stripeIdentityMock(),
      billingPortal: { sessions: { create } },
    } as never);

    const req = jsonRequest("http://localhost/api/stripe/billing-portal", {
      method: "POST",
      body: { returnPath: "/portal/profile" },
    });
    const res = await billingPortal(req);
    const { status, data } = await parseJsonResponse<{ url?: string }>(res);

    expect(status).toBe(200);
    expect(data.url).toContain("billing.stripe");
    expect(assertTestWorkspaceProviderEffectAllowed).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", kind: "payment" }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_test_123",
        // Returns to the Settings billing tab, never a caller-supplied path.
        return_url: expect.stringContaining("/portal/profile?tab=billing"),
      }),
    );
  });

  it("webhook processes customer.subscription.updated", async () => {
    vi.mocked(getStripe).mockReturnValue({
      webhooks: {
        constructEvent: vi.fn().mockReturnValue({
          type: "customer.subscription.updated",
          data: { object: { id: "sub_test_123" } },
        }),
      },
    } as never);

    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceRoleDbMock() as never);

    const req = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "sig_test" },
    });
    const res = await webhook(req);
    expect(res.status).toBe(200);
    expect(captureTestWorkspaceEffectForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user_1", kind: "payment" }),
    );
    expect(reconcileManagerPurchaseByStripeSubscriptionId).toHaveBeenCalledWith("sub_test_123");
  });

  it("webhook downgrades manager_purchases on customer.subscription.deleted", async () => {
    const eq = vi.fn().mockResolvedValue({ error: null });
    const update = vi.fn().mockReturnValue({ eq });
    vi.mocked(createSupabaseServiceRoleClient).mockReturnValue(serviceRoleDbMock({ update }) as never);

    vi.mocked(getStripe).mockReturnValue({
      webhooks: {
        constructEvent: vi.fn().mockReturnValue({
          type: "customer.subscription.deleted",
          data: { object: { id: "sub_deleted_1" } },
        }),
      },
    } as never);

    const req = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "sig_test" },
    });
    const res = await webhook(req);
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      tier: "free",
      billing: "free",
      stripe_subscription_id: null,
    });
    expect(eq).toHaveBeenCalledWith("stripe_subscription_id", "sub_deleted_1");
  });

  it("webhook processes checkout.session.completed for subscription signup", async () => {
    const session = mockCheckoutSessionCompletedEvent(
      mockCheckoutSession({ metadata: { tier: "pro", billing: "monthly", userId: "user_1" } }),
    ).data.object;

    vi.mocked(getStripe).mockReturnValue({
      webhooks: {
        constructEvent: vi.fn().mockReturnValue({
          type: "checkout.session.completed",
          data: { object: session },
        }),
      },
    } as never);

    const req = new Request("http://localhost/api/stripe/webhook", {
      method: "POST",
      body: "{}",
      headers: { "stripe-signature": "sig_test" },
    });
    const res = await webhook(req);
    expect(res.status).toBe(200);
  });
});
