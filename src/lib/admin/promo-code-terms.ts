/**
 * Client-safe description of a promo code's terms, shared by the New promo code wizard's live preview,
 * the list rows and the record page, so all three say the same sentence about the same code.
 */
import { PROMO_PLAN_LABELS, type PromoPlanId } from "@/lib/stripe-promos";

export type PromoDiscountType = "percent" | "amount" | "free_months";
export type PromoDuration = "once" | "repeating" | "forever";

/**
 * What a row is. Only `stripe_promo_code` is a Stripe Checkout code; the rest are other ways an account
 * got paid access or a discount, listed so every code in use is on one page. A waiver is the
 * `manager_purchases.promo_code` column and a Checkout code is `stripe_promotion_code`: never conflated.
 */
export type PromoKind = "stripe_promo_code" | "stripe_coupon" | "waiver" | "fee_waiver" | "staff_grant";

export const PROMO_KIND_LABEL: Record<PromoKind, string> = {
  stripe_promo_code: "Stripe promo code",
  stripe_coupon: "Stripe coupon",
  waiver: "Sign-up waiver",
  fee_waiver: "Fee waiver",
  staff_grant: "Staff grant",
};


export type PromoTermsInput = {
  discountType: PromoDiscountType;
  /** Percent (1-100), dollars, or a number of months, by `discountType`. */
  value: number;
  duration: PromoDuration;
  durationMonths?: number | null;
};

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

function usd(dollars: number): string {
  const whole = Number.isInteger(dollars);
  return `$${dollars.toLocaleString("en-US", { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function describePromoDuration(duration: PromoDuration, months?: number | null): string {
  if (duration === "forever") return "forever";
  if (duration === "repeating") return `for ${plural(Math.max(1, Math.round(months ?? 1)), "month")}`;
  return "once";
}

/** "1 month free", "20% off for 3 months", "$25 off once", "$10 off forever". */
export function describePromoDiscount(terms: PromoTermsInput): string {
  if (terms.discountType === "free_months") return `${plural(Math.max(1, Math.round(terms.value)), "month")} free`;
  const amount = terms.discountType === "percent" ? `${terms.value}% off` : `${usd(terms.value)} off`;
  return `${amount} ${describePromoDuration(terms.duration, terms.durationMonths)}`;
}

export function describePromoPlans(plans: readonly PromoPlanId[]): string {
  if (plans.length === 0) return "every plan";
  return plans.map((plan) => PROMO_PLAN_LABELS[plan]).join(" and ");
}

export function formatPromoDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "FREEFIRST: 1 month free on Pro, 50 uses, expires Dec 31, 2026". */
export function describePromoReview(input: PromoTermsInput & {
  code: string;
  plans: readonly PromoPlanId[];
  maxRedemptions?: number | null;
  expiresOn?: string | null;
}): string {
  const parts = [`${input.code || "CODE"}: ${describePromoDiscount(input)} on ${describePromoPlans(input.plans)}`];
  if (input.maxRedemptions) parts.push(plural(input.maxRedemptions, "use"));
  const expires = formatPromoDate(input.expiresOn ? `${input.expiresOn}T00:00:00Z` : null);
  if (expires) parts.push(`expires ${expires}`);
  return parts.join(", ");
}
