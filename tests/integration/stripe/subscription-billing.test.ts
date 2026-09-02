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

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn(),
}));

vi.mock("@/lib/manager-purchase-from-session", () => ({
  recordPaidManagerCheckoutSession: vi.fn().mockResolvedValue(undefined),
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

import { getStripe } from "@/lib/stripe";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { reconcileManagerPurchaseByStripeSubscriptionId } from "@/lib/manager-stripe-subscription-sync";
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
    data: opts.user_id === undefined ? null : { user_id: opts.user_id },
    error: null,
  });
  const select = vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) });
  return {
    from: vi.fn().mockReturnValue({ select, update: opts.update ?? vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ error: null }) }) }),
  };
}

describe("Stripe subscription billing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    expect(status).toBe(200);
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
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("payment_method_types");
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

  it("POST /api/stripe/checkout-portal starts hosted checkout for authenticated manager", async () => {
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

    const create = vi.fn().mockResolvedValue({ id: "cs_portal", url: "https://checkout.stripe.test/session" });
    vi.mocked(getStripe).mockReturnValue({
      checkout: { sessions: { create } },
    } as never);

    const req = jsonRequest("http://localhost/api/stripe/checkout-portal", {
      method: "POST",
      body: { tier: "business", billing: "annual", embedded: false },
    });
    const res = await checkoutPortal(req);
    const { status, data } = await parseJsonResponse<{ url?: string }>(res);

    expect(status).toBe(200);
    expect(data.url).toContain("checkout.stripe");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "subscription",
        line_items: [{ price: "price_business_annual_test", quantity: 1 }],
        metadata: expect.objectContaining({ userId: "user_1", tier: "business" }),
      }),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty("payment_method_types");
  });

  it("POST /api/stripe/billing-portal opens portal for Stripe customer", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user_1" } } }) },
    } as never);
    vi.mocked(getManagerPurchaseSku).mockResolvedValue({
      stripeCustomerId: "cus_test_123",
      stripeSubscriptionId: "sub_test_123",
    });

    const create = vi.fn().mockResolvedValue({ url: "https://billing.stripe.test/portal" });
    vi.mocked(getStripe).mockReturnValue({
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
