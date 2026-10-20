/**
 * A `manager_purchases` patch must not be lost because `subscription_status` is not there yet.
 *
 * The column arrives in migration 20261020130000. Checkout fulfillment and the `customer.subscription.deleted` webhook
 * both THROW on a write error (a 500 Stripe retries), and the plan reconciler swallows it (a cancellation silently not
 * recorded). So a missing column is retried once without the status: the tier, the billing and the cleared
 * subscription id still land, and the lock's status column catches up with the migration.
 */
import { describe, expect, it, vi } from "vitest";

import { isMissingSubscriptionStatusColumn, writeManagerPurchasePatch } from "@/lib/manager-purchase-subscription-status";

const missing = { code: "PGRST204", message: "Could not find the 'subscription_status' column of 'manager_purchases' in the schema cache" };

describe("isMissingSubscriptionStatusColumn", () => {
  it("recognises the PostgREST and Postgres answers", () => {
    expect(isMissingSubscriptionStatusColumn(missing)).toBe(true);
    expect(isMissingSubscriptionStatusColumn({ code: "42703", message: 'column "subscription_status" does not exist' })).toBe(true);
    expect(isMissingSubscriptionStatusColumn({ message: 'column "subscription_status" of relation "manager_purchases" does not exist' })).toBe(true);
  });

  it("is not fooled by an unrelated failure", () => {
    expect(isMissingSubscriptionStatusColumn({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isMissingSubscriptionStatusColumn({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isMissingSubscriptionStatusColumn(null)).toBe(false);
    expect(isMissingSubscriptionStatusColumn("boom")).toBe(false);
  });
});

describe("writeManagerPurchasePatch", () => {
  const patch = { tier: "free", billing: "free", stripe_subscription_id: null, subscription_status: null };

  it("writes once when the column is there", async () => {
    const run = vi.fn(async () => ({ error: null }));
    expect(await writeManagerPurchasePatch(patch, run)).toEqual({ error: null });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(patch);
  });

  it("retries without the status column, loudly, and the rest of the patch still lands", async () => {
    const run = vi.fn(async (p: Record<string, unknown>) => ("subscription_status" in p ? { error: missing } : { error: null }));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await writeManagerPurchasePatch(patch, run)).toEqual({ error: null });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]![0]).toEqual({ tier: "free", billing: "free", stripe_subscription_id: null });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("never retries another error, and never hides the second failure", async () => {
    const other = vi.fn(async () => ({ error: { code: "42501", message: "permission denied" } }));
    expect(await writeManagerPurchasePatch(patch, other)).toEqual({ error: { code: "42501", message: "permission denied" } });
    expect(other).toHaveBeenCalledTimes(1);

    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stillBroken = vi.fn(async () => ({ error: missing }));
    expect(await writeManagerPurchasePatch(patch, stillBroken)).toEqual({ error: missing });
    expect(stillBroken).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  it("does not retry a patch that never carried the status", async () => {
    const run = vi.fn(async () => ({ error: missing }));
    await writeManagerPurchasePatch({ tier: "pro" }, run);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
