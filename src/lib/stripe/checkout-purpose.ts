import type Stripe from "stripe";
import { COMMS_CREDIT_PURPOSE } from "@/lib/comms-billing/credit-packs";
import { COMMS_CREDIT_POOL_PURPOSE } from "@/lib/comms-billing/pool.server";
import { NUMBER_CREDIT_PURPOSE, NUMBER_SUBSCRIPTION_PURPOSE } from "@/lib/number-subscription/constants";
import { LINKED_FORM_FEE_PURPOSE } from "@/lib/linked-form-fee.server";
import { SCREENING_CHECKOUT_PURPOSE } from "@/lib/stripe-screening";
import { APPLICATION_FEE_CHECKOUT_PURPOSE, VENDOR_INVOICE_PAY_PURPOSE } from "@/lib/stripe-axis-ach-checkout";
import { HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE } from "@/lib/stripe-household-charge";
import { MANAGER_PLAN_CHECKOUT_PURPOSE } from "@/lib/stripe/subscription-checkout-session";
import { RESIDENT_CARD_SETUP_PURPOSE } from "@/lib/stripe/resident-card-setup-purpose";
import { VENDOR_INVOICE_DIRECT_PAY_PURPOSE } from "@/lib/vendor-invoice-pay.server";

/**
 * One classification of a Checkout session's `purpose`, shared by the webhook's
 * ownership guard and its dispatch chain so the two can never drift.
 *
 * Every kind is classified POSITIVELY, by a marker its own creator stamps. A manager plan used to
 * be recognised by the ABSENCE of a `purpose`, which was never a real invariant: the resident
 * payment-method setup session carried no metadata at all, so a resident saving a card landed in
 * the manager-plan branch, found no reservation, and made the webhook answer Stripe 500 on every
 * retry of that event. `buildManagerSubscriptionCheckoutBase` now stamps
 * `MANAGER_PLAN_CHECKOUT_PURPOSE` on the only two routes that create one.
 *
 * A purpose nobody below claims is `unhandled` — never silently fulfilled as a manager plan.
 *
 * The two constants re-exported here are owned by the modules that create those sessions, not
 * re-typed: a rename in either place would otherwise reintroduce exactly the drift this module
 * exists to prevent.
 */
export const MANAGER_CARD_SETUP_PURPOSE = "manager_card_setup";
export const RENTAL_APPLICATION_FEE_PURPOSE = APPLICATION_FEE_CHECKOUT_PURPOSE;
export const HOUSEHOLD_CHARGE_PURPOSE = HOUSEHOLD_CHARGE_CHECKOUT_PURPOSE;

/** Purposes `checkoutOwner` resolves an owning manager for. */
export const OWNER_RESOLVABLE_CHECKOUT_PURPOSES: ReadonlySet<string> = new Set([
  RENTAL_APPLICATION_FEE_PURPOSE,
  LINKED_FORM_FEE_PURPOSE,
  HOUSEHOLD_CHARGE_PURPOSE,
  SCREENING_CHECKOUT_PURPOSE,
  VENDOR_INVOICE_PAY_PURPOSE,
  VENDOR_INVOICE_DIRECT_PAY_PURPOSE,
]);

/**
 * Every purpose the webhook's checkout dispatch chain handles by name — including the two card
 * setups, which have their own explicit no-op branches because Stripe already attached the card and
 * the saved-method lists are read live, and `MANAGER_PLAN_CHECKOUT_PURPOSE`, which the chain matches
 * through `isManagerPlanCheckout`. A purpose outside this set is logged as unhandled and never
 * fulfilled, so membership and a real branch have to stay in step.
 */
export const HANDLED_CHECKOUT_PURPOSES: ReadonlySet<string> = new Set([
  ...OWNER_RESOLVABLE_CHECKOUT_PURPOSES,
  COMMS_CREDIT_PURPOSE,
  COMMS_CREDIT_POOL_PURPOSE,
  NUMBER_SUBSCRIPTION_PURPOSE,
  NUMBER_CREDIT_PURPOSE,
  MANAGER_CARD_SETUP_PURPOSE,
  RESIDENT_CARD_SETUP_PURPOSE,
  MANAGER_PLAN_CHECKOUT_PURPOSE,
]);

export function checkoutPurpose(session: Stripe.Checkout.Session): string {
  return String(session.metadata?.purpose ?? "").trim();
}

/**
 * A manager plan purchase, by the marker its creator stamps.
 *
 * The second arm covers sessions created BEFORE that marker shipped: a purposeless
 * `mode: "subscription"` session carrying the manager-plan `manager_id` reservation key. It is
 * still a positive test on metadata the manager checkout creator wrote — never on absence alone —
 * and it cannot admit the resident card setup session, which is `mode: "setup"` and names no
 * manager. Safe to drop once no pre-release session can still complete (Checkout sessions expire
 * within 24 hours).
 */
export function isManagerPlanCheckout(session: Stripe.Checkout.Session): boolean {
  const purpose = checkoutPurpose(session);
  if (purpose) return purpose === MANAGER_PLAN_CHECKOUT_PURPOSE;
  return session.mode === "subscription" && Boolean(String(session.metadata?.manager_id ?? "").trim());
}

/** A purpose no branch of the dispatch chain claims. */
export function isUnhandledCheckoutPurpose(session: Stripe.Checkout.Session): boolean {
  const purpose = checkoutPurpose(session);
  return !!purpose && !HANDLED_CHECKOUT_PURPOSES.has(purpose);
}

/** Whether the ownership guard can (and must) resolve an owner for this session. */
export function checkoutNeedsOwnerCheck(session: Stripe.Checkout.Session): boolean {
  return isManagerPlanCheckout(session) || OWNER_RESOLVABLE_CHECKOUT_PURPOSES.has(checkoutPurpose(session));
}
