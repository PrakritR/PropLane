/** Customer-facing Stripe promotion code: first month free, Pro monthly only (see SUPABASE_STRIPE_SETUP.md). */
export const PRO_MONTHLY_FIRST_FREE_PROMO_CODE = "FREEFIRST";

/** Legacy / alternate spellings accepted in the pricing form (normalized to FREEFIRST for validation). */
export const PRO_MONTHLY_FIRST_FREE_PROMO_ALIASES = ["FIRSTFREE", "FREEFIRST", "FIRSTFEE"] as const;

export function normalizeProMonthlyPromoInput(raw: unknown): string {
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw : String(raw);
  const t = s.trim();
  if (!t) return "";
  const u = t.toUpperCase();
  if (PRO_MONTHLY_FIRST_FREE_PROMO_ALIASES.includes(u as (typeof PRO_MONTHLY_FIRST_FREE_PROMO_ALIASES)[number])) {
    return PRO_MONTHLY_FIRST_FREE_PROMO_CODE;
  }
  return t;
}

/*
 * Admin-created promo codes (Money > Promo codes). Each is a Stripe coupon plus a Stripe
 * promotion code, redeemed at Checkout on any plan through `allow_promotion_codes`.
 */

/** A code is 3-32 characters of A-Z, 0-9, dash or underscore, always stored uppercase. */
export const ADMIN_PROMO_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

/**
 * Internal waiver codes that grant payment/processing coverage (`processing-coverage-codes.server.ts`,
 * `server-env.ts`). They are not Stripe promotion codes, and an admin must never mint a Stripe code with
 * the same text: a recorded `manager_purchases.promo_code` of that text reads as a waiver. Listed here
 * (not imported) because this module is bundled for the browser and the coverage list is server-only;
 * the unit test pins these literals to the server constants.
 */
export const INTERNAL_WAIVER_PROMO_CODES: readonly string[] = ["FREE100", "WAIVEPROCESS1"];

export function normalizePromoCodeInput(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

export function isInternalWaiverPromoCode(raw: unknown): boolean {
  return INTERNAL_WAIVER_PROMO_CODES.includes(normalizePromoCodeInput(raw));
}

/**
 * The plans a promo code can be limited to. Stripe limits a coupon by product, and a plan's monthly and
 * annual prices share one product, so the choice is Pro, Business, or every plan (an empty list).
 */
export const PROMO_PLAN_IDS = ["pro", "business"] as const;
export type PromoPlanId = (typeof PROMO_PLAN_IDS)[number];

export const PROMO_PLAN_LABELS: Record<PromoPlanId, string> = {
  pro: "Pro",
  business: "Business",
};
