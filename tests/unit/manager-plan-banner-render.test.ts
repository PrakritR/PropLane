/**
 * AXI-129 — "their account should be downgraded after 14 days from a pro/business
 * and they need to pay."
 *
 * The downgrade already happened on its own (`resolveEffectiveManagerTier` drops
 * an expired trial to Free by date), and Settings has had a Billing tab to pay
 * from. What was missing was the middle: `buildProPortalDefinition` computed
 * `showPlanBanner` for a banner component that NO layout ever mounted, so a
 * manager whose trial ran out silently lost residents, leases, inbox and
 * co-managers with nothing on screen saying why or where to pay.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const layout = readFileSync("src/app/portal/layout.tsx", "utf8");
const banner = readFileSync("src/components/portal/manager-plan-banner.tsx", "utf8");
const proNav = readFileSync("src/lib/portals/pro-nav.ts", "utf8");

describe("the free-plan banner actually reaches the screen", () => {
  it("the portal layout renders it", () => {
    expect(layout).toContain("ManagerPlanBanner");
    expect(layout).toContain("nav.showPlanBanner ?");
  });

  it("only for a free account", () => {
    // A paying manager must never see an upgrade banner.
    expect(proNav).toContain("showPlanBanner: isFree");
  });

  it("says something different when the TRIAL ended", () => {
    // "You're on the Free plan" is not news to someone who chose Free; it is
    // news to someone who just lost four sections overnight.
    expect(banner).toContain("Your free trial has ended");
    expect(layout).toContain("lapsedFromTrial={nav.planLapsedFromTrial}");
  });

  it("recognises a lapse from the stored row, without re-deriving dates", () => {
    // The row still says pro/business + trial; `isFree` has already applied the
    // date-based expiry, so the two together identify the lapse.
    expect(proNav).toContain('(purchase.billing ?? "").toLowerCase() === "trial"');
    expect(proNav).toContain('purchasedTier === "pro" || purchasedTier === "business"');
    expect(proNav).toContain("isFree &&");
  });

  it("routes to the place they can actually pay", () => {
    expect(banner).toContain("MANAGER_PLAN_PORTAL_URL");
    expect(banner).toContain("Upgrade to Pro or Business");
  });

  it("stays hidden on native iOS, where in-app subscription CTAs are not allowed", () => {
    expect(banner).toContain("native-hide");
  });
});
