import "server-only";

import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { normalizePromoCodeInput } from "@/lib/stripe-promos";

type AppliedDiscount = { promotion_code?: string | { code?: string | null } | null };

/** `resolved: false` means Stripe could not be asked — distinct from "this session redeemed no code". */
export type CheckoutPromoCodeResult = { resolved: boolean; code: string | null };

/**
 * The promotion code a completed Checkout session redeemed, as the text the customer typed
 * (uppercase), or null when it redeemed none.
 *
 * `manager_purchases.stripe_promotion_code` (never `promo_code`, the waiver column) is what the admin
 * Subscribers and Promo codes pages read to say "this account came in on FREEFIRST". Only a discount
 * Stripe actually APPLIED counts: a code typed on the pricing form that Stripe never accepted
 * (`metadata.promo`) is deliberately not read here. A lookup failure never blocks fulfillment — the
 * purchase is recorded without the code rather than not at all — and `resolved: false` lets the
 * caller leave a code it recorded earlier alone instead of overwriting it with null.
 */
export async function resolveCheckoutSessionPromoCodeResult(
  session: Stripe.Checkout.Session,
  stripe: Pick<Stripe, "checkout" | "promotionCodes"> = getStripe(),
): Promise<CheckoutPromoCodeResult> {
  try {
    let discounts: AppliedDiscount[] | null | undefined = session.discounts as AppliedDiscount[] | null | undefined;
    if (discounts === undefined) {
      const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ["discounts.promotion_code"] });
      discounts = full.discounts as AppliedDiscount[] | null | undefined;
    }
    const breakdown = (session.total_details?.breakdown?.discounts ?? []).map(
      (entry) => entry.discount as AppliedDiscount,
    );
    for (const discount of [...(discounts ?? []), ...breakdown]) {
      const promotion = discount?.promotion_code;
      if (!promotion) continue;
      const code =
        typeof promotion === "string" ? (await stripe.promotionCodes.retrieve(promotion)).code : promotion.code ?? "";
      const normalized = normalizePromoCodeInput(code);
      if (normalized) return { resolved: true, code: normalized };
    }
  } catch (error) {
    console.error("resolveCheckoutSessionPromoCode failed", error);
    return { resolved: false, code: null };
  }
  return { resolved: true, code: null };
}

/** The applied code, or null both when none was applied and when Stripe could not be asked. */
export async function resolveCheckoutSessionPromoCode(
  session: Stripe.Checkout.Session,
  stripe: Pick<Stripe, "checkout" | "promotionCodes"> = getStripe(),
): Promise<string | null> {
  return (await resolveCheckoutSessionPromoCodeResult(session, stripe)).code;
}
