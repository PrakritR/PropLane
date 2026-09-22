import { afterEach, describe, expect, it } from "vitest";
import { RATE_CARD, RATE_CARD_TIERS } from "@/lib/billing/rate-card";
import {
  managerSkuToPaidTier,
  stripePriceIdForPaidTier,
  type PaidTier,
  type StripeBilling,
} from "@/lib/stripe-price-ids";

/**
 * What this test DOES pin, entirely hermetically (no network, no live Stripe
 * call):
 *
 *  1. Every tier in `RATE_CARD` has a complete price shape (floor + included
 *     doors) — no tier is silently missing a figure.
 *  2. The two axes agree on which tiers Stripe bills: `managerSkuToPaidTier`
 *     maps exactly the rate card's paid tiers (pro, business) to a `PaidTier`,
 *     and Free — which has no Stripe price — maps to `null`.
 *  3. For every paid tier × billing combination, `stripePriceIdForPaidTier`
 *     resolves an env-configured price id through the exact env var name
 *     `stripe-price-ids.ts` reads. This proves the plumbing has no missing
 *     combination (e.g. a billing cadence the switch forgot) — the test sets
 *     the env vars itself, since real Stripe keys are never available in a
 *     unit test.
 *
 * What this test does NOT and CANNOT check: that the Stripe Price object a
 * configured price id actually points to charges the amount `RATE_CARD` says
 * it should. That requires a live call (`stripe.prices.retrieve`), which is
 * out of reach for a hermetic unit test. A rate-card change still requires
 * updating the matching Stripe Price by hand (or a separate script/smoke test
 * that calls the real Stripe API) — this test only proves the CODE is
 * internally consistent with itself, never that Stripe agrees with it.
 */

const PAID_TIERS: PaidTier[] = ["pro", "business"];
const BILLINGS: StripeBilling[] = ["monthly", "annual"];

const ENV_VAR_NAME: Record<PaidTier, Record<StripeBilling, string>> = {
  pro: { monthly: "STRIPE_PRICE_PRO_MONTHLY", annual: "STRIPE_PRICE_PRO_ANNUAL" },
  business: { monthly: "STRIPE_PRICE_BUSINESS_MONTHLY", annual: "STRIPE_PRICE_BUSINESS_ANNUAL" },
};

const ALL_ENV_VARS = PAID_TIERS.flatMap((tier) => BILLINGS.map((billing) => ENV_VAR_NAME[tier][billing]));

describe("rate card <-> Stripe price id sync", () => {
  afterEach(() => {
    for (const name of ALL_ENV_VARS) delete process.env[name];
  });

  it("gives every rate-card tier a floor and an included-door count — nothing is missing", () => {
    for (const tier of RATE_CARD_TIERS) {
      const card = RATE_CARD[tier];
      expect(card.floorMonthlyCents, `${tier} floorMonthlyCents`).not.toBeUndefined();
      expect(card.floorAnnualCents, `${tier} floorAnnualCents`).not.toBeUndefined();
      expect(card.includedDoors, `${tier} includedDoors`).not.toBeUndefined();
      expect(Number.isFinite(card.floorMonthlyCents)).toBe(true);
      expect(Number.isFinite(card.floorAnnualCents)).toBe(true);
      expect(Number.isInteger(card.includedDoors)).toBe(true);
    }
  });

  it("maps exactly the rate card's paid tiers to a Stripe-billable PaidTier", () => {
    expect(managerSkuToPaidTier("pro")).toBe("pro");
    expect(managerSkuToPaidTier("business")).toBe("business");
    // Free is deliberately excluded from Stripe billing — no price id, no
    // Stripe subscription line.
    expect(managerSkuToPaidTier("free")).toBeNull();
  });

  it("resolves a configured price id for every paid tier x billing combination via its exact env var name", () => {
    for (const tier of PAID_TIERS) {
      for (const billing of BILLINGS) {
        const envVar = ENV_VAR_NAME[tier][billing];
        const fakePriceId = `price_test_${tier}_${billing}`;
        process.env[envVar] = fakePriceId;

        expect(stripePriceIdForPaidTier(tier, billing), `${tier}/${billing} should resolve ${envVar}`).toBe(
          fakePriceId,
        );

        delete process.env[envVar];
      }
    }
  });

  it("ignores a non-price-id env value the same way for every combination (no combination is special-cased)", () => {
    for (const tier of PAID_TIERS) {
      for (const billing of BILLINGS) {
        const envVar = ENV_VAR_NAME[tier][billing];
        process.env[envVar] = "not-a-price-id";
        expect(stripePriceIdForPaidTier(tier, billing)).toBeUndefined();
        delete process.env[envVar];
      }
    }
  });
});
