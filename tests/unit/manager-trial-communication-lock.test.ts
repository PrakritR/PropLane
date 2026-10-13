/**
 * A manager on a LIVE no-card signup trial has no Communication until the account pays (Stripe /
 * Apple) or holds a waiver / admin / portal grant. This file is the pure half: which rows are a
 * live trial, what the nav tier says, and what the sidebar does with it. The server half (the
 * outbound refusal) is `manager-communication-access.test.ts`.
 *
 * Free is untouched on purpose: a manager who never trialled, or whose trial LAPSED, resolves to
 * Free and keeps the Communication Free already has.
 */
import { describe, expect, it } from "vitest";
import {
  FREE_SUBSCRIPTION_SECTIONS,
  isLiveSignupTrialPurchase,
  managerNavSubscriptionTierRank,
  managerSectionAllowedForTier,
  managerSectionLockedForTier,
  pickManagerPortalNavSubscriptionTier,
  resolveManagerPortalNavTierFromPurchase,
} from "@/lib/manager-access";
import { portalNavLockKind, portalNavLockNavigable, portalNavSectionLocked } from "@/lib/portals/nav-locks";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";

const PAID_AT = "2026-10-01T00:00:00.000Z";
const day = (n: number) => Date.parse(PAID_AT) + n * 24 * 60 * 60 * 1000;
const trial = { tier: "pro", billing: "trial", paidAt: PAID_AT };

describe("isLiveSignupTrialPurchase", () => {
  it("is true for a Pro or Business trial inside its 14 days", () => {
    expect(isLiveSignupTrialPurchase({ ...trial, nowMs: day(0) })).toBe(true);
    expect(isLiveSignupTrialPurchase({ ...trial, nowMs: day(MANAGER_SUBSCRIPTION_TRIAL_DAYS - 1) })).toBe(true);
    expect(isLiveSignupTrialPurchase({ ...trial, tier: "business", nowMs: day(3) })).toBe(true);
  });

  it("is false once the trial has lapsed - that account resolves to Free and keeps Free's Communication", () => {
    expect(isLiveSignupTrialPurchase({ ...trial, nowMs: day(MANAGER_SUBSCRIPTION_TRIAL_DAYS) })).toBe(false);
    expect(isLiveSignupTrialPurchase({ ...trial, nowMs: day(90) })).toBe(false);
  });

  it("is false for anything that is paid or granted", () => {
    const now = { nowMs: day(2) };
    expect(isLiveSignupTrialPurchase({ ...trial, stripeSubscriptionId: "sub_1", ...now })).toBe(false);
    expect(isLiveSignupTrialPurchase({ ...trial, appleManaged: true, ...now })).toBe(false);
    // A payment waiver (FREE100 etc.) is paid access, even on a row that still says trial.
    expect(isLiveSignupTrialPurchase({ ...trial, promoCode: "FREE100", ...now })).toBe(false);
    for (const billing of ["monthly", "annual", "admin", "portal", "apple", "free"]) {
      expect(isLiveSignupTrialPurchase({ tier: "pro", billing, paidAt: PAID_AT, ...now })).toBe(false);
    }
  });

  it("is false for Free and for an unrecognised or missing tier", () => {
    expect(isLiveSignupTrialPurchase({ ...trial, tier: "free", nowMs: day(1) })).toBe(false);
    expect(isLiveSignupTrialPurchase({ ...trial, tier: null, nowMs: day(1) })).toBe(false);
    expect(isLiveSignupTrialPurchase({ ...trial, tier: "enterprise", nowMs: day(1) })).toBe(false);
  });
});

describe("resolveManagerPortalNavTierFromPurchase", () => {
  const base = { readFailed: false, hasPurchaseRow: true, nowMs: day(2) };

  it("reports a live trial as trial, where the plain nav tier still says paid", () => {
    expect(resolveManagerPortalNavTierFromPurchase({ ...base, ...trial })).toBe("trial");
  });

  it("leaves every other plan exactly as it was", () => {
    expect(resolveManagerPortalNavTierFromPurchase({ ...base, ...trial, nowMs: day(40) })).toBe("free");
    expect(resolveManagerPortalNavTierFromPurchase({ ...base, tier: "free", billing: "free" })).toBe("free");
    expect(resolveManagerPortalNavTierFromPurchase({ ...base, tier: "pro", billing: "monthly", stripeSubscriptionId: "sub_1" })).toBe("paid");
    expect(resolveManagerPortalNavTierFromPurchase({ ...base, ...trial, promoCode: "FREE100" })).toBe("paid");
    expect(resolveManagerPortalNavTierFromPurchase({ ...base, tier: "business", billing: "admin" })).toBe("paid");
    expect(resolveManagerPortalNavTierFromPurchase({ ...base, readFailed: true, ...trial })).toBeNull();
    expect(resolveManagerPortalNavTierFromPurchase({ readFailed: false, hasPurchaseRow: false, tier: null })).toBe("free");
  });
});

describe("nav lock for a trial", () => {
  const lock = (section: string, tier: "free" | "paid" | "trial" | null) =>
    portalNavLockKind({ kind: "pro", section, subscriptionTier: tier });

  it("locks Communication as a live upsell link, not an inert row", () => {
    expect(lock("communication", "trial")).toBe("upsell");
    expect(portalNavSectionLocked({ kind: "pro", section: "communication", subscriptionTier: "trial" })).toBe(true);
    // The row still navigates: that click is the only way to the upgrade card.
    expect(portalNavLockNavigable({ kind: "pro", section: "communication", subscriptionTier: "trial" })).toBe(true);
    expect(portalNavLockKind({ kind: "manager", section: "communication", subscriptionTier: "trial" })).toBe("upsell");
  });

  it("changes no other section for a trial", () => {
    const sections = [
      "dashboard", "properties", "residents", "leases", "payments", "services", "documents", "financials",
      "applications", "tours", "tasks", "profile", "reports",
    ];
    for (const section of sections) {
      expect(lock(section, "trial"), section).toBe(lock(section, "paid"));
      expect(lock(section, "trial"), section).toBe("none");
    }
  });

  it("leaves Free and paid as they were: Free keeps Communication, paid has everything", () => {
    expect(FREE_SUBSCRIPTION_SECTIONS.has("communication")).toBe(true);
    expect(lock("communication", "free")).toBe("none");
    expect(lock("communication", "paid")).toBe("none");
    expect(lock("communication", null)).toBe("none");
    expect(lock("residents", "free")).toBe("upsell");
  });

  it("never locks a resident's Communication on a trial manager's account", () => {
    // A resident reads the manager's plan as free | paid | null, never "trial".
    expect(portalNavLockKind({ kind: "resident", section: "communication", subscriptionTier: "paid" })).toBe("none");
  });
});

describe("section gates", () => {
  it("a trial is allowed every section but Communication", () => {
    expect(managerSectionAllowedForTier("communication", "trial")).toBe(false);
    expect(managerSectionLockedForTier("communication", "trial")).toBe(true);
    for (const section of ["residents", "leases", "documents", "financials", "dashboard"]) {
      expect(managerSectionAllowedForTier(section, "trial"), section).toBe(true);
      expect(managerSectionLockedForTier(section, "trial"), section).toBe(false);
    }
  });

  it("is unchanged for paid, unknown and Free", () => {
    expect(managerSectionAllowedForTier("communication", "paid")).toBe(true);
    expect(managerSectionAllowedForTier("communication", null)).toBe(true);
    expect(managerSectionAllowedForTier("communication", "free")).toBe(true);
    expect(managerSectionAllowedForTier("residents", "free")).toBe(false);
  });
});

describe("a teammate in a trial owner's workspace follows the owner's plan", () => {
  it("a co-manager with no portfolio of their own inherits a trial owner", () => {
    expect(pickManagerPortalNavSubscriptionTier("free", false, ["trial"])).toBe("trial");
  });

  it("an owner with houses keeps their own plan", () => {
    expect(pickManagerPortalNavSubscriptionTier("paid", true, ["trial"])).toBe("paid");
  });

  it("a paid owner beats a trial one, and the ranking keeps free < trial < unknown < paid", () => {
    expect(pickManagerPortalNavSubscriptionTier("free", false, ["trial", "paid"])).toBe("paid");
    const ranks = (["free", "trial", null, "paid"] as const).map((t) => managerNavSubscriptionTierRank(t));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(4);
  });
});
