/**
 * The daily slow path behind the managed view-only lock: every PAID manager_purchases row re-checked against the
 * provider, so a cancellation no webhook ever landed cannot leave a managed workspace unlocked for ever.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const calls = vi.hoisted(() => ({ stripe: [] as string[], apple: [] as string[], fail: new Set<string>() }));
vi.mock("@/lib/manager-stripe-subscription-sync", () => ({
  reconcileManagerPurchaseWithStripe: async (userId: string) => {
    calls.stripe.push(userId);
    if (calls.fail.has(userId)) throw new Error("stripe unavailable");
  },
}));
vi.mock("@/lib/manager-apple-subscription-sync", () => ({
  reconcileManagerPurchaseWithApple: async (userId: string) => { calls.apple.push(userId); },
}));

import { reconcileManagerPlans } from "@/lib/billing/reconcile-manager-plans.server";
import { createFakeDb } from "../helpers/fake-table-db";

const row = (over: Record<string, unknown>) => ({ tier: "pro", stripe_subscription_id: null, apple_original_transaction_id: null, stripe_checkout_session_id: null, ...over });

beforeEach(() => {
  calls.stripe.length = 0;
  calls.apple.length = 0;
  calls.fail.clear();
});

describe("reconcileManagerPlans", () => {
  it("re-checks every paid row against the provider that governs it", async () => {
    const db = createFakeDb({
      manager_purchases: [
        row({ user_id: "stripe-user", stripe_subscription_id: "sub_1" }),
        row({ user_id: "apple-user", tier: "business", apple_original_transaction_id: "2000001" }),
        row({ user_id: "free-user", tier: "free", stripe_subscription_id: "sub_2" }),
        // An admin grant has no provider to ask, even though the row carries a session id.
        row({ user_id: "granted-user", stripe_subscription_id: "sub_3", stripe_checkout_session_id: "admin_mgr-9" }),
        row({ user_id: "no-anchor-user" }),
      ],
    });
    const result = await reconcileManagerPlans(db as never);
    expect(calls.stripe).toEqual(["stripe-user"]);
    expect(calls.apple).toEqual(["apple-user"]);
    expect(result).toMatchObject({ checked: 2, reconciled: 2, failed: 0 });
  });

  it("a transient provider failure is reported, never swallowed, and the rest still run", async () => {
    calls.fail.add("broken-user");
    const db = createFakeDb({
      manager_purchases: [
        row({ user_id: "broken-user", stripe_subscription_id: "sub_1" }),
        row({ user_id: "fine-user", stripe_subscription_id: "sub_2" }),
      ],
    });
    const result = await reconcileManagerPlans(db as never);
    expect(result).toMatchObject({ checked: 2, reconciled: 1, failed: 1 });
    expect(result.errors[0]).toContain("broken-user");
    expect(calls.stripe).toEqual(["broken-user", "fine-user"]);
  });

  it("a read failure throws so the cron reports it rather than claiming a clean sweep", async () => {
    const db = {
      from: () => ({
        select: () => ({ in: () => ({ order: () => ({ range: async () => ({ data: null, error: { message: "boom" } }) }) }) }),
      }),
    };
    await expect(reconcileManagerPlans(db as never)).rejects.toThrow(/boom/);
  });
});
