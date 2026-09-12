import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEffectiveManagerSkuTier: vi.fn(),
  getManagerPurchaseSku: vi.fn(),
  createSupabaseServiceRoleClient: vi.fn(),
  getStripe: vi.fn(),
  requireManagerRouteUser: vi.fn(),
}));

vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: mocks.getEffectiveManagerSkuTier,
  getManagerPurchaseSku: mocks.getManagerPurchaseSku,
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.createSupabaseServiceRoleClient,
}));
vi.mock("@/lib/stripe", () => ({ getStripe: mocks.getStripe }));
vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: mocks.requireManagerRouteUser,
}));

import { POST } from "@/app/api/manager/plan-addons/route";
import { setManagerPlanAddonQuantity } from "@/lib/plan-addons.server";

const OWNER = "owner-123";

function request(body: unknown): Request {
  return new Request("http://localhost/api/manager/plan-addons", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function serviceDb() {
  const db = {
    from: vi.fn((table: string) => {
      if (table === "manager_purchases") {
        throw new Error("the closed add-on boundary must not read entitlements");
      }
      throw new Error(`unexpected service read: ${table}`);
    }),
  };
  return db;
}

function expectClosed(result: Awaited<ReturnType<typeof setManagerPlanAddonQuantity>>) {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.status).toBe(503);
  expect(result.code).toBe("add_on_purchases_unavailable");
  expect(result.error).toMatch(/add.?ons?.*(not available|unavailable)|not available.*purchase/i);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.getStripe.mockReturnValue({
    subscriptionItems: {
      create: vi.fn(),
      update: vi.fn(),
      del: vi.fn(),
    },
  });
  mocks.createSupabaseServiceRoleClient.mockReturnValue(serviceDb());
});

describe("plan add-on purchase closure", () => {
  it.each([
    {
      label: "an unexpired signup trial",
      tier: { ok: true, tier: "free" },
      sku: { tier: "pro", billing: "trial", stripeSubscriptionId: null },
    },
    {
      label: "an Apple paid account without Stripe",
      tier: { ok: true, tier: "pro" },
      sku: { tier: "pro", billing: "apple", appleOriginalTransactionId: "1000000123456789", stripeSubscriptionId: null },
    },
    {
      label: "a Stripe-backed account",
      tier: { ok: true, tier: "business" },
      sku: { tier: "business", billing: "monthly", stripeSubscriptionId: "sub_test" },
    },
  ])("refuses $label before any Stripe or entitlement mutation", async ({ tier, sku }) => {
    mocks.getEffectiveManagerSkuTier.mockResolvedValue(tier);
    mocks.getManagerPurchaseSku.mockResolvedValue(sku);

    const result = await setManagerPlanAddonQuantity({
      managerUserId: OWNER,
      addonId: "extra_listing",
      quantity: 1,
    });

    expectClosed(result);
    expect(mocks.getManagerPurchaseSku).not.toHaveBeenCalled();
    expect(mocks.getStripe).not.toHaveBeenCalled();
    expect(mocks.createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it.each([
    { managerUserId: "", quantity: 1, status: 403 },
    { managerUserId: OWNER, quantity: 101, status: 400 },
    { managerUserId: OWNER, quantity: Number.NaN, status: 400 },
  ])("keeps $status input validation ahead of the closed purchase path", async ({ managerUserId, quantity, status }) => {
    const result = await setManagerPlanAddonQuantity({
      managerUserId,
      addonId: "extra_listing",
      quantity,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(status);
    expect(mocks.getEffectiveManagerSkuTier).not.toHaveBeenCalled();
    expect(mocks.getManagerPurchaseSku).not.toHaveBeenCalled();
    expect(mocks.getStripe).not.toHaveBeenCalled();
    expect(mocks.createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated route request before the helper, Stripe, or service role", async () => {
    mocks.requireManagerRouteUser.mockResolvedValue(null);

    const response = await POST(request({ addonId: "extra_listing", quantity: 1 }));

    expect(response.status).toBe(401);
    expect(mocks.getEffectiveManagerSkuTier).not.toHaveBeenCalled();
    expect(mocks.getManagerPurchaseSku).not.toHaveBeenCalled();
    expect(mocks.getStripe).not.toHaveBeenCalled();
    expect(mocks.createSupabaseServiceRoleClient).not.toHaveBeenCalled();
  });

  it("keeps the catalogue visibly unavailable even when Stripe prices are configured", async () => {
    const db = {
      from: vi.fn(() => {
        const q: Record<string, unknown> = {};
        q.select = vi.fn(() => q);
        q.eq = vi.fn(() => q);
        q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve);
        return q;
      }),
    };
    mocks.requireManagerRouteUser.mockResolvedValue({ userId: OWNER, db });
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "pro" });
    mocks.createSupabaseServiceRoleClient.mockReturnValue(db);
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_LISTING_PRO", "price_configured");
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_WORK_NUMBER_PRO", "price_configured");
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_WORKSPACE_PRO", "price_configured");
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_SEAT_PRO", "price_configured");

    const response = await (await import("@/app/api/manager/plan-addons/route")).GET();
    const body = (await response.json()) as { addons: { purchasable: boolean }[] };

    expect(response.status).toBe(200);
    expect(body.addons).toHaveLength(4);
    expect(body.addons.every((addon) => addon.purchasable === false)).toBe(true);
  });
});
