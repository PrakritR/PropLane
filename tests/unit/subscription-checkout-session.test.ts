import { describe, expect, it } from "vitest";
import {
  buildManagerSubscriptionCheckoutBase,
  MANAGER_PLAN_CHECKOUT_PURPOSE,
  MANAGER_SUBSCRIPTION_TRIAL_DAYS,
  subscriptionCheckoutUsesCardOnlyFunding,
} from "@/lib/stripe/subscription-checkout-session";

describe("buildManagerSubscriptionCheckoutBase", () => {
  it("includes a 14-day trial with card-only funding for manager signup", () => {
    const params = buildManagerSubscriptionCheckoutBase({
      priceId: "price_test",
      metadata: { tier: "pro", billing: "monthly" },
      trialPeriodDays: MANAGER_SUBSCRIPTION_TRIAL_DAYS,
    });

    expect(subscriptionCheckoutUsesCardOnlyFunding(params)).toBe(true);
    expect(params.subscription_data?.trial_period_days).toBe(14);
    // The plan marker is stamped by this builder, so it rides on the subscription metadata too —
    // the webhook classifies a manager plan by it, never by the absence of a `purpose`.
    expect(params.subscription_data?.metadata).toEqual({
      purpose: MANAGER_PLAN_CHECKOUT_PURPOSE,
      tier: "pro",
      billing: "monthly",
    });
  });
});
