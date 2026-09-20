/**
 * PLAN-0920-1400's Adjust plan sheet reuses `POST /api/stripe/subscription/update-tier`
 * unchanged (see `docs/agents/plan-entitlements.md` § Settings → Billing & plan
 * page shape) rather than inventing a second scheduling mechanism — this is the
 * route-level guard that the three transitions it promises actually happen:
 * a same-tier Monthly→Annual switch applies NOW with proration, an
 * Annual→Monthly switch or any tier downgrade (Business→Pro) SCHEDULES at the
 * current period's end via subscription metadata, and `cancel_downgrade`
 * clears that schedule (the sheet's Undo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { META_SCHEDULED_BILLING, META_SCHEDULED_TIER } from "@/lib/stripe-subscription-metadata";

const { getUser, subscriptionsRetrieve, subscriptionsUpdate, reconcile, skuRef } = vi.hoisted(() => ({
  getUser: vi.fn(),
  subscriptionsRetrieve: vi.fn(),
  subscriptionsUpdate: vi.fn(async () => ({})),
  reconcile: vi.fn(async () => {}),
  skuRef: { current: { stripeSubscriptionId: "sub_1" as string | null } },
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
  }),
}));
vi.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    subscriptions: { retrieve: subscriptionsRetrieve, update: subscriptionsUpdate },
  }),
}));
vi.mock("@/lib/stripe-subscription-helpers", () => ({
  stripeSubscriptionIsBillable: async () => true,
  stripeSubscriptionPeriodEndSec: () => 1893456000,
}));
vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  reconcileManagerPurchaseWithStripe: reconcile,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/server-env", () => ({
  getPaymentWaiverCode: () => undefined,
  normalizePaymentWaiverCode: (v: string) => v,
  paymentWaiverCodeMatches: () => false,
}));

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: async () => skuRef.current,
  setManagerPurchaseTier: vi.fn(),
}));

import { POST } from "@/app/api/stripe/subscription/update-tier/route";

function req(body: unknown): Request {
  return new Request("http://test/api/stripe/subscription/update-tier", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  subscriptionsUpdate.mockResolvedValue({});
  getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
  skuRef.current = { stripeSubscriptionId: "sub_1" };
  process.env.STRIPE_PRICE_PRO_MONTHLY = "price_pro_monthly";
  process.env.STRIPE_PRICE_PRO_ANNUAL = "price_pro_annual";
  process.env.STRIPE_PRICE_BUSINESS_MONTHLY = "price_business_monthly";
  process.env.STRIPE_PRICE_BUSINESS_ANNUAL = "price_business_annual";
});

function subscription(priceId: string, metadata: Record<string, string> = {}) {
  return {
    id: "sub_1",
    metadata,
    items: { data: [{ id: "si_1", price: priceId }] },
  };
}

describe("same-tier Monthly→Annual applies today, prorated", () => {
  it("upgrades tier immediately with proration (Pro→Business)", async () => {
    subscriptionsRetrieve.mockResolvedValue(subscription("price_pro_monthly"));

    const res = await POST(req({ tier: "business", billing: "monthly" }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, stripeManaged: true, tier: "business", billing: "monthly" });
    expect(subscriptionsUpdate).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({ proration_behavior: "create_prorations", cancel_at_period_end: false }),
    );
  });

  it("switches the same tier to annual immediately with proration", async () => {
    subscriptionsRetrieve.mockResolvedValue(subscription("price_pro_monthly"));

    const res = await POST(req({ tier: "pro", billing: "annual" }));
    const body = await res.json();

    expect(body).toMatchObject({ ok: true, tier: "pro", billing: "annual" });
    expect(subscriptionsUpdate).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({ proration_behavior: "create_prorations" }),
    );
  });
});

describe("Annual→Monthly and any tier downgrade schedule at period end", () => {
  it("schedules a tier downgrade (Business→Pro) without touching billing today", async () => {
    subscriptionsRetrieve.mockResolvedValue(subscription("price_business_monthly"));

    const res = await POST(req({ tier: "pro", billing: "monthly" }));
    const body = await res.json();

    expect(body).toMatchObject({
      ok: true,
      scheduledDowngrade: true,
      scheduledTier: "pro",
      scheduledBilling: "monthly",
      effectiveAt: 1893456000,
    });
    expect(subscriptionsUpdate).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({
        cancel_at_period_end: false,
        metadata: expect.objectContaining({ [META_SCHEDULED_TIER]: "pro", [META_SCHEDULED_BILLING]: "monthly" }),
      }),
    );
  });

  it("schedules an Annual→Monthly switch on the same tier", async () => {
    subscriptionsRetrieve.mockResolvedValue(subscription("price_pro_annual"));

    const res = await POST(req({ tier: "pro", billing: "monthly" }));
    const body = await res.json();

    expect(body).toMatchObject({
      ok: true,
      scheduledDowngrade: true,
      scheduledBillingChange: true,
      scheduledTier: "pro",
      scheduledBilling: "monthly",
    });
    expect(subscriptionsUpdate).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({
        metadata: expect.objectContaining({ [META_SCHEDULED_TIER]: "pro", [META_SCHEDULED_BILLING]: "monthly" }),
      }),
    );
  });

  it("never downgrades immediately — the subscription's own price is untouched", async () => {
    subscriptionsRetrieve.mockResolvedValue(subscription("price_business_monthly"));

    await POST(req({ tier: "pro", billing: "monthly" }));

    const call = subscriptionsUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(call.items).toBeUndefined();
    expect(call.proration_behavior).toBeUndefined();
  });
});

describe("Undo clears a scheduled change", () => {
  it("cancel_downgrade nulls the scheduled-tier metadata", async () => {
    subscriptionsRetrieve.mockResolvedValue(
      subscription("price_business_monthly", { [META_SCHEDULED_TIER]: "pro", [META_SCHEDULED_BILLING]: "monthly" }),
    );

    const res = await POST(req({ action: "cancel_downgrade" }));
    const body = await res.json();

    expect(body).toEqual({ ok: true, canceledDowngrade: true });
    expect(subscriptionsUpdate).toHaveBeenCalledWith(
      "sub_1",
      expect.objectContaining({
        metadata: expect.objectContaining({ [META_SCHEDULED_TIER]: null, [META_SCHEDULED_BILLING]: null }),
      }),
    );
    expect(reconcile).toHaveBeenCalledWith("mgr-1");
  });
});
