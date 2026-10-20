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

import { MANAGER_PLAN_RECONCILE_RETRY_HOURS, reconcileManagerPlans } from "@/lib/billing/reconcile-manager-plans.server";
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
        select: () => ({ in: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: "boom" } }) }) }) }),
      }),
    };
    await expect(reconcileManagerPlans(db as never)).rejects.toThrow(/boom/);
  });

  it("takes the least recently checked rows and stamps what it finished, so the queue advances", async () => {
    const NOW = new Date("2026-10-20T08:40:00Z");
    const db = createFakeDb({
      manager_purchases: [
        { id: "p-new", ...row({ user_id: "never-checked", stripe_subscription_id: "sub_1" }) },
        { id: "p-old", ...row({ user_id: "checked-long-ago", stripe_subscription_id: "sub_2" }), plan_reconciled_at: "2026-10-01T00:00:00Z" },
        { id: "p-today", ...row({ user_id: "checked-today", stripe_subscription_id: "sub_3" }), plan_reconciled_at: "2026-10-20T07:00:00Z" },
      ],
    });
    await reconcileManagerPlans(db as never, NOW);
    // Never-checked first, then oldest: the same prefix is never re-read every day while the tail starves.
    expect(calls.stripe).toEqual(["never-checked", "checked-long-ago", "checked-today"]);
    expect(db.tables.manager_purchases!.map((r) => r.plan_reconciled_at)).toEqual([NOW.toISOString(), NOW.toISOString(), NOW.toISOString()]);
  });

  it("a row whose provider could not answer backs off: stamped, with a retry-after, so the queue advances", async () => {
    const NOW = new Date("2026-10-20T08:40:00Z");
    calls.fail.add("broken-user");
    const db = createFakeDb({
      manager_purchases: [
        { id: "p-1", ...row({ user_id: "broken-user", stripe_subscription_id: "sub_1" }) },
        { id: "p-2", ...row({ user_id: "fine-user", stripe_subscription_id: "sub_2" }) },
      ],
    });
    await reconcileManagerPlans(db as never, NOW);
    // Left unstamped it kept its place at the head of the queue: 300 rows a provider always fails on could fill the
    // whole budget run after run, and the tail - where an unreconciled cancellation hides - was never read.
    const broken = db.tables.manager_purchases!.find((r) => r.id === "p-1")!;
    expect(broken.plan_reconciled_at).toBe(NOW.toISOString());
    expect(broken.plan_reconcile_retry_at).toBe(new Date(NOW.getTime() + MANAGER_PLAN_RECONCILE_RETRY_HOURS * 3_600_000).toISOString());
    const fine = db.tables.manager_purchases!.find((r) => r.id === "p-2")!;
    expect(fine.plan_reconciled_at).toBe(NOW.toISOString());
    expect(fine.plan_reconcile_retry_at ?? null).toBeNull();

    // Inside the back-off window the provider is not asked again, and a success clears it.
    calls.stripe.length = 0;
    await reconcileManagerPlans(db as never, new Date(NOW.getTime() + 3_600_000));
    expect(calls.stripe).toEqual(["fine-user"]);
    calls.fail.clear();
    calls.stripe.length = 0;
    const later = new Date(NOW.getTime() + (MANAGER_PLAN_RECONCILE_RETRY_HOURS + 1) * 3_600_000);
    await reconcileManagerPlans(db as never, later);
    expect(calls.stripe).toContain("broken-user");
    expect(db.tables.manager_purchases!.find((r) => r.id === "p-1")!.plan_reconcile_retry_at ?? null).toBeNull();
  });

});
