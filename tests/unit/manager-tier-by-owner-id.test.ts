import { beforeEach, describe, expect, it, vi } from "vitest";

const eqCalls: [string, unknown][] = [];

/** A chainable stand-in for the service client: every call returns itself, awaiting it (or maybeSingle) yields one paid purchase row. */
function chain() {
  const row = { user_id: "22222222-2222-2222-2222-222222222222", tier: "business", billing: "admin", manager_id: "MGR-TEST", stripe_subscription_id: null, stripe_checkout_session_id: "e2e", promo_code: null, apple_original_transaction_id: null, paid_at: "2026-10-01T00:00:00Z" };
  const many = { data: [row], error: null };
  const one = { data: row, error: null };
  const proxy: unknown = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(many);
      if (prop === "eq") return (col: string, val: unknown) => { eqCalls.push([col, val]); return proxy; };
      if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve(many);
      return () => proxy;
    },
    apply() { return proxy; },
  });
  return proxy;
}

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => chain(), rpc: () => Promise.resolve({ data: null, error: null }) }) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/auth/view-as-guard", () => ({ isViewAsSessionOpen: () => false }));

import { getManagerSubscriptionTierByManagerId } from "@/lib/manager-access-server";

beforeEach(() => { eqCalls.length = 0; });

describe("getManagerSubscriptionTierByManagerId", () => {
  it("answers a manager's USER id from the user's own plan, never by looking it up as a manager code", async () => {
    const tier = await getManagerSubscriptionTierByManagerId("22222222-2222-2222-2222-222222222222");
    expect(tier).toBe("paid");
    expect(eqCalls.some(([col]) => col === "manager_id")).toBe(false);
  });

  it("still looks a manager code up by manager_id", async () => {
    await getManagerSubscriptionTierByManagerId("MGR-TEST");
    expect(eqCalls.some(([col, val]) => col === "manager_id" && val === "MGR-TEST")).toBe(true);
  });
});
