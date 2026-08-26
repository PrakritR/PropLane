import { describe, expect, it } from "vitest";
import {
  getStoredManagerSmsEntitlement,
  reconcileManagerSmsEntitlement,
} from "@/lib/sms/manager-sms-entitlement.server";
import { createMemoryDb } from "./support/memory-supabase";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const PURCHASE = {
  tier: "pro",
  billing: "monthly",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  appleOriginalTransactionId: null,
  readFailed: false,
};

describe("manager SMS entitlement", () => {
  it("persists an active paid Stripe subscription for fast dispatch reads", async () => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    const validUntil = Math.floor(Date.now() / 1000) + 3600;
    const result = await reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => PURCHASE,
      loadStripeSubscription: async () => ({ status: "active", current_period_end: validUntil }) as never,
    });

    expect(result).toEqual({ eligible: true, tier: "pro", source: "stripe" });
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual(result);
  });

  it("does not grant SMS during a Stripe trial", async () => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    const result = await reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => PURCHASE,
      loadStripeSubscription: async () => ({ status: "trialing" }) as never,
    });

    expect(result).toEqual({ eligible: false, reason: "trialing" });
    expect(db.__tables.sms_manager_entitlements[0]).toEqual(
      expect.objectContaining({ eligible: false, status: "trialing", source: "stripe" }),
    );
  });

  it("keeps Free accounts ineligible instead of using the rollout allowlist as billing proof", async () => {
    const db = createMemoryDb({
      sms_manager_entitlements: [],
      sms_runtime_config: [{ singleton: true, pilot_manager_user_ids: [MANAGER] }],
    });
    const result = await reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => ({ ...PURCHASE, tier: "free", billing: "free", stripeSubscriptionId: null }),
    });

    expect(result).toEqual({ eligible: false, reason: "free" });
  });

  it("revalidates an Apple entitlement against the current purchase mirror", async () => {
    const db = createMemoryDb({
      sms_manager_entitlements: [],
      manager_purchases: [{
        user_id: MANAGER,
        tier: "business",
        billing: "apple",
        apple_original_transaction_id: "otx_1",
      }],
    });
    const result = await reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => ({
        ...PURCHASE,
        tier: "business",
        billing: "apple",
        stripeSubscriptionId: null,
        appleOriginalTransactionId: "otx_1",
      }),
    });

    expect(result).toEqual({ eligible: true, tier: "business", source: "apple" });
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual(result);
  });

  it("treats admin-assigned paid tiers as eligible without a Stripe subscription", async () => {
    const db = createMemoryDb({
      sms_manager_entitlements: [],
      manager_purchases: [{
        user_id: MANAGER,
        tier: "business",
        billing: "admin",
      }],
    });
    const result = await reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => ({
        ...PURCHASE,
        tier: "business",
        billing: "admin",
        stripeSubscriptionId: null,
      }),
    });

    expect(result).toEqual({ eligible: true, tier: "business", source: "stripe" });
    expect(db.__tables.sms_manager_entitlements[0]).toEqual(
      expect.objectContaining({ eligible: true, status: "active", source: "none", tier: "business" }),
    );
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual(result);
  });

  it("fails closed after the persisted Stripe coverage window expires", async () => {
    const db = createMemoryDb({
      sms_manager_entitlements: [{
        manager_user_id: MANAGER,
        tier: "pro",
        source: "stripe",
        status: "active",
        eligible: true,
        valid_until: "2020-01-01T00:00:00.000Z",
      }],
    });

    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual({
      eligible: false,
      reason: "canceled",
    });
  });
});
