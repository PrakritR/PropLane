/**
 * AXI-127 — "start 14 day free trial does WITHOUT payments whatsoever, does not
 * ask for card and instantly creates account. after 14 days downgrades and they
 * need to upgrade."
 *
 * The trial was ALREADY live on the account before this screen rendered
 * (provisioning puts it there) and `resolveEffectiveManagerTier` already drops
 * it to Free on day 15 by date alone. So the Stripe Checkout the button opened
 * bought nothing — it was a card wall in front of a product nobody had used yet.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveEffectiveManagerTier } from "@/lib/manager-tier-expiry";
import { MANAGER_SUBSCRIPTION_TRIAL_DAYS } from "@/lib/stripe/subscription-checkout-session";

const chooser = readFileSync("src/components/auth/manager-entry-plan-chooser.tsx", "utf8");
const cards = readFileSync("src/components/auth/manager-plan-tier-cards.tsx", "utf8");
const authCard = readFileSync("src/components/auth/auth-card.tsx", "utf8");

const DAY_MS = 86_400_000;
const paidAt = "2026-09-01T00:00:00.000Z";
const trial = { tier: "pro", billing: "trial", paid_at: paidAt };

describe("starting the trial asks for nothing", () => {
  it("no Stripe Checkout is mounted in the chooser at all", () => {
    expect(chooser).not.toContain("EmbeddedCheckoutMount");
    expect(chooser).not.toContain("checkoutClientSecret");
    expect(chooser).not.toContain("pricing-oauth-continue");
  });

  it("choosing a paid plan just enters the portal", () => {
    expect(chooser).toContain("window.location.replace(managerPortalEntryPath());");
  });

  it("says no card is required, for every plan", () => {
    expect(chooser).toContain("No card, whichever you choose.");
    expect(chooser).not.toContain("card required · first charge");
  });

  it("and says what happens on day 15", () => {
    expect(chooser).toContain("you move to Free unless you upgrade in Settings");
  });
});

describe("the trial ends on its own", () => {
  it("stays Pro during the trial", () => {
    const day13 = Date.parse(paidAt) + 13 * DAY_MS;
    expect(resolveEffectiveManagerTier(trial, day13)).toBe("pro");
  });

  it("drops to Free once the days are up — no Stripe involved", () => {
    const after = Date.parse(paidAt) + (MANAGER_SUBSCRIPTION_TRIAL_DAYS + 1) * DAY_MS;
    expect(resolveEffectiveManagerTier(trial, after)).toBe("free");
  });
});

describe("web and mobile are laid out separately", () => {
  it("both plan surfaces get the widest shell, not the single-column form width", () => {
    expect(authCard).toContain('widest ? "max-w-[76rem]"');
    expect(chooser).toContain("<AuthCard widest");
    expect(readFileSync("src/components/auth/manager-plan-picker.tsx", "utf8")).toContain("<AuthCard widest");
  });

  it("the columns spread further apart as the screen grows", () => {
    expect(cards).toContain("md:grid-cols-3 md:gap-5 lg:gap-7");
  });

  it("a phone stacks them and collapses the lists it is not being asked about", () => {
    // Three full feature lists stacked is a page of scrolling to answer one
    // question; the selected plan always shows everything.
    expect(cards).toContain('isSelected ? "" : "max-md:hidden"');
    expect(cards).toContain("Tap to see what&rsquo;s included");
  });
});
