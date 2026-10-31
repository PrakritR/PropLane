import type Stripe from "stripe";
import { COMMS_CREDIT_PURPOSE } from "@/lib/comms-billing/credit-packs";
import { COMMS_CREDIT_POOL_PURPOSE } from "@/lib/comms-billing/pool.server";
import { NUMBER_CREDIT_PURPOSE, NUMBER_SUBSCRIPTION_PURPOSE } from "@/lib/number-subscription/constants";
import { LINKED_FORM_FEE_PURPOSE } from "@/lib/linked-form-fee.server";
import { SCREENING_CHECKOUT_PURPOSE } from "@/lib/stripe-screening";
import { VENDOR_INVOICE_PAY_PURPOSE } from "@/lib/stripe-axis-ach-checkout";
import { VENDOR_INVOICE_DIRECT_PAY_PURPOSE } from "@/lib/vendor-invoice-pay.server";

/**
 * One classification of a Checkout session's `purpose`, shared by the webhook's
 * ownership guard and its dispatch chain so the two can never drift.
 *
 * A manager plan purchase is the ONLY session our routes create without a
 * `purpose`, so it is classified positively by that absence. A purpose nobody
 * below claims is `unhandled` — never silently fulfilled as a manager plan.
 */
export const MANAGER_CARD_SETUP_PURPOSE = "manager_card_setup";
export const RENTAL_APPLICATION_FEE_PURPOSE = "rental_application_fee";
export const HOUSEHOLD_CHARGE_PURPOSE = "household_charge";

/** Purposes `checkoutOwner` resolves an owning manager for. */
export const OWNER_RESOLVABLE_CHECKOUT_PURPOSES: ReadonlySet<string> = new Set([
  RENTAL_APPLICATION_FEE_PURPOSE,
  LINKED_FORM_FEE_PURPOSE,
  HOUSEHOLD_CHARGE_PURPOSE,
  SCREENING_CHECKOUT_PURPOSE,
  VENDOR_INVOICE_PAY_PURPOSE,
  VENDOR_INVOICE_DIRECT_PAY_PURPOSE,
]);

/** Every purpose the webhook's checkout dispatch chain handles by name. */
export const HANDLED_CHECKOUT_PURPOSES: ReadonlySet<string> = new Set([
  ...OWNER_RESOLVABLE_CHECKOUT_PURPOSES,
  COMMS_CREDIT_PURPOSE,
  COMMS_CREDIT_POOL_PURPOSE,
  NUMBER_SUBSCRIPTION_PURPOSE,
  NUMBER_CREDIT_PURPOSE,
  MANAGER_CARD_SETUP_PURPOSE,
]);

export function checkoutPurpose(session: Stripe.Checkout.Session): string {
  return String(session.metadata?.purpose ?? "").trim();
}

/** A manager plan purchase: the one session kind our routes create with no `purpose`. */
export function isManagerPlanCheckout(session: Stripe.Checkout.Session): boolean {
  return !checkoutPurpose(session);
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
