/**
 * Stripe.js, loaded on first use.
 *
 * `@stripe/stripe-js` injects js.stripe.com the moment it is imported, and a
 * module-scope `loadStripe()` runs on import, so any page whose bundle merely
 * contained a Stripe sheet paid for the script. The `/pure` entry does not
 * inject on import; `getStripe()` loads once per publishable key, when a sheet
 * or modal actually mounts or submits.
 */
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe } from "@stripe/stripe-js";

const cache = new Map<string, Promise<Stripe | null>>();

/** The publishable key every Stripe surface uses unless it is handed one. */
export function defaultStripePublishableKey(): string {
  return process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? "";
}

export function getStripe(publishableKey: string = defaultStripePublishableKey()): Promise<Stripe | null> {
  let pending = cache.get(publishableKey);
  if (!pending) {
    pending = loadStripe(publishableKey);
    cache.set(publishableKey, pending);
  }
  return pending;
}
