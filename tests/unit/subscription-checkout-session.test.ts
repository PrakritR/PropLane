import { describe, expect, it } from "vitest";
import {
  buildManagerSubscriptionCheckoutBase,
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
    expect(params.subscription_data?.metadata).toEqual({ tier: "pro", billing: "monthly" });
  });
});
