import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.hoisted(() => vi.fn());
const getStripe = vi.hoisted(() => vi.fn());
const managerActor = vi.hoisted(() => vi.fn());
const ensureCustomer = vi.hoisted(() => vi.fn());
const resolvePrice = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({
  auth: { getUser }, from: () => ({ select() { return this; }, eq() { return this; },
    maybeSingle: async () => ({ data: { email: "manager@example.com", manager_id: "MGR-1", full_name: "Manager" }, error: null }) }),
}) }));
vi.mock("@/lib/manager-route-guard.server", () => ({ requireManagerRouteUser: managerActor }));
vi.mock("@/lib/manager-stripe-customer.server", () => ({ ensureManagerBillingCustomer: ensureCustomer }));
vi.mock("@/lib/stripe/resolve-manager-price", () => ({ resolveStripePriceIdForPaidTier: resolvePrice }));
vi.mock("@/lib/stripe", () => ({ getStripe }));
vi.mock("@/lib/test-workspaces/effects.server", () => ({ assertTestWorkspaceProviderEffectAllowed: vi.fn() }));
vi.mock("@/lib/app-url", () => ({ resolveAppOrigin: () => "http://localhost:3000" }));
vi.mock("@/lib/manager-purchase-from-session", () => ({
  recordPaidManagerCheckoutSession: vi.fn(),
  checkoutSessionIndicatesPaidPurchase: (session: { status: string; payment_status: string }) =>
    session.status === "complete" && ["paid", "no_payment_required"].includes(session.payment_status),
}));

import { POST } from "@/app/api/stripe/checkout-portal/route";

type Purchase = { id: string; user_id: string; email: string; manager_id: string; tier: string;
  billing: string; stripe_subscription_id: string | null; stripe_checkout_session_id: string | null;
  apple_original_transaction_id: string | null };

function fixture(overrides: Partial<Purchase> = {}, readError = false) {
  const purchase: Purchase = { id: "purchase-1", user_id: "owner-1", email: "manager@example.com",
    manager_id: "MGR-1", tier: "pro", billing: "trial", stripe_subscription_id: null,
    stripe_checkout_session_id: "axis_intent_trial", apple_original_transaction_id: null, ...overrides };
  const updates: Record<string, unknown>[] = [];
  const db = { from: (table: string) => {
    const conditions: Array<[string, unknown]> = [];
    let patch: Record<string, unknown> | null = null;
    const query = {
      select: () => query,
      eq: (field: string, value: unknown) => { conditions.push([field, value]); return query; },
      is: (field: string, value: unknown) => { conditions.push([field, value]); return query; },
      limit: async () => ({ data: [], error: null }),
      update: (value: Record<string, unknown>) => { patch = value; return query; },
      maybeSingle: async () => {
        if (readError && patch === null) return { data: null, error: { message: "read failed" } };
        if (patch) {
          const matches = conditions.every(([field, value]) => (purchase as unknown as Record<string, unknown>)[field] === value);
          if (!matches) return { data: null, error: null };
          updates.push(patch);
          Object.assign(purchase, patch);
          return { data: { id: purchase.id }, error: null };
        }
        return { data: table === "manager_purchases" ? purchase : null, error: null };
      },
    };
    return query;
  } };
  managerActor.mockResolvedValue({ userId: "owner-1", db });
  return { purchase, updates };
}

function post(tier = "pro", billing = "monthly") {
  return POST(new Request("http://localhost:3000/api/stripe/checkout-portal", { method: "POST",
    body: JSON.stringify({ tier, billing, embedded: true }) }));
}

describe("portal signup trial activation", () => {
  let create: ReturnType<typeof vi.fn>;
  let expire: ReturnType<typeof vi.fn>;
  let subscriptions: ReturnType<typeof vi.fn>;
  let retrieve: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.clearAllMocks();
    getUser.mockResolvedValue({ data: { user: { id: "owner-1", email: "manager@example.com" } } });
    ensureCustomer.mockResolvedValue("cus_owner");
    resolvePrice.mockResolvedValue("price_pro_monthly");
    let n = 0;
    const sessions = new Map<string, Record<string, unknown>>();
    create = vi.fn(async (params: Record<string, unknown>) => {
      const session = { id: `cs_trial_${++n}`, client_secret: `secret_${n}`, status: "open",
        mode: "subscription", customer: params.customer, metadata: params.metadata };
      sessions.set(session.id, session);
      return session;
    });
    expire = vi.fn(async () => ({}));
    retrieve = vi.fn(async (id: string) => sessions.get(id));
    subscriptions = vi.fn(async () => ({ data: [], has_more: false }));
    getStripe.mockReturnValue({ checkout: { sessions: { create, expire, retrieve } },
      subscriptions: { list: subscriptions } });
  });

  it("starts same-tier paid Pro without changing the trial entitlement before payment", async () => {
    const { purchase, updates } = fixture();
    const result = await post();
    expect(result.status).toBe(200);
    expect((await result.json()).embedded).toBe(true);
    expect(purchase).toMatchObject({ tier: "pro", billing: "trial", stripe_checkout_session_id: "cs_trial_1" });
    expect(updates).toEqual([{ stripe_checkout_session_id: "cs_trial_1" }]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(subscriptions).toHaveBeenCalledWith(expect.objectContaining({ customer: "cus_owner", status: "all" }));
  });

  it("lets only one of two simultaneous requests reserve the trial", async () => {
    const { purchase, updates } = fixture();
    const results = await Promise.all([post(), post()]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(updates).toHaveLength(1);
    expect(purchase.billing).toBe("trial");
    expect(expire).toHaveBeenCalledTimes(1);
  });

  it("reuses the same open trial activation session on a retry", async () => {
    fixture();
    const first = await post();
    const second = await post();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await second.json()).sessionId).toBe((await first.json()).sessionId);
    expect(create).toHaveBeenCalledTimes(1);
    expect(expire).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith("cs_trial_1");
  });

  it("keeps a completed but unpaid earlier session pending instead of creating another", async () => {
    fixture({ stripe_checkout_session_id: "cs_pending" });
    retrieve.mockResolvedValueOnce({ id: "cs_pending", status: "complete", payment_status: "unpaid",
      mode: "subscription", customer: "cus_owner",
      metadata: { userId: "owner-1", manager_id: "MGR-1", tier: "pro", billing: "monthly" } });
    const result = await post();
    expect(result.status).toBe(409);
    expect((await result.json()).error).toMatch(/processing/);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { tier: "pro", billing: "monthly", stripe_subscription_id: "sub_paid" },
    { tier: "business", billing: "annual", apple_original_transaction_id: "apple_paid" },
  ])("does not create a second subscription for a paid account", async (purchase) => {
    fixture(purchase);
    expect((await post()).status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });

  it("fails closed when the purchase read fails", async () => {
    fixture({}, true);
    expect((await post()).status).toBe(409);
    expect(create).not.toHaveBeenCalled();
  });
});
