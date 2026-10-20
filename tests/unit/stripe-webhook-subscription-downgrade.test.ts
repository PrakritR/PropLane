/**
 * The managed view-only lock treats "self-paid" as the purchase row's CURRENT tier, so the whole control rests on a
 * cancellation reaching that row. Swallowing a failed downgrade acknowledged the event, Stripe never came back, and a
 * cancelled subscriber kept tier pro - and an unlocked managed workspace - for ever. The webhook now answers 500 so
 * Stripe redelivers, and a daily cron re-checks every paid row against the provider.
 */
import Stripe from "stripe";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  purchases: [] as Array<Record<string, unknown>>,
  downgradeError: null as { message: string } | null,
  updates: [] as Array<Record<string, unknown>>,
}));

const real = new Stripe("sk_test_unit", { apiVersion: "2025-01-27.acacia" as never });
const sigHolder = vi.hoisted(() => ({ value: "" }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => (name === "stripe-signature" ? sigHolder.value : null) }),
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => real }));
vi.mock("@/lib/number-subscription/subscription.server", () => ({
  NUMBER_SUBSCRIPTION_PURPOSE: "number_subscription",
  fulfillNumberSubscriptionCheckout: vi.fn(),
  isNumberSubscription: async () => false,
  isNumberSubscriptionInvoice: async () => false,
  syncNumberSubscriptionEvent: vi.fn(),
  syncNumberSubscriptionFromInvoice: vi.fn(),
}));
vi.mock("@/lib/test-workspaces/effects.server", () => ({
  captureTestWorkspaceEffectForUser: async () => ({ captured: false }),
}));
vi.mock("@/lib/sms/manager-sms-entitlement.server", () => ({
  reconcileManagerSmsEntitlement: async () => ({ eligible: true }),
}));
vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  applyScheduledDowngradeAfterInvoicePaid: vi.fn(),
  reconcileManagerPurchaseByStripeSubscriptionId: vi.fn(),
  reconcileManagerPurchaseWithStripe: vi.fn(),
}));
vi.mock("@/lib/manager-tier-sync-cache", () => ({ invalidateManagerTierCache: vi.fn() }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        range: async () => ({ data: table === "manager_purchases" ? state.purchases : [], error: null }),
        maybeSingle: async () => ({ data: table === "manager_purchases" ? (state.purchases[0] ?? null) : null, error: null }),
        update: (patch: Record<string, unknown>) => {
          state.updates.push({ table, ...patch });
          const result = { error: table === "manager_purchases" ? state.downgradeError : null };
          return { eq: () => result, then: (resolve: (v: unknown) => unknown) => resolve(result) };
        },
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return builder;
    },
  }),
}));

import { POST as webhook } from "@/app/api/stripe/webhook/route";

const SECRET = "whsec_platform_secret_value";

function signed(event: Record<string, unknown>): Request {
  const payload = JSON.stringify(event);
  sigHolder.value = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return new Request("http://localhost/api/stripe/webhook", { method: "POST", body: payload });
}

const deleted = {
  id: "evt_sub_deleted",
  object: "event",
  type: "customer.subscription.deleted",
  data: { object: { id: "sub_live_1", object: "subscription", status: "canceled", items: { data: [] }, metadata: {} } },
};

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", SECRET);
  state.purchases = [{ user_id: "mgr-1", tier: "pro", stripe_subscription_id: "sub_live_1" }];
  state.downgradeError = null;
  state.updates = [];
});

describe("customer.subscription.deleted", () => {
  it("downgrades the purchase row to free and acknowledges", async () => {
    const res = await webhook(signed(deleted));
    expect(res.status).toBe(200);
    expect(state.updates).toContainEqual({ table: "manager_purchases", tier: "free", billing: "free", stripe_subscription_id: null, subscription_status: null });
  });

  it("answers 500 so Stripe retries when the downgrade cannot be written", async () => {
    state.downgradeError = { message: "deadlock detected" };
    const res = await webhook(signed(deleted));
    expect(res.status).toBe(500);
  });
});
