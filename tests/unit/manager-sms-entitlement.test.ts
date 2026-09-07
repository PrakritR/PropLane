import { afterEach, describe, expect, it, vi } from "vitest";
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
  stripeCheckoutSessionId: "cs_1",
  promoCode: null,
  appleOriginalTransactionId: null,
  readFailed: false,
  paidAt: new Date().toISOString(),
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("manager SMS entitlement", () => {
  it.each(["none", "stripe"] as const)("expires an enrolled %s trial without another reconciliation", async (source) => {
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "1");
    const db = createMemoryDb({
      sms_manager_entitlements: [],
      manager_purchases: [{ user_id: MANAGER, tier: "pro", billing: "trial", paid_at: PURCHASE.paidAt }],
    });
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => source === "stripe" ? PURCHASE : { ...PURCHASE, billing: "trial", stripeSubscriptionId: null },
      loadStripeSubscription: async () => ({ status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 3600 }) as never,
    })).resolves.toMatchObject({ eligible: true });
    const end = Date.parse(String(db.__tables.sms_manager_entitlements[0].valid_until));
    vi.spyOn(Date, "now").mockReturnValue(end);
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual({ eligible: false, reason: "canceled" });
  });

  it("preserves an enrolled trial when its snapshot cannot be read after enrollment closes", async () => {
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "0");
    const trialEnd = Math.floor(Date.now() / 1000) + 3600;
    const original = { manager_user_id: MANAGER, tier: "pro", source: "stripe", status: "trialing", eligible: true, valid_until: new Date(trialEnd * 1000).toISOString() };
    const db = createMemoryDb({ sms_manager_entitlements: [original] });
    const from = db.from.bind(db);
    vi.spyOn(db, "from").mockImplementationOnce((table) => {
      const query = from(table);
      query.maybeSingle = async () => ({ data: null, error: { message: "temporary read failure" } }) as never;
      return query;
    });
    const deps = {
      loadPurchase: async () => PURCHASE,
      loadStripeSubscription: async () => ({ status: "trialing", trial_end: trialEnd }) as never,
    };
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, deps)).resolves.toEqual({ eligible: false, reason: "plan_unreadable" });
    expect(db.__tables.sms_manager_entitlements[0]).toEqual(original);
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, deps)).resolves.toMatchObject({ eligible: true });
  });

  it.each(["pro", "business"])("temporarily enrolls a %s signup trial and preserves only its original window", async (tier) => {
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "1");
    const purchase = { ...PURCHASE, tier, billing: "trial", stripeSubscriptionId: null };
    const db = createMemoryDb({
      sms_manager_entitlements: [],
      manager_purchases: [{ user_id: MANAGER, tier, billing: "trial", paid_at: purchase.paidAt }],
    });
    const deps = { loadPurchase: async () => purchase };
    const eligible = { eligible: true, tier, source: "stripe" };
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, deps)).resolves.toEqual(eligible);
    expect(db.__tables.sms_manager_entitlements[0]).toMatchObject({ status: "trialing", source: "none", eligible: true });
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual(eligible);

    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "0");
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, deps)).resolves.toEqual(eligible);
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual(eligible);
    await expect(reconcileManagerSmsEntitlement(db as never, "another-manager", deps)).resolves.toEqual({ eligible: false, reason: "trialing" });

    db.__tables.manager_purchases[0].billing = "free";
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual({ eligible: false, reason: "plan_unreadable" });
  });

  it("enrolls Stripe trials only through their provider-confirmed end", async () => {
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "1");
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    const trialEnd = Math.floor(Date.now() / 1000) + 3600;
    const deps = {
      loadPurchase: async () => PURCHASE,
      loadStripeSubscription: async () => ({ status: "trialing", trial_end: trialEnd }) as never,
    };
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, deps)).resolves.toMatchObject({ eligible: true });
    expect(db.__tables.sms_manager_entitlements[0]).toMatchObject({
      status: "trialing", valid_until: new Date(trialEnd * 1000).toISOString(),
    });
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toMatchObject({ eligible: true });
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "0");
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, {
      ...deps, loadStripeSubscription: async () => ({ status: "trialing", trial_end: trialEnd + 3600 }) as never,
    })).resolves.toEqual({ eligible: false, reason: "trialing" });
  });

  it.each([null, "invalid", "2020-01-01T00:00:00.000Z"])("refuses signup trial with invalid or expired start %s", async (paidAt) => {
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "1");
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => ({ ...PURCHASE, billing: "trial", stripeSubscriptionId: null, paidAt }),
    })).resolves.toMatchObject({ eligible: false });
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toMatchObject({ eligible: false });
  });

  it("does not grant Free accounts access during trial onboarding", async () => {
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "1");
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    await expect(reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => ({ ...PURCHASE, tier: "free", billing: "free", stripeSubscriptionId: null }),
    })).resolves.toEqual({ eligible: false, reason: "free" });
  });

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
      loadStripeSubscription: async () => ({ status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 3600 }) as never,
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

  it("treats a comp grant as paid however it was granted", async () => {
    // The portal's own plan resolver reads three grant shapes that carry no
    // Stripe subscription. Messaging used to recognise only the first, so a
    // waiver-granted Business manager saw a paid plan everywhere except
    // Settings → Messaging, which refused their number outright.
    const grants = [
      { label: "admin billing", patch: { billing: "admin" } },
      { label: "admin-managed checkout", patch: { stripeCheckoutSessionId: "admin_abc" } },
      { label: "payment waiver", patch: { promoCode: "FREE100" } },
    ];
    for (const grant of grants) {
      const purchase = {
        ...PURCHASE,
        tier: "business",
        stripeSubscriptionId: null,
        stripeCheckoutSessionId: null,
        ...grant.patch,
      };
      const db = createMemoryDb({
        sms_manager_entitlements: [],
        manager_purchases: [{
          user_id: MANAGER,
          tier: purchase.tier,
          billing: purchase.billing,
          stripe_checkout_session_id: purchase.stripeCheckoutSessionId,
          promo_code: purchase.promoCode,
        }],
      });
      const result = await reconcileManagerSmsEntitlement(db as never, MANAGER, {
        loadPurchase: async () => ({
          ...PURCHASE,
          tier: "business",
          stripeSubscriptionId: null,
          stripeCheckoutSessionId: null,
          ...grant.patch,
        }),
        loadStripeSubscription: async () => {
          throw new Error(`${grant.label} must never reach Stripe`);
        },
      });

      expect(result, grant.label).toEqual({ eligible: true, tier: "business", source: "stripe" });
      expect(db.__tables.sms_manager_entitlements[0], grant.label).toEqual(
        expect.objectContaining({ eligible: true, status: "active", source: "none" }),
      );
      await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual(result);

      // Removing the grant must revoke dispatch access even if its snapshot
      // still says eligible.
      Object.assign(db.__tables.manager_purchases[0], {
        billing: "monthly", stripe_checkout_session_id: null, promo_code: null,
      });
      await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual({
        eligible: false, reason: "plan_unreadable",
      });
    }
  });

  it("recognizes a signup Business trial without treating it as an unverifiable payment", async () => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    const result = await reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => ({ ...PURCHASE, tier: "business", billing: "trial", stripeSubscriptionId: null }),
    });
    expect(result).toEqual({ eligible: false, reason: "trialing" });
    await expect(getStoredManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual(result);
  });

  it("still refuses a paid tier with no grant and no subscription", async () => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    const result = await reconcileManagerSmsEntitlement(db as never, MANAGER, {
      loadPurchase: async () => ({
        ...PURCHASE,
        tier: "business",
        stripeSubscriptionId: null,
        stripeCheckoutSessionId: null,
        promoCode: null,
      }),
    });

    expect(result).toEqual({ eligible: false, reason: "legacy_unknown" });
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
