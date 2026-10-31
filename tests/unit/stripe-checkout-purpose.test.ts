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
import { MANAGER_PLAN_CHECKOUT_PURPOSE } from "@/lib/stripe/subscription-checkout-session";
import { RESIDENT_CARD_SETUP_PURPOSE } from "@/lib/stripe/resident-card-setup-purpose";

const session = (
  purpose?: string,
  mode: Stripe.Checkout.Session["mode"] = "subscription",
  extraMetadata: Record<string, string> = {},
) =>
  ({
    id: "cs_1",
    mode,
    metadata: { ...(purpose === undefined ? {} : { purpose }), ...extraMetadata },
  }) as unknown as Stripe.Checkout.Session;

describe("checkout purpose classification", () => {
  /**
   * The manager-plan branch used to be derived by subtracting a hand-copied list of named purposes,
   * so a new `purpose` added to the dispatch chain but not to that list silently became a manager
   * plan purchase. Then it was derived from the ABSENCE of a purpose, which was no better an
   * invariant: the resident card-setup session carried no metadata at all, so a resident saving a
   * card entered the manager-plan branch, found no reservation and made the webhook answer Stripe
   * 500 on every retry. It is now classified POSITIVELY, by the marker
   * `buildManagerSubscriptionCheckoutBase` stamps on the only two routes that create one.
   */
  it("treats only a session carrying the manager-plan marker as a manager plan", () => {
    expect(isManagerPlanCheckout(session(MANAGER_PLAN_CHECKOUT_PURPOSE))).toBe(true);
    for (const purpose of HANDLED_CHECKOUT_PURPOSES) {
      if (purpose === MANAGER_PLAN_CHECKOUT_PURPOSE) continue;
      expect(isManagerPlanCheckout(session(purpose))).toBe(false);
    }
    expect(isManagerPlanCheckout(session("deposit_hold"))).toBe(false);
    expect(isManagerPlanCheckout(session(MANAGER_CARD_SETUP_PURPOSE, "setup"))).toBe(false);
    expect(isManagerPlanCheckout(session(MANAGER_CARD_SETUP_PURPOSE, "subscription"))).toBe(false);
  });

  it("never reads a resident card-setup session as a manager plan", () => {
    // The exact shape `/api/stripe/resident-payment-methods` creates, and the shape it used to
    // create (no metadata at all) — neither may enter the manager-plan branch.
    expect(
      isManagerPlanCheckout(
        session(RESIDENT_CARD_SETUP_PURPOSE, "setup", { resident_user_id: "res-1", resident_payment_flow: "saved_card" }),
      ),
    ).toBe(false);
    expect(isManagerPlanCheckout(session(undefined, "setup", { resident_user_id: "res-1" }))).toBe(false);
    expect(isManagerPlanCheckout(session(undefined, "setup"))).toBe(false);
    expect(checkoutNeedsOwnerCheck(session(RESIDENT_CARD_SETUP_PURPOSE, "setup"))).toBe(false);
    expect(isUnhandledCheckoutPurpose(session(RESIDENT_CARD_SETUP_PURPOSE, "setup"))).toBe(false);
  });

  it("still recognises a pre-marker manager plan session by its reservation key", () => {
    // Sessions created before the marker shipped carry no purpose but do carry `manager_id` on a
    // subscription. They must still be fulfilled; a purposeless session with neither is not a plan.
    expect(isManagerPlanCheckout(session(undefined, "subscription", { manager_id: "AXIS-1", tier: "pro" }))).toBe(true);
    expect(isManagerPlanCheckout(session(undefined, "subscription"))).toBe(false);
    expect(isManagerPlanCheckout(session(undefined, "payment", { manager_id: "AXIS-1" }))).toBe(false);
  });

  it("names an unknown purpose unhandled rather than falling through to a plan", () => {
    expect(isUnhandledCheckoutPurpose(session("deposit_hold"))).toBe(true);
    expect(isUnhandledCheckoutPurpose(session())).toBe(false);
    for (const purpose of HANDLED_CHECKOUT_PURPOSES) expect(isUnhandledCheckoutPurpose(session(purpose))).toBe(false);
  });

  it("keeps the owner-resolvable purposes a subset of the handled ones", () => {
    expect(OWNER_RESOLVABLE_CHECKOUT_PURPOSES.size).toBe(6);
    for (const purpose of OWNER_RESOLVABLE_CHECKOUT_PURPOSES) expect(HANDLED_CHECKOUT_PURPOSES.has(purpose)).toBe(true);
    expect(HANDLED_CHECKOUT_PURPOSES.size).toBe(13);
  });

  it("asks for an owner only where one can be resolved", () => {
    expect(checkoutNeedsOwnerCheck(session(MANAGER_PLAN_CHECKOUT_PURPOSE))).toBe(true);
    expect(checkoutNeedsOwnerCheck(session(HOUSEHOLD_CHARGE_PURPOSE))).toBe(true);
    expect(checkoutNeedsOwnerCheck(session(RENTAL_APPLICATION_FEE_PURPOSE))).toBe(true);
    expect(checkoutNeedsOwnerCheck(session(MANAGER_CARD_SETUP_PURPOSE, "setup"))).toBe(false);
    expect(checkoutNeedsOwnerCheck(session("deposit_hold"))).toBe(false);
  });

  it("re-exports the two fee purposes from the modules that own them", () => {
    expect(RENTAL_APPLICATION_FEE_PURPOSE).toBe("rental_application_fee");
    expect(HOUSEHOLD_CHARGE_PURPOSE).toBe("household_charge");
  });
});
