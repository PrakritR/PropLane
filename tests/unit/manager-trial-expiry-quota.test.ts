/**
 * A lapsed 14-day signup trial must read Free to the QUOTAS, not just the sidebar.
 *
 * Nothing rewrites `manager_purchases` when a trial ends — the row keeps
 * `tier: "pro", billing: "trial"` forever and expiry is pure date math off
 * `paid_at`. The nav locks already applied it, so the sidebar said Free; the
 * quota resolver read `tier` alone and answered Pro, so a lapsed trial kept the
 * Pro property cap and the Pro communication allowance for the life of the
 * account. The plan the product ENFORCES has to equal the plan it DISPLAYS.
 */
import { describe, expect, it } from "vitest";
import { resolveEffectiveManagerSkuTier, maxPropertiesForManagerTier } from "@/lib/manager-access";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";

const PAID_AT = "2026-09-01T00:00:00.000Z";
const day = (n: number) => Date.parse(PAID_AT) + n * 24 * 60 * 60 * 1000;

const trial = (tier: string) => ({ tier, billing: "trial", paidAt: PAID_AT });

describe("signup trial expiry reaches the quota resolver", () => {
  it("the trial is 14 days", () => {
    expect(MANAGER_SUBSCRIPTION_TRIAL_DAYS).toBe(14);
  });

  it("holds the paid tier while the trial is live", () => {
    expect(resolveEffectiveManagerSkuTier({ ...trial("pro"), nowMs: day(0) })).toBe("pro");
    expect(resolveEffectiveManagerSkuTier({ ...trial("pro"), nowMs: day(13) })).toBe("pro");
    expect(resolveEffectiveManagerSkuTier({ ...trial("business"), nowMs: day(13) })).toBe("business");
  });

  it("drops to Free on day 14, by date alone", () => {
    expect(resolveEffectiveManagerSkuTier({ ...trial("pro"), nowMs: day(14) })).toBe("free");
    expect(resolveEffectiveManagerSkuTier({ ...trial("pro"), nowMs: day(90) })).toBe("free");
    expect(resolveEffectiveManagerSkuTier({ ...trial("business"), nowMs: day(14) })).toBe("free");
  });

  it("takes the property cap down with it", () => {
    const live = resolveEffectiveManagerSkuTier({ ...trial("business"), nowMs: day(1) });
    const lapsed = resolveEffectiveManagerSkuTier({ ...trial("business"), nowMs: day(15) });
    expect(maxPropertiesForManagerTier(live)).toBeGreaterThan(1);
    expect(maxPropertiesForManagerTier(lapsed)).toBe(maxPropertiesForManagerTier("free"));
  });

  it("never expires a real subscription — a card, not a clock, ends those", () => {
    expect(
      resolveEffectiveManagerSkuTier({
        tier: "pro",
        billing: "trial",
        paidAt: PAID_AT,
        stripeSubscriptionId: "sub_123",
        nowMs: day(400),
      }),
    ).toBe("pro");
    expect(
      resolveEffectiveManagerSkuTier({
        tier: "pro",
        billing: "trial",
        paidAt: PAID_AT,
        appleManaged: true,
        nowMs: day(400),
      }),
    ).toBe("pro");
  });

  it("leaves comp and admin grants alone — they are not trials", () => {
    for (const billing of ["admin", "portal", "monthly", "annual"]) {
      expect(
        resolveEffectiveManagerSkuTier({ tier: "pro", billing, paidAt: PAID_AT, nowMs: day(400) }),
      ).toBe("pro");
    }
  });

  it("is unchanged for a caller that passes no billing row at all", () => {
    expect(resolveEffectiveManagerSkuTier({ tier: "pro" })).toBe("pro");
    expect(resolveEffectiveManagerSkuTier({ tier: null })).toBe("free");
    expect(resolveEffectiveManagerSkuTier({ tier: null, stripeSubscriptionId: "sub_1" })).toBeNull();
  });
});
