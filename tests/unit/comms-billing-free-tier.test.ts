import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  isPureCoManagerWorkspace: vi.fn(async () => false),
  getAcceptedCoManagerInviterIds: vi.fn(async () => []),
}));

import { getEffectiveManagerSmsEntitlement, reconcileManagerSmsEntitlement } from "@/lib/sms/manager-sms-entitlement.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const base = {
  billing: "monthly",
  stripeCustomerId: "cus_1",
  stripeSubscriptionId: "sub_1",
  stripeCheckoutSessionId: "cs_1",
  promoCode: null as string | null,
  appleOriginalTransactionId: null as string | null,
  readFailed: false,
  paidAt: new Date().toISOString(),
};

beforeEach(() => vi.clearAllMocks());

/**
 * Round 3 plan model: a work number is a PAID feature. Free has none, a
 * signup or Stripe trial is not yet paying, and a FREE100 comp grant counts
 * as paying because the plan was granted, not trialled.
 */
describe("work numbers are for paying plans", () => {
  it("refuses Free", async () => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    await expect(
      reconcileManagerSmsEntitlement(db as never, MANAGER, {
        loadPurchase: async () => ({ ...base, tier: "free", billing: "free", stripeSubscriptionId: null }),
      }),
    ).resolves.toEqual({ eligible: false, reason: "free" });
  });

  it.each(["pro", "business"] as const)("grants an active paid %s subscription", async (tier) => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    await expect(
      reconcileManagerSmsEntitlement(db as never, MANAGER, {
        loadPurchase: async () => ({ ...base, tier }),
        loadStripeSubscription: async () => ({ status: "active", current_period_end: Math.floor(Date.now() / 1000) + 3600 }) as never,
      }),
    ).resolves.toEqual({ eligible: true, tier, source: "stripe" });
  });

  it("refuses a signup trial even while the trial is live", async () => {
    vi.stubEnv("SMS_TRIAL_WORK_NUMBER_ONBOARDING_ENABLED", "1");
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    await expect(
      reconcileManagerSmsEntitlement(db as never, MANAGER, {
        loadPurchase: async () => ({ ...base, tier: "pro", billing: "trial", stripeSubscriptionId: null }),
      }),
    ).resolves.toEqual({ eligible: false, reason: "trialing" });
    vi.unstubAllEnvs();
  });

  it("refuses a Stripe subscription that is still trialing", async () => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    await expect(
      reconcileManagerSmsEntitlement(db as never, MANAGER, {
        loadPurchase: async () => ({ ...base, tier: "business" }),
        loadStripeSubscription: async () => ({ status: "trialing", trial_end: Math.floor(Date.now() / 1000) + 3600 }) as never,
      }),
    ).resolves.toEqual({ eligible: false, reason: "trialing" });
  });

  it("treats a FREE100 waiver grant as paying", async () => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    await expect(
      reconcileManagerSmsEntitlement(db as never, MANAGER, {
        loadPurchase: async () => ({ ...base, tier: "pro", stripeSubscriptionId: null, stripeCheckoutSessionId: null, promoCode: "FREE100" }),
      }),
    ).resolves.toEqual({ eligible: true, tier: "pro", source: "stripe" });
  });

  it("does not grant access when the plan cannot be read", async () => {
    const db = createMemoryDb({ sms_manager_entitlements: [] });
    await expect(
      reconcileManagerSmsEntitlement(db as never, MANAGER, {
        loadPurchase: async () => ({ ...base, tier: null, readFailed: true }),
      }),
    ).resolves.toEqual({ eligible: false, reason: "plan_unreadable" });
    await expect(getEffectiveManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual({
      eligible: false,
      reason: "plan_unreadable",
    });
  });

  it("refuses a stored trial grant on the number path but keeps it for email", async () => {
    const validUntil = new Date(Date.now() + 3600_000).toISOString();
    const db = createMemoryDb({
      sms_manager_entitlements: [
        { manager_user_id: MANAGER, tier: "pro", source: "stripe", status: "trialing", eligible: true, valid_until: validUntil },
      ],
    });
    await expect(getEffectiveManagerSmsEntitlement(db as never, MANAGER)).resolves.toEqual({ eligible: false, reason: "trialing" });
    await expect(getEffectiveManagerSmsEntitlement(db as never, MANAGER, { preferPaid: true })).resolves.toMatchObject({
      eligible: true,
      trial: true,
    });
  });
});
