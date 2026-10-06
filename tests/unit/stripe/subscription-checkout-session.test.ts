import { describe, expect, it } from "vitest";
import {
  buildManagerSubscriptionCheckoutBase,
  subscriptionCheckoutApplePayDomains,
  subscriptionCheckoutUsesCardOnlyFunding,
} from "@/lib/stripe/subscription-checkout-session";

describe("subscription-checkout-session (Apple Pay)", () => {
  it("uses only in-app card funding and hides Link", () => {
    const params = buildManagerSubscriptionCheckoutBase({
      priceId: "price_test",
      metadata: { tier: "pro", billing: "monthly", manager_id: "AXIS-TEST" },
      customerEmail: "mgr@example.com",
      allowPromotionCodes: true,
    });

    expect(params.mode).toBe("subscription");
    expect(params.line_items).toEqual([{ price: "price_test", quantity: 1 }]);
    expect(subscriptionCheckoutUsesCardOnlyFunding(params)).toBe(true);
    expect(params.payment_method_types).toEqual(["card"]);
    expect(params.wallet_options).toEqual({ link: { display: "never" } });
  });

  it("ignores an unverified dynamic method configuration", () => {
    const prev = process.env.STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION;
    process.env.STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION = "pmc_test_subscriptions";
    try {
      const params = buildManagerSubscriptionCheckoutBase({
        priceId: "price_test",
        metadata: { tier: "business", billing: "annual", manager_id: "AXIS-TEST" },
      });
      expect(params).not.toHaveProperty("payment_method_configuration");
      expect(subscriptionCheckoutUsesCardOnlyFunding(params)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION;
      else process.env.STRIPE_SUBSCRIPTION_PAYMENT_METHOD_CONFIGURATION = prev;
    }
  });

  it("collects Apple Pay domains from public app URLs", () => {
    const prevCanonical = process.env.NEXT_PUBLIC_CANONICAL_APP_URL;
    const prevApp = process.env.NEXT_PUBLIC_APP_URL;
    process.env.NEXT_PUBLIC_CANONICAL_APP_URL = "https://www.axis-seattle-housing.com";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    try {
      expect(subscriptionCheckoutApplePayDomains()).toEqual(["www.axis-seattle-housing.com"]);
    } finally {
      process.env.NEXT_PUBLIC_CANONICAL_APP_URL = prevCanonical;
      process.env.NEXT_PUBLIC_APP_URL = prevApp;
    }
  });
});
