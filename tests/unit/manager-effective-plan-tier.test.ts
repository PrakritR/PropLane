/**
 * The plan the product DISPLAYS and the plan it ENFORCES have to be the same
 * plan. They were not.
 *
 * `manager_purchases.tier` is `null` for an ordinary account that signed up and
 * never reached the pricing step (`provisionPendingManagerAccount` inserts the
 * row with `tier: null`), and `normalizeManagerSkuTier` maps that to `null`.
 * Two readers then disagreed about the same row:
 *
 *   - `getManagerSubscriptionTier` and Settings' own `isFree` → "Free"
 *   - `maxPropertiesForManagerTier(null)` → `null`, i.e. NO property cap
 *
 * So Settings said "CURRENT PLAN Free · 1 property listing" on an account the
 * Properties tab let publish as many listings as it liked (audit F-SET-1).
 *
 * `resolveEffectiveManagerSkuTier` is that one rule, and every quota — the
 * client pre-check via `/api/manager/subscription`, and the server gate in
 * `POST /api/property-records` — is derived from it.
 */
import { describe, expect, it } from "vitest";
import { RATE_CARD } from "@/lib/billing/rate-card";
import {
  BUSINESS_MAX_PROPERTIES,
  FREE_MAX_PROPERTIES,
  managerPropertyLimitMessage,
  maxPropertiesForManagerTier,
  PRO_MAX_PROPERTIES,
  resolveEffectiveManagerSkuTier,
} from "@/lib/manager-access";

describe("resolveEffectiveManagerSkuTier", () => {
  it("returns a committed SKU unchanged", () => {
    expect(resolveEffectiveManagerSkuTier({ tier: "free" })).toBe("free");
    expect(resolveEffectiveManagerSkuTier({ tier: "pro" })).toBe("pro");
    expect(resolveEffectiveManagerSkuTier({ tier: "business" })).toBe("business");
    expect(resolveEffectiveManagerSkuTier({ tier: "  Business  " })).toBe("business");
  });

  it("resolves an account that never chose a plan to Free — what Settings already tells them", () => {
    expect(resolveEffectiveManagerSkuTier({ tier: null })).toBe("free");
    expect(resolveEffectiveManagerSkuTier({ tier: "" })).toBe("free");
    expect(resolveEffectiveManagerSkuTier({ tier: "  " })).toBe("free");
    // An unrecognized string is not a plan we can honour either.
    expect(resolveEffectiveManagerSkuTier({ tier: "platinum" })).toBe("free");
  });

  it("does NOT downgrade an unrecognized tier that a live subscription backs", () => {
    // A billing-sync gap must not quietly cap a paying account at 1 listing.
    expect(resolveEffectiveManagerSkuTier({ tier: null, stripeSubscriptionId: "sub_123" })).toBeNull();
    expect(resolveEffectiveManagerSkuTier({ tier: null, appleManaged: true })).toBeNull();
    // A blank subscription id is not a subscription.
    expect(resolveEffectiveManagerSkuTier({ tier: null, stripeSubscriptionId: "   " })).toBe("free");
  });

  it("gives the tier-less account the Free property cap it is shown", () => {
    // The bug in one line: this used to be `null`, which every caller read as
    // "uncapped", beside a Settings page reading "Free · 1 property listing".
    expect(maxPropertiesForManagerTier(resolveEffectiveManagerSkuTier({ tier: null }))).toBe(
      FREE_MAX_PROPERTIES,
    );
    expect(maxPropertiesForManagerTier(null)).toBeNull();
  });
});

/**
 * The refusal copy is shared by the client pre-checks and the server's 403 so a
 * manager reads the same sentence whichever layer caught them — and it always
 * names both the limit and the way past it.
 */
describe("managerPropertyLimitMessage", () => {
  it("names the limit and the plans that lift it", () => {
    // Free's cap is DOORS (PLAN-DOOR step 2), not the legacy property count.
    expect(managerPropertyLimitMessage("free")).toBe(
      `Free includes ${RATE_CARD.free.includedDoors} doors. Upgrade to Pro or Business for more doors.`,
    );
    expect(managerPropertyLimitMessage("pro")).toBe(
      `Pro includes up to ${PRO_MAX_PROPERTIES} properties. Upgrade to Business to add more.`,
    );
  });

  it("states the limit with no upgrade path on the top plan", () => {
    expect(managerPropertyLimitMessage("business")).toBe(
      `Business includes up to ${BUSINESS_MAX_PROPERTIES} properties.`,
    );
  });

  it("still states the limit on native iOS, only dropping the upgrade CTA", () => {
    // App Store Guideline 2.1(b): no subscription upgrade CTAs outside IAP. The
    // manager must still learn WHY the publish was refused.
    const native = managerPropertyLimitMessage("free", { omitUpgradeCta: true });
    expect(native).toBe(`Free includes ${RATE_CARD.free.includedDoors} doors.`);
    expect(native).not.toContain("Upgrade");
  });

  it("is never empty, even for a tier it does not recognize", () => {
    expect(managerPropertyLimitMessage(null).trim().length).toBeGreaterThan(0);
  });
});
