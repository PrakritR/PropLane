import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Counting harness for the per-request plan fan-out: one staff viewer linked to three owners. Every plan helper a
 * portal API request touches is called for the viewer and for each owner, as the nav, the workspace plan, the
 * comms wallet and the quota readers do. React `cache()` is the identity here (no render), which is exactly how a
 * route handler without request-scoped dedupe behaves, so the counts are the worst case per request.
 */
const VIEWER = "00000000-0000-4000-8000-000000000001";
const OWNERS = [
  "00000000-0000-4000-8000-0000000000a1",
  "00000000-0000-4000-8000-0000000000a2",
  "00000000-0000-4000-8000-0000000000a3",
];

const { counts, bump, noRowFor, failFor } = vi.hoisted(() => {
  const counts: Record<string, number> = {};
  return {
    counts,
    bump: (key: string) => { counts[key] = (counts[key] ?? 0) + 1; },
    noRowFor: new Set<string>(),
    failFor: new Set<string>(),
  };
});

function purchaseRow(userId: string) {
  return {
    id: `row-${userId}`, user_id: userId, tier: "business", billing: "monthly", manager_id: `MGR-${userId.slice(-2)}`,
    stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1", stripe_checkout_session_id: "cs_1",
    promo_code: null, apple_original_transaction_id: null, paid_at: "2026-10-01T00:00:00Z", promo_ends_at: null, email: null,
  };
}

function fakeFrom(table: string) {
  const filters: Record<string, unknown> = {};
  let rowsFor: () => unknown[] = () => [];
  const make = (): unknown => {
    const proxy: unknown = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
            bump(`db:${table}`);
            const failing = table === "manager_purchases" && failFor.has(String(filters.user_id));
            Promise.resolve(failing ? { data: null, error: { message: "boom" } } : { data: rowsFor(), error: null }).then(resolve, reject);
          };
        }
        if (prop === "eq") return (col: string, val: unknown) => { filters[col] = val; return proxy; };
        if (prop === "maybeSingle" || prop === "single") {
          return () => { bump(`db:${table}`); return Promise.resolve({ data: rowsFor()[0] ?? null, error: null }); };
        }
        return () => proxy;
      },
      apply() { return proxy; },
    });
    return proxy;
  };
  if (table === "manager_purchases") {
    rowsFor = () => (typeof filters.user_id === "string" && !noRowFor.has(String(filters.user_id)) ? [purchaseRow(String(filters.user_id))] : []);
  } else if (table === "account_link_invites") {
    rowsFor = () => OWNERS.map((owner) => ({ inviter_user_id: owner, team_role: "co_manager" }));
  }
  return make();
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => fakeFrom(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
    auth: {
      admin: {
        getUserById: async (id: string) => {
          bump("auth.admin.getUserById");
          return { data: { user: { id, email: `${id.slice(-2)}@example.com`, email_confirmed_at: "2026-01-01T00:00:00Z" } }, error: null };
        },
      },
    },
  }),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
// The provider reconcile (Stripe / RevenueCat, itself cached 60s per user) is out of scope here: a read-only session skips it.
vi.mock("@/lib/auth/view-as-guard", () => ({ isViewAsSessionOpen: () => true }));

import { invalidateManagerFactCaches, invalidateManagerPlanFacts } from "@/lib/manager-fact-caches";
import {
  getEffectiveManagerSkuTier,
  getManagerPortalNavSubscriptionTier,
  getManagerPurchaseSku,
  getManagerSubscriptionTier,
} from "@/lib/manager-access-server";

/** One portal API request's worth of plan reads for a staff viewer with three linked owners. */
async function onePortalRequest() {
  await Promise.all([
    getManagerPortalNavSubscriptionTier(VIEWER),
    getManagerPurchaseSku(VIEWER),
    getEffectiveManagerSkuTier(VIEWER),
    ...OWNERS.flatMap((owner) => [
      getEffectiveManagerSkuTier(owner),
      getManagerSubscriptionTier(owner),
      getManagerPurchaseSku(owner),
    ]),
  ]);
}

function snapshot() {
  const out = { ...counts };
  const total = Object.entries(out).filter(([k]) => k.startsWith("db:") || k.startsWith("auth.")).reduce((n, [, v]) => n + v, 0);
  return { ...out, total };
}

beforeEach(() => {
  for (const key of Object.keys(counts)) delete counts[key];
  process.env.MANAGER_FACT_CACHE_IN_TEST = "1";
  noRowFor.clear();
  failFor.clear();
  invalidateManagerFactCaches();
});

function reads(key: string) {
  return counts[key] ?? 0;
}

afterAll(() => { delete process.env.MANAGER_FACT_CACHE_IN_TEST; });

describe("manager plan read fan-out (staff viewer, three linked owners)", () => {
  it("reads each account's plan once per instance, however many helpers and requests ask", async () => {
    await onePortalRequest();
    const first = snapshot();
    // One purchase row and one Auth admin lookup per DISTINCT account (viewer + 3 owners), not per helper call
    // (before: 15 Auth lookups and 30 purchase reads for the same request).
    expect(reads("auth.admin.getUserById")).toBe(4);
    expect(reads("db:manager_purchases")).toBeLessThanOrEqual(8);
    console.log("FANOUT first request", JSON.stringify(first));

    for (const key of Object.keys(counts)) delete counts[key];
    await onePortalRequest();
    const second = snapshot();
    console.log("FANOUT second request (same instance)", JSON.stringify(second));
    expect(reads("auth.admin.getUserById")).toBe(0);
    expect(reads("db:manager_purchases")).toBe(0);
  });

  it("re-reads exactly the account whose plan was written", async () => {
    await onePortalRequest();
    for (const key of Object.keys(counts)) delete counts[key];
    invalidateManagerPlanFacts(OWNERS[1]!);
    await onePortalRequest();
    expect(reads("auth.admin.getUserById")).toBe(1);
  });

  it("never keeps an account with no purchase row yet (a signup or first checkout writes exactly that row)", async () => {
    const stranger = "00000000-0000-4000-8000-0000000000ff";
    noRowFor.add(stranger);
    await getManagerPurchaseSku(stranger);
    await getManagerPurchaseSku(stranger);
    expect(reads("auth.admin.getUserById")).toBe(2);
  });

  it("never keeps a failed read, and shares one in-flight read between concurrent callers", async () => {
    const flaky = "00000000-0000-4000-8000-0000000000ee";
    failFor.add(flaky);
    const failed = await getManagerPurchaseSku(flaky);
    expect(failed.readFailed).toBe(true);
    failFor.delete(flaky);
    for (const key of Object.keys(counts)) delete counts[key];
    const [a, b] = await Promise.all([getManagerPurchaseSku(flaky), getManagerPurchaseSku(flaky)]);
    expect(a.readFailed).toBe(false);
    expect(b.readFailed).toBe(false);
    expect(reads("auth.admin.getUserById")).toBe(1);
  });
});
