import { beforeEach, describe, expect, it, vi } from "vitest";

// Add-ons are always purchasable (PLAN-0920): a batch of quantity changes is
// applied as ONE prorated Stripe subscription update, all-or-nothing. These
// tests replace the retired `manager-plan-addons-closure` suite, which
// asserted the earlier "purchases unavailable" behavior these routes no
// longer have.

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

import { PATCH, POST } from "@/app/api/manager/plan-addons/route";

const OWNER = "owner-123";

function request(body: unknown): Request {
  return new Request("http://localhost/api/manager/plan-addons", {
    method: "PATCH",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

type AddonDbRow = { addon_id: string; quantity: number; stripe_subscription_item_id?: string | null };

function makeDb(existingRows: AddonDbRow[] = []) {
  const upsertCalls: unknown[] = [];
  const upsert = vi.fn((rows: unknown) => {
    upsertCalls.push(rows);
    return Promise.resolve({ error: null });
  });
  const from = vi.fn((table: string) => {
    if (table !== "manager_plan_addons") throw new Error(`unexpected table: ${table}`);
    const q: Record<string, unknown> = {};
    q.select = vi.fn(() => q);
    q.eq = vi.fn(() => q);
    q.upsert = upsert;
    q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: existingRows, error: null }).then(resolve);
    return q;
  });
  return { from, upsertCalls, upsert };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  mocks.requireManagerRouteUser.mockResolvedValue({ userId: OWNER, db: {} });
});

describe("PATCH /api/manager/plan-addons", () => {
  it("rejects an unauthenticated request before any plan or Stripe read", async () => {
    mocks.requireManagerRouteUser.mockResolvedValue(null);

    const response = await PATCH(request({ changes: [{ addonId: "extra_seat", quantity: 1 }] }));

    expect(response.status).toBe(401);
    expect(mocks.getEffectiveManagerSkuTier).not.toHaveBeenCalled();
    expect(mocks.getStripe).not.toHaveBeenCalled();
  });

  it("applies a multi-row batch as ONE Stripe subscription update and one database write", async () => {
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_WORKSPACE_BUSINESS", "price_workspace_biz");
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_SEAT_BUSINESS", "price_seat_biz");
    const db = makeDb();
    mocks.createSupabaseServiceRoleClient.mockReturnValue(db);
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "business" });
    mocks.getManagerPurchaseSku.mockResolvedValue({ tier: "business", billing: "monthly", stripeSubscriptionId: "sub_test" });
    const update = vi.fn().mockResolvedValue({
      items: {
        data: [
          { id: "si_workspace", price: "price_workspace_biz" },
          { id: "si_seat", price: "price_seat_biz" },
        ],
      },
    });
    mocks.getStripe.mockReturnValue({
      subscriptions: { update, retrieve: vi.fn().mockResolvedValue({ status: "active" }) },
    });

    const response = await PATCH(
      request({
        changes: [
          { addonId: "extra_workspace", quantity: 2 },
          { addonId: "extra_seat", quantity: 1 },
        ],
      }),
    );
    const body = (await response.json()) as { addons: { id: string; quantity: number }[]; stripeSynced: boolean };

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      "sub_test",
      expect.objectContaining({
        items: [
          { price: "price_workspace_biz", quantity: 2 },
          { price: "price_seat_biz", quantity: 1 },
        ],
        proration_behavior: "create_prorations",
      }),
    );
    expect(db.upsert).toHaveBeenCalledTimes(1);
    expect((db.upsertCalls[0] as unknown[]).length).toBe(2);
    expect(body.stripeSynced).toBe(true);
    expect(body.addons.find((a) => a.id === "extra_workspace")?.quantity).toBe(2);
    expect(body.addons.find((a) => a.id === "extra_seat")?.quantity).toBe(1);
  });

  it("refuses an extra_work_number quantity past 2-per-workspace before touching Stripe or the database", async () => {
    const db = makeDb();
    mocks.createSupabaseServiceRoleClient.mockReturnValue(db);
    // Business default: 2 included workspaces, no extra_workspace held → cap is
    // maxWorkNumbersForWorkspaces(2) - includedWorkNumbers("business", 2) = 4 - 2 = 2.
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "business" });
    mocks.getManagerPurchaseSku.mockResolvedValue({ tier: "business", billing: "monthly", stripeSubscriptionId: "sub_test" });
    const update = vi.fn();
    mocks.getStripe.mockReturnValue({ subscriptions: { update, retrieve: vi.fn() } });

    const response = await PATCH(request({ changes: [{ addonId: "extra_work_number", quantity: 3 }] }));
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/2 work numbers/i);
    expect(update).not.toHaveBeenCalled();
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("writes nothing when the Stripe subscription update fails", async () => {
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_SEAT_BUSINESS", "price_seat_biz");
    const db = makeDb();
    mocks.createSupabaseServiceRoleClient.mockReturnValue(db);
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "business" });
    mocks.getManagerPurchaseSku.mockResolvedValue({ tier: "business", billing: "monthly", stripeSubscriptionId: "sub_test" });
    const update = vi.fn().mockRejectedValue(new Error("card_declined"));
    mocks.getStripe.mockReturnValue({
      subscriptions: { update, retrieve: vi.fn().mockResolvedValue({ status: "active" }) },
    });

    const response = await PATCH(request({ changes: [{ addonId: "extra_seat", quantity: 3 }] }));
    const body = (await response.json()) as { error: string; code: string };

    expect(response.status).toBe(402);
    expect(body.code).toBe("addon_purchase_failed");
    expect(update).toHaveBeenCalledTimes(1);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("still accepts the older single-item body over POST", async () => {
    vi.stubEnv("STRIPE_PRICE_ADDON_EXTRA_SEAT_PRO", "price_seat_pro");
    const db = makeDb();
    mocks.createSupabaseServiceRoleClient.mockReturnValue(db);
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "pro" });
    mocks.getManagerPurchaseSku.mockResolvedValue({ tier: "pro", billing: "monthly", stripeSubscriptionId: "sub_test" });
    const update = vi.fn().mockResolvedValue({ items: { data: [{ id: "si_seat", price: "price_seat_pro" }] } });
    mocks.getStripe.mockReturnValue({
      subscriptions: { update, retrieve: vi.fn().mockResolvedValue({ status: "active" }) },
    });

    const response = await POST(request({ addonId: "extra_seat", quantity: 1 }));

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(db.upsert).toHaveBeenCalledTimes(1);
  });

  it("writes quantities directly with no Stripe call for a non-billable (comp/Apple) account", async () => {
    const db = makeDb();
    mocks.createSupabaseServiceRoleClient.mockReturnValue(db);
    mocks.getEffectiveManagerSkuTier.mockResolvedValue({ ok: true, tier: "pro" });
    mocks.getManagerPurchaseSku.mockResolvedValue({ tier: "pro", billing: "apple", stripeSubscriptionId: null });
    mocks.getStripe.mockReturnValue({ subscriptions: { update: vi.fn(), retrieve: vi.fn() } });

    const response = await PATCH(request({ changes: [{ addonId: "extra_seat", quantity: 1 }] }));
    const body = (await response.json()) as { stripeSynced: boolean };

    expect(response.status).toBe(200);
    expect(body.stripeSynced).toBe(false);
    expect(db.upsert).toHaveBeenCalledTimes(1);
  });
});
