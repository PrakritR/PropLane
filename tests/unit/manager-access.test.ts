import { describe, expect, it } from "vitest";
import {
  formatManagerMonthlyLabel,
  managerScreeningAllowedForTier,
  managerSectionAllowedForTier,
  managerSectionLockedForTier,
  managerPlanAllowsCoManagerInvites,
  managerTierPropertyLimitReached,
  maxAccountLinksForTier,
  maxPropertiesForManagerTier,
  normalizeManagerSkuTier,
  pickBestManagerPurchaseRow,
  residentSectionAllowedForManagerTier,
  residentSectionLockedForManagerTier,
  resolveManagerSubscriptionTierFromPurchase,
} from "@/lib/manager-access";

describe("manager-access", () => {
  it("normalizes tier strings", () => {
    expect(normalizeManagerSkuTier("free")).toBe("free");
    expect(normalizeManagerSkuTier("PRO")).toBe("pro");
    expect(normalizeManagerSkuTier("")).toBeNull();
    expect(normalizeManagerSkuTier("enterprise")).toBeNull();
  });

  it("enforces property limits per tier", () => {
    expect(maxPropertiesForManagerTier("free")).toBe(1);
    expect(maxPropertiesForManagerTier("pro")).toBe(2);
    expect(maxPropertiesForManagerTier("business")).toBe(20);
    expect(managerTierPropertyLimitReached("free", 1)).toBe(true);
    expect(managerTierPropertyLimitReached("pro", 1)).toBe(false);
  });

  it("limits account links per tier", () => {
    expect(maxAccountLinksForTier("free")).toBe(1);
    expect(maxAccountLinksForTier("pro")).toBe(2);
    expect(maxAccountLinksForTier("business")).toBe(20);
  });

  it("requires Pro or Business for co-manager invites", () => {
    expect(managerPlanAllowsCoManagerInvites("free")).toBe(false);
    expect(managerPlanAllowsCoManagerInvites("pro")).toBe(true);
    expect(managerPlanAllowsCoManagerInvites("business")).toBe(true);
    expect(managerPlanAllowsCoManagerInvites(null)).toBe(false);
  });

  it("gates free-tier sections", () => {
    expect(managerSectionAllowedForTier("properties", "free")).toBe(true);
    expect(managerSectionAllowedForTier("applications", "free")).toBe(true);
    expect(managerSectionAllowedForTier("residents", "free")).toBe(false);
    expect(managerSectionAllowedForTier("leases", "free")).toBe(false);
    expect(managerSectionAllowedForTier("services", "free")).toBe(false);
    expect(managerSectionAllowedForTier("communication", "free")).toBe(false);
    expect(managerSectionAllowedForTier("documents", "free")).toBe(false);
    expect(managerSectionAllowedForTier("financials", "free")).toBe(false);
    expect(managerSectionAllowedForTier("documents", "paid")).toBe(true);
    expect(managerSectionAllowedForTier("communication", "paid")).toBe(true);
  });

  it("requires paid plan for applicant screening", () => {
    expect(managerScreeningAllowedForTier("free")).toBe(false);
    expect(managerScreeningAllowedForTier("paid")).toBe(true);
  });

  it("marks paid-only sections as locked on free tier", () => {
    expect(managerSectionLockedForTier("residents", "free")).toBe(true);
    expect(managerSectionLockedForTier("relationships", "free")).toBe(true);
    expect(managerSectionLockedForTier("teams", "free")).toBe(true);
    expect(managerSectionLockedForTier("documents", "free")).toBe(true);
    expect(managerSectionLockedForTier("properties", "free")).toBe(false);
    expect(managerSectionLockedForTier("residents", "paid")).toBe(false);
    expect(managerSectionLockedForTier("residents", null)).toBe(false);
  });

  it("locks resident portal sections when linked manager is on free", () => {
    expect(residentSectionAllowedForManagerTier("payments", "free")).toBe(true);
    expect(residentSectionAllowedForManagerTier("lease", "free")).toBe(true);
    expect(residentSectionAllowedForManagerTier("tour", "free")).toBe(true);
    expect(residentSectionAllowedForManagerTier("services", "free")).toBe(false);
    expect(residentSectionAllowedForManagerTier("documents", "free")).toBe(false);
    expect(residentSectionAllowedForManagerTier("financials", "free")).toBe(false);
    expect(residentSectionAllowedForManagerTier("communication", "free")).toBe(true);
    expect(residentSectionLockedForManagerTier("services", "free")).toBe(true);
    expect(residentSectionAllowedForManagerTier("services", "paid")).toBe(true);
  });

  it("resolves subscription tier from purchase rows", () => {
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: "free",
        stripeSubscriptionId: null,
        hasPurchaseRow: true,
      }),
    ).toBe("free");
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: "pro",
        billing: "portal",
        stripeSubscriptionId: null,
        hasPurchaseRow: true,
      }),
    ).toBe("free");
    // Coupon / payment-waiver grant (FREE100): authorized paid access with no Stripe subscription.
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: "pro",
        billing: "portal",
        promoCode: "FREE100",
        stripeSubscriptionId: null,
        hasPurchaseRow: true,
      }),
    ).toBe("paid");
    // Waiver grant is comp access, so a monthly cadence does not lapse it.
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: "pro",
        billing: "monthly",
        promoCode: "FREE100",
        paidAt: "2000-01-01T00:00:00.000Z",
        stripeSubscriptionId: null,
        hasPurchaseRow: true,
      }),
    ).toBe("paid");
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: "business",
        billing: "admin",
        paidAt: "2026-06-01T00:00:00.000Z",
        stripeSubscriptionId: null,
        hasPurchaseRow: true,
      }),
    ).toBe("paid");
    // Apple IAP grant: paid via the App Store, no Stripe subscription, and an
    // ancient paid_at must NOT lapse it (Apple expiry is webhook-driven).
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: "pro",
        billing: "apple",
        appleOriginalTransactionId: "1000000123456789",
        paidAt: "2000-01-01T00:00:00.000Z",
        stripeSubscriptionId: null,
        hasPurchaseRow: true,
      }),
    ).toBe("paid");
    // billing=apple with no transaction anchor is NOT an authorized grant → free.
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: "pro",
        billing: "apple",
        appleOriginalTransactionId: null,
        stripeSubscriptionId: null,
        hasPurchaseRow: true,
      }),
    ).toBe("free");
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: null,
        stripeSubscriptionId: null,
        hasPurchaseRow: true,
      }),
    ).toBe("free");
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: null,
        stripeSubscriptionId: "sub_123",
        hasPurchaseRow: true,
      }),
    ).toBe("paid");
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: null,
        stripeSubscriptionId: null,
        hasPurchaseRow: false,
      }),
    ).toBeNull();
  });

  it("treats malformed legacy billing fields as absent instead of calling trim on them", () => {
    expect(() =>
      resolveManagerSubscriptionTierFromPurchase({
        tier: "pro",
        billing: [] as unknown as string,
        stripeSubscriptionId: { legacy: true } as unknown as string,
        promoCode: { legacy: true } as unknown as string,
        hasPurchaseRow: true,
      }),
    ).not.toThrow();
    expect(
      resolveManagerSubscriptionTierFromPurchase({
        tier: "pro",
        billing: [] as unknown as string,
        stripeSubscriptionId: { legacy: true } as unknown as string,
        promoCode: { legacy: true } as unknown as string,
        hasPurchaseRow: true,
      }),
    ).toBe("free");
  });

  it("formats monthly labels", () => {
    expect(formatManagerMonthlyLabel("free")).toBe("$0/mo");
    expect(formatManagerMonthlyLabel("pro")).toBe("$20/mo");
  });

  it("detects stripe-managed billing intervals", async () => {
    const { isStripeManagedBilling } = await import("@/lib/manager-access");
    expect(isStripeManagedBilling("monthly")).toBe(true);
    expect(isStripeManagedBilling("annual")).toBe(true);
    expect(isStripeManagedBilling("admin")).toBe(false);
    expect(isStripeManagedBilling("portal")).toBe(false);
    expect(isStripeManagedBilling("free")).toBe(false);
  });

  it("prefers linked signup tier over stale higher-tier checkout rows", () => {
    const userId = "user-1";
    const rows = [
      {
        id: "old-pro",
        tier: "pro",
        billing: "monthly",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        paid_at: "2026-06-01T00:00:00.000Z",
        user_id: null,
      },
      {
        id: "new-free",
        tier: "free",
        billing: "free",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        paid_at: "2026-06-27T00:00:00.000Z",
        user_id: userId,
      },
    ];
    const picked = pickBestManagerPurchaseRow(rows, userId);
    expect(picked?.id).toBe("new-free");
    expect(picked?.tier).toBe("free");
  });
});
