import "server-only";

import type Stripe from "stripe";
import { getStripe } from "@/lib/stripe";
import { normalizePromoCodeInput } from "@/lib/stripe-promos";

type AppliedDiscount = { promotion_code?: string | { code?: string | null } | null };

/**
 * The promotion code a completed Checkout session redeemed, as the text the customer typed
 * (uppercase), or null when it redeemed none.
 *
 * `manager_purchases.stripe_promotion_code` (never `promo_code`, the waiver column) is what the admin Subscribers and Promo codes pages read to say
 * "this account came in on FREEFIRST". The pricing form already stamps `metadata.promo` for a code
 * typed there; a code typed into Stripe's own "Add promotion code" field never reaches our metadata,
 * so it is read from the session's discounts instead. A lookup failure never blocks fulfillment: the
 * purchase is recorded without the code rather than not at all.
 */
export async function resolveCheckoutSessionPromoCode(
  session: Stripe.Checkout.Session,
  stripe: Pick<Stripe, "checkout" | "promotionCodes"> = getStripe(),
): Promise<string | null> {
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
      if (normalized) return normalized;
    }
  } catch (error) {
    console.error("resolveCheckoutSessionPromoCode failed", error);
  }
  return null;
}
