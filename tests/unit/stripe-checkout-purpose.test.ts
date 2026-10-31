import { describe, expect, it } from "vitest";
import type Stripe from "stripe";

import {
  checkoutNeedsOwnerCheck,
  HANDLED_CHECKOUT_PURPOSES,
  HOUSEHOLD_CHARGE_PURPOSE,
  isManagerPlanCheckout,
  isUnhandledCheckoutPurpose,
  MANAGER_CARD_SETUP_PURPOSE,
  OWNER_RESOLVABLE_CHECKOUT_PURPOSES,
  RENTAL_APPLICATION_FEE_PURPOSE,
} from "@/lib/stripe/checkout-purpose";

const session = (purpose?: string, mode: Stripe.Checkout.Session["mode"] = "subscription") =>
  ({ id: "cs_1", mode, metadata: purpose === undefined ? {} : { purpose } }) as unknown as Stripe.Checkout.Session;

describe("checkout purpose classification", () => {
  /**
   * The manager-plan branch used to be derived by subtracting a hand-copied list of named purposes,
   * so a new `purpose` added to the dispatch chain but not to that list silently became a manager
   * plan purchase. It is now classified POSITIVELY by the absence of a purpose.
   */
  it("treats only a session with no purpose as a manager plan", () => {
    expect(isManagerPlanCheckout(session())).toBe(true);
    expect(isManagerPlanCheckout(session(""))).toBe(true);
    expect(isManagerPlanCheckout(session("   "))).toBe(true);
    for (const purpose of HANDLED_CHECKOUT_PURPOSES) expect(isManagerPlanCheckout(session(purpose))).toBe(false);
    expect(isManagerPlanCheckout(session("deposit_hold"))).toBe(false);
    expect(isManagerPlanCheckout(session(MANAGER_CARD_SETUP_PURPOSE, "setup"))).toBe(false);
    expect(isManagerPlanCheckout(session(MANAGER_CARD_SETUP_PURPOSE, "subscription"))).toBe(false);
  });

  it("names an unknown purpose unhandled rather than falling through to a plan", () => {
    expect(isUnhandledCheckoutPurpose(session("deposit_hold"))).toBe(true);
    expect(isUnhandledCheckoutPurpose(session())).toBe(false);
    for (const purpose of HANDLED_CHECKOUT_PURPOSES) expect(isUnhandledCheckoutPurpose(session(purpose))).toBe(false);
  });

  it("keeps the owner-resolvable purposes a subset of the handled ones", () => {
    expect(OWNER_RESOLVABLE_CHECKOUT_PURPOSES.size).toBe(6);
    for (const purpose of OWNER_RESOLVABLE_CHECKOUT_PURPOSES) expect(HANDLED_CHECKOUT_PURPOSES.has(purpose)).toBe(true);
    expect(HANDLED_CHECKOUT_PURPOSES.size).toBe(11);
  });

  it("asks for an owner only where one can be resolved", () => {
    expect(checkoutNeedsOwnerCheck(session())).toBe(true);
    expect(checkoutNeedsOwnerCheck(session(HOUSEHOLD_CHARGE_PURPOSE))).toBe(true);
    expect(checkoutNeedsOwnerCheck(session(RENTAL_APPLICATION_FEE_PURPOSE))).toBe(true);
    expect(checkoutNeedsOwnerCheck(session(MANAGER_CARD_SETUP_PURPOSE, "setup"))).toBe(false);
    expect(checkoutNeedsOwnerCheck(session("deposit_hold"))).toBe(false);
  });
});
