import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "manager-1" } } })) },
  })),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn(() => ({})) }));
vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: vi.fn(async () => ({ stripeSubscriptionId: null })),
  setManagerPurchaseTier: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/server-env", () => ({
  BUILTIN_PAYMENT_WAIVER_CODE: "FREE100",
  getPaymentWaiverCode: vi.fn(() => "FREE100"),
  normalizePaymentWaiverCode: (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, ""),
  paymentWaiverCodeMatches: (promo: string) =>
    promo.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") === "FREE100",
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/stripe", () => ({
  getStripe: vi.fn(() => {
    throw new Error("Stripe must not be called");
  }),
}));
vi.mock("@/lib/manager-stripe-subscription-sync", () => ({ reconcileManagerPurchaseWithStripe: vi.fn() }));

import { POST as updateTier } from "@/app/api/stripe/subscription/update-tier/route";
import { getManagerPurchaseSku, setManagerPurchaseTier } from "@/lib/manager-access-server";
import { getStripe } from "@/lib/stripe";

describe("POST /api/stripe/subscription/update-tier payment waiver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getManagerPurchaseSku).mockResolvedValue({ stripeSubscriptionId: null } as Awaited<
      ReturnType<typeof getManagerPurchaseSku>
    >);
    vi.mocked(getStripe).mockImplementation(() => {
      throw new Error("Stripe must not be called");
    });
  });

  it("activates Pro with FREE100 and never initializes Stripe", async () => {
    const response = await updateTier(jsonRequest("http://localhost/api/stripe/subscription/update-tier", {
      method: "POST",
      body: { tier: "pro", billing: "annual", promo: "free100" },
    }));
    const { status, data } = await parseJsonResponse<{
      ok?: boolean;
      waiverApplied?: boolean;
      tier?: string;
      billing?: string;
    }>(response);

    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({
      ok: true,
      waiverApplied: true,
      tier: "pro",
      billing: "annual",
    }));
    expect(setManagerPurchaseTier).toHaveBeenCalledWith("manager-1", "pro", {
      waiver: { promoCode: "FREE100", billing: "annual" },
    });
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("activates Business with FREE100 for lifetime comp access (no Stripe)", async () => {
    const response = await updateTier(jsonRequest("http://localhost/api/stripe/subscription/update-tier", {
      method: "POST",
      body: { tier: "business", billing: "monthly", promo: "FREE100" },
    }));
    const { status, data } = await parseJsonResponse<{
      ok?: boolean;
      waiverApplied?: boolean;
      tier?: string;
      billing?: string;
      message?: string;
    }>(response);

    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({
      ok: true,
      waiverApplied: true,
      tier: "business",
      billing: "monthly",
    }));
    expect(setManagerPurchaseTier).toHaveBeenCalledWith("manager-1", "business", {
      waiver: { promoCode: "FREE100", billing: "monthly" },
    });
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized code without changing the plan", async () => {
    const response = await updateTier(jsonRequest("http://localhost/api/stripe/subscription/update-tier", {
      method: "POST",
      body: { tier: "pro", billing: "monthly", promo: "NOTFREE" },
    }));
    expect(response.status).toBe(400);
    expect(setManagerPurchaseTier).not.toHaveBeenCalled();
    expect(getStripe).not.toHaveBeenCalled();
  });

  it("activates Business with FREE100 when a canceled Stripe subscription id is still on file", async () => {
    vi.mocked(getManagerPurchaseSku).mockResolvedValue({
      stripeSubscriptionId: "sub_canceled_1",
    } as Awaited<ReturnType<typeof getManagerPurchaseSku>>);
    vi.mocked(getStripe).mockReturnValue({
      subscriptions: {
        retrieve: vi.fn(async () => ({ status: "canceled" })),
      },
    } as never);

    const response = await updateTier(jsonRequest("http://localhost/api/stripe/subscription/update-tier", {
      method: "POST",
      body: { tier: "business", billing: "monthly", promo: "FREE100" },
    }));
    const { status, data } = await parseJsonResponse<{
      ok?: boolean;
      waiverApplied?: boolean;
      tier?: string;
    }>(response);

    expect(status).toBe(200);
    expect(data).toEqual(expect.objectContaining({
      ok: true,
      waiverApplied: true,
      tier: "business",
    }));
    expect(setManagerPurchaseTier).toHaveBeenCalledWith("manager-1", "business", {
      waiver: { promoCode: "FREE100", billing: "monthly" },
    });
  });
});
