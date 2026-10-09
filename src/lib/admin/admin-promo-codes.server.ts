import "server-only";

import type Stripe from "stripe";
import { z } from "zod";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveStripePriceIdForManagerTier } from "@/lib/stripe/resolve-manager-price";
import {
  ADMIN_PROMO_CODE_PATTERN,
  PROMO_PLAN_IDS,
  isInternalWaiverPromoCode,
  normalizePromoCodeInput,
  type PromoPlanId,
} from "@/lib/stripe-promos";
import { AdminInputError } from "@/lib/admin/admin-input-error";
import { pacificEndOfDayMs } from "@/lib/pacific-time";
import {
  describePromoDiscount,
  type PromoDiscountType,
  type PromoDuration,
} from "@/lib/admin/promo-code-terms";

/**
 * Money > Promo codes (decision D1: Stripe-native).
 *
 * A promo code is a Stripe coupon (the discount) plus a Stripe promotion code (the text a customer
 * types, its redemption cap, expiry and first-time-customer restriction). Nothing is stored in our
 * database: Stripe is the source of truth, Checkout accepts the code on every plan, and the admin
 * list reads both back. "Given" is the sum of the discounts Stripe applied on invoices that used the
 * code.
 */

export type { PromoDiscountType, PromoDuration } from "@/lib/admin/promo-code-terms";

const MAX_FREE_MONTHS = 36;
const MAX_AMOUNT_DOLLARS = 10_000;
const MAX_REDEMPTIONS = 100_000;
const USAGE_LOOKBACK_DAYS = 400;
const USAGE_MAX_INVOICES = 2_000;
const PLAN_PRODUCT_TTL_MS = 5 * 60 * 1000;

const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date.");

export const createPromoCodeSchema = z
  .object({
    code: z.string().transform(normalizePromoCodeInput),
    name: z.string().trim().max(80).default(""),
    discountType: z.enum(["percent", "amount", "free_months"]),
    value: z.number().finite().positive(),
    duration: z.enum(["once", "repeating", "forever"]).default("once"),
    durationMonths: z.number().int().min(1).max(MAX_FREE_MONTHS).nullish(),
    plans: z.array(z.enum(PROMO_PLAN_IDS)).max(PROMO_PLAN_IDS.length).default([]),
    firstTimeOnly: z.boolean().default(false),
    maxRedemptions: z.number().int().min(1).max(MAX_REDEMPTIONS).nullish(),
    expiresOn: dateKey.nullish(),
  })
  .superRefine((input, ctx) => {
    if (!ADMIN_PROMO_CODE_PATTERN.test(input.code)) {
      ctx.addIssue({ code: "custom", path: ["code"], message: "Use 3 to 32 letters, numbers, dashes or underscores." });
    } else if (isInternalWaiverPromoCode(input.code)) {
      ctx.addIssue({ code: "custom", path: ["code"], message: "That code is reserved." });
    }
    if (input.discountType === "percent" && (input.value > 100 || !Number.isInteger(input.value))) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Percent off is a whole number from 1 to 100." });
    }
    if (input.discountType === "amount") {
      if (input.value > MAX_AMOUNT_DOLLARS) {
        ctx.addIssue({ code: "custom", path: ["value"], message: `Amount off is at most $${MAX_AMOUNT_DOLLARS.toLocaleString("en-US")}.` });
      }
      if (Math.round(input.value * 100) < 1) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Amount off is at least one cent." });
      }
    }
    if (input.discountType === "free_months" && (!Number.isInteger(input.value) || input.value > MAX_FREE_MONTHS)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `Free months is a whole number from 1 to ${MAX_FREE_MONTHS}.` });
    }
    if (input.discountType !== "free_months" && input.duration === "repeating" && !input.durationMonths) {
      ctx.addIssue({ code: "custom", path: ["durationMonths"], message: "Say how many months." });
    }
    if (input.expiresOn) {
      const end = expiresAtFromDateKey(input.expiresOn);
      if (end === null || end * 1000 <= Date.now()) {
        ctx.addIssue({ code: "custom", path: ["expiresOn"], message: "Pick a date in the future." });
      }
    }
  });

export type CreatePromoCodeInput = z.infer<typeof createPromoCodeSchema>;

export const setPromoCodeActiveSchema = z.object({
  id: z.string().regex(/^promo_[A-Za-z0-9]{6,64}$/, "Invalid promo code id."),
  active: z.boolean().default(false),
});

/** The last second of the chosen Pacific day, as Stripe's unix `expires_at`. Null for an unusable key. */
export function expiresAtFromDateKey(key: string): number | null {
  const endMs = pacificEndOfDayMs(key);
  return endMs === null ? null : Math.floor(endMs / 1000) - 1;
}

/** The months a "free months" code runs, which are also the months the coupon repeats for. */
function freeMonths(input: Pick<CreatePromoCodeInput, "value">): number {
  return Math.max(1, Math.round(input.value));
}

/** Stripe coupon params for one promo code. Pure, so each discount type is unit tested. */
export function buildPromoCouponParams(
  input: CreatePromoCodeInput,
  productIds: readonly string[],
): Stripe.CouponCreateParams {
  const params: Stripe.CouponCreateParams = {
    name: (input.name || input.code).slice(0, 40),
    metadata: {
      source: "proplane_admin",
      discount_type: input.discountType,
      plans: input.plans.length ? input.plans.join(",") : "all",
    },
  };

  if (input.discountType === "free_months") {
    const months = freeMonths(input);
    params.percent_off = 100;
    params.duration = months === 1 ? "once" : "repeating";
    if (months > 1) params.duration_in_months = months;
  } else {
    if (input.discountType === "percent") {
      params.percent_off = input.value;
    } else {
      params.amount_off = Math.round(input.value * 100);
      params.currency = "usd";
    }
    params.duration = input.duration;
    if (input.duration === "repeating") params.duration_in_months = input.durationMonths ?? 1;
  }

  if (productIds.length > 0) params.applies_to = { products: [...productIds] };
  return params;
}

/** Stripe promotion-code params: the customer-facing code and its limits. */
export function buildPromotionCodeParams(
  input: CreatePromoCodeInput,
  couponId: string,
): Stripe.PromotionCodeCreateParams {
  const expiresAt = input.expiresOn ? expiresAtFromDateKey(input.expiresOn) : null;
  return {
    promotion: { type: "coupon", coupon: couponId },
    code: input.code,
    active: true,
    ...(input.maxRedemptions ? { max_redemptions: input.maxRedemptions } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    ...(input.firstTimeOnly ? { restrictions: { first_time_transaction: true } } : {}),
    metadata: { source: "proplane_admin" },
  };
}

type PlanProductCache = { at: number; products: Partial<Record<PromoPlanId, string>> };
let planProductCache: PlanProductCache | null = null;

/** Clears the plan -> Stripe product cache (tests). */
export function clearPromoPlanProductCache(): void {
  planProductCache = null;
}

async function loadPlanProducts(stripe: Stripe): Promise<Partial<Record<PromoPlanId, string>>> {
  if (planProductCache && Date.now() - planProductCache.at < PLAN_PRODUCT_TTL_MS) return planProductCache.products;
  const products: Partial<Record<PromoPlanId, string>> = {};
  for (const plan of PROMO_PLAN_IDS) {
    try {
      const priceId = await resolveStripePriceIdForManagerTier(plan, "monthly");
      if (!priceId) continue;
      const price = await stripe.prices.retrieve(priceId);
      products[plan] = typeof price.product === "string" ? price.product : price.product.id;
    } catch (error) {
      console.error(`promo plan product lookup failed for ${plan}`, error);
    }
  }
  planProductCache = { at: Date.now(), products };
  return products;
}

/** The Stripe products a code limited to `plans` applies to. An empty selection means every plan. */
export async function resolvePromoProductIds(stripe: Stripe, plans: readonly PromoPlanId[]): Promise<string[]> {
  if (plans.length === 0) return [];
  const products = await loadPlanProducts(stripe);
  const ids: string[] = [];
  for (const plan of plans) {
    const id = products[plan];
    if (!id) throw new AdminInputError(`No Stripe product found for the ${plan} plan.`, 409);
    ids.push(id);
  }
  return ids;
}

function isStripeError(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

export type CreatedPromoCode = { id: string; code: string; couponId: string };

/** Creates the Stripe coupon, then the promotion code on it. A failed second step removes the coupon. */
export async function createPromoCode(
  input: CreatePromoCodeInput,
  deps: { stripe?: Stripe } = {},
): Promise<CreatedPromoCode> {
  const stripe = deps.stripe ?? getStripe();
  const productIds = await resolvePromoProductIds(stripe, input.plans);

  const existing = await stripe.promotionCodes.list({ code: input.code, limit: 1 });
  if (existing.data.some((promo) => promo.code.toUpperCase() === input.code)) {
    throw new AdminInputError("That code already exists in Stripe.", 409);
  }

  const coupon = await stripe.coupons.create(buildPromoCouponParams(input, productIds));
  try {
    const promo = await stripe.promotionCodes.create(buildPromotionCodeParams(input, coupon.id));
    return { id: promo.id, code: promo.code, couponId: coupon.id };
  } catch (error) {
    await stripe.coupons.del(coupon.id).catch((cleanupError: unknown) => {
      console.error("promo coupon cleanup failed", cleanupError);
    });
    if (isStripeError(error, "resource_already_exists")) {
      throw new AdminInputError("That code already exists in Stripe.", 409);
    }
    throw error;
  }
}

/** Turns a promotion code off (or back on). Existing subscriptions keep the discount they already have. */
export async function setPromoCodeActive(
  id: string,
  active: boolean,
  deps: { stripe?: Stripe } = {},
): Promise<{ id: string; active: boolean }> {
  const stripe = deps.stripe ?? getStripe();
  try {
    const promo = await stripe.promotionCodes.update(id, { active });
    return { id: promo.id, active: promo.active };
  } catch (error) {
    if (isStripeError(error, "resource_missing")) throw new AdminInputError("That promo code no longer exists.", 404);
    // Stripe refuses to re-activate a code whose coupon is spent or expired.
    if (active) throw new AdminInputError("Stripe will not turn that code back on.", 409);
    throw error;
  }
}

export type PromoRedemption = {
  customerId: string;
  email: string | null;
  name: string | null;
  /** Manager account behind the Stripe customer, when we can tell. */
  userId: string | null;
  /** ISO time of the first invoice that used the code. */
  firstAt: string;
  invoices: number;
  givenCents: number;
};

export type PromoUsage = { givenCents: number; redemptions: PromoRedemption[] };

function customerIdOf(customer: Stripe.Invoice["customer"]): string | null {
  if (!customer) return null;
  return typeof customer === "string" ? customer : customer.id;
}

function promotionCodeIdOf(discount: Stripe.Discount | Stripe.DeletedDiscount | string): string | null {
  if (typeof discount === "string" || !("promotion_code" in discount)) return null;
  const promo = discount.promotion_code;
  if (!promo) return null;
  return typeof promo === "string" ? promo : promo.id;
}

/** Folds invoices into a per-promotion-code usage map. Pure over the invoice list. */
export function summarizePromoUsage(invoices: readonly Stripe.Invoice[]): Map<string, PromoUsage> {
  const usage = new Map<string, PromoUsage>();
  const byCustomer = new Map<string, PromoRedemption>();

  for (const invoice of invoices) {
    if (invoice.status === "draft" || invoice.status === "void") continue;
    const customerId = customerIdOf(invoice.customer);
    for (const line of invoice.total_discount_amounts ?? []) {
      const promoId = promotionCodeIdOf(line.discount);
      if (!promoId) continue;
      const entry = usage.get(promoId) ?? { givenCents: 0, redemptions: [] };
      entry.givenCents += line.amount;
      usage.set(promoId, entry);

      const key = `${promoId}:${customerId ?? invoice.id}`;
      const at = new Date(invoice.created * 1000).toISOString();
      const existing = byCustomer.get(key);
      if (existing) {
        existing.invoices += 1;
        existing.givenCents += line.amount;
        if (at < existing.firstAt) existing.firstAt = at;
      } else {
        const redemption: PromoRedemption = {
          customerId: customerId ?? "",
          email: invoice.customer_email ?? null,
          name: invoice.customer_name ?? null,
          userId: null,
          firstAt: at,
          invoices: 1,
          givenCents: line.amount,
        };
        byCustomer.set(key, redemption);
        entry.redemptions.push(redemption);
      }
    }
  }
  for (const entry of usage.values()) entry.redemptions.sort((a, b) => b.firstAt.localeCompare(a.firstAt));
  return usage;
}

async function loadInvoicesWithDiscounts(stripe: Stripe): Promise<Stripe.Invoice[]> {
  const since = Math.floor(Date.now() / 1000) - USAGE_LOOKBACK_DAYS * 24 * 60 * 60;
  return stripe.invoices
    .list({ created: { gte: since }, limit: 100, expand: ["data.total_discount_amounts.discount"] })
    .autoPagingToArray({ limit: USAGE_MAX_INVOICES });
}

/** Attach each redemption's manager account (by Stripe customer id) so the record page can link to it. */
async function attachAccounts(
  usage: Map<string, PromoUsage>,
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
): Promise<void> {
  const customerIds = new Set<string>();
  for (const entry of usage.values()) for (const r of entry.redemptions) if (r.customerId) customerIds.add(r.customerId);
  if (customerIds.size === 0) return;
  const ids = [...customerIds];

  const owners = new Map<string, { userId: string; email: string | null; name: string | null }>();
  const [purchases, billing] = await Promise.all([
    db.from("manager_purchases").select("user_id, email, full_name, stripe_customer_id").in("stripe_customer_id", ids),
    db.from("manager_comms_billing_accounts").select("manager_user_id, stripe_customer_id").in("stripe_customer_id", ids),
  ]);
  for (const row of (purchases.data ?? []) as Array<{ user_id: string | null; email: string | null; full_name: string | null; stripe_customer_id: string | null }>) {
    if (row.user_id && row.stripe_customer_id) {
      owners.set(row.stripe_customer_id, { userId: row.user_id, email: row.email, name: row.full_name });
    }
  }
  for (const row of (billing.data ?? []) as Array<{ manager_user_id: string | null; stripe_customer_id: string | null }>) {
    if (row.manager_user_id && row.stripe_customer_id && !owners.has(row.stripe_customer_id)) {
      owners.set(row.stripe_customer_id, { userId: row.manager_user_id, email: null, name: null });
    }
  }
  for (const entry of usage.values()) {
    for (const r of entry.redemptions) {
      const owner = owners.get(r.customerId);
      if (!owner) continue;
      r.userId = owner.userId;
      r.email = r.email ?? owner.email;
      r.name = r.name ?? owner.name;
    }
  }
}

export type PromoStatus = "active" | "expired" | "inactive";

export type AdminPromoCode = {
  id: string;
  code: string;
  name: string;
  status: PromoStatus;
  /** "1 month free", "20% off for 3 months". */
  summary: string;
  discountType: PromoDiscountType;
  value: number;
  duration: PromoDuration;
  durationMonths: number | null;
  /** Plans the code is limited to; empty means every plan. */
  plans: PromoPlanId[];
  firstTimeOnly: boolean;
  timesRedeemed: number;
  maxRedemptions: number | null;
  expiresAt: string | null;
  createdAt: string;
  givenCents: number;
  /** Set only on the record view. */
  redemptions?: PromoRedemption[];
};

function couponOf(promo: Stripe.PromotionCode): Stripe.Coupon | null {
  const coupon = promo.promotion?.coupon;
  return coupon && typeof coupon !== "string" ? coupon : null;
}

function plansOfCoupon(coupon: Stripe.Coupon | null, products: Partial<Record<PromoPlanId, string>>): PromoPlanId[] {
  if (!coupon) return [];
  const fromMeta = coupon.metadata?.plans;
  if (fromMeta) {
    if (fromMeta === "all") return [];
    return fromMeta.split(",").filter((p): p is PromoPlanId => (PROMO_PLAN_IDS as readonly string[]).includes(p));
  }
  const applies = coupon.applies_to?.products ?? [];
  if (applies.length === 0) return [];
  return PROMO_PLAN_IDS.filter((plan) => products[plan] && applies.includes(products[plan]!));
}

/** Projects a Stripe promotion code (coupon expanded) to the admin row. Pure. */
export function projectPromoCode(
  promo: Stripe.PromotionCode,
  usage: PromoUsage | undefined,
  products: Partial<Record<PromoPlanId, string>>,
  now: number = Date.now(),
): AdminPromoCode {
  const coupon = couponOf(promo);
  const percentOff = coupon?.percent_off ?? null;
  const amountOff = coupon?.amount_off ?? null;
  const duration = (coupon?.duration ?? "once") as PromoDuration;
  const months = coupon?.duration_in_months ?? null;

  let discountType: PromoDiscountType;
  let value: number;
  if (percentOff === 100 && duration !== "forever") {
    discountType = "free_months";
    value = duration === "once" ? 1 : months ?? 1;
  } else if (percentOff !== null) {
    discountType = "percent";
    value = percentOff;
  } else {
    discountType = "amount";
    value = (amountOff ?? 0) / 100;
  }

  const expiresMs = promo.expires_at ? promo.expires_at * 1000 : null;
  const spent = promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions;
  const status: PromoStatus =
    (expiresMs !== null && expiresMs <= now) || spent || coupon?.valid === false
      ? "expired"
      : promo.active
        ? "active"
        : "inactive";

  return {
    id: promo.id,
    code: promo.code,
    name: coupon?.name ?? promo.code,
    status,
    summary: describePromoDiscount({ discountType, value, duration, durationMonths: months }),
    discountType,
    value,
    duration,
    durationMonths: months,
    plans: plansOfCoupon(coupon, products),
    firstTimeOnly: Boolean(promo.restrictions?.first_time_transaction),
    timesRedeemed: promo.times_redeemed,
    maxRedemptions: promo.max_redemptions,
    expiresAt: expiresMs ? new Date(expiresMs).toISOString() : null,
    createdAt: new Date(promo.created * 1000).toISOString(),
    givenCents: usage?.givenCents ?? 0,
  };
}

export type AdminPromoCodeList = { codes: AdminPromoCode[]; counts: Record<PromoStatus, number> };

/** Every promotion code with its usage. Usage is best-effort: a failed invoice read shows 0 given. */
export async function listPromoCodes(
  deps: { stripe?: Stripe; db?: ReturnType<typeof createSupabaseServiceRoleClient> } = {},
): Promise<AdminPromoCodeList> {
  const stripe = deps.stripe ?? getStripe();
  const promos = await stripe.promotionCodes
    .list({ limit: 100, expand: ["data.promotion.coupon"] })
    .autoPagingToArray({ limit: 500 });
  const products = await loadPlanProducts(stripe);

  let usage = new Map<string, PromoUsage>();
  try {
    usage = summarizePromoUsage(await loadInvoicesWithDiscounts(stripe));
  } catch (error) {
    console.error("promo usage read failed", error);
  }

  const codes = promos
    .map((promo) => projectPromoCode(promo, usage.get(promo.id), products))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const counts: Record<PromoStatus, number> = { active: 0, expired: 0, inactive: 0 };
  for (const code of codes) counts[code.status] += 1;
  return { codes, counts };
}

/** One code with its redemptions (accounts and dates). Null when the id is unknown. */
export async function getPromoCodeRecord(
  id: string,
  deps: { stripe?: Stripe; db?: ReturnType<typeof createSupabaseServiceRoleClient> } = {},
): Promise<AdminPromoCode | null> {
  const stripe = deps.stripe ?? getStripe();
  let promo: Stripe.PromotionCode;
  try {
    promo = await stripe.promotionCodes.retrieve(id, { expand: ["promotion.coupon"] });
  } catch (error) {
    if (isStripeError(error, "resource_missing")) return null;
    throw error;
  }
  const products = await loadPlanProducts(stripe);
  // Usage is best-effort here exactly as it is in `listPromoCodes`: one transient invoice-read
  // failure must not make the list render zeroes while opening a single code 500s.
  let usage = new Map<string, PromoUsage>();
  try {
    usage = summarizePromoUsage(await loadInvoicesWithDiscounts(stripe));
    await attachAccounts(usage, deps.db ?? createSupabaseServiceRoleClient());
  } catch (error) {
    console.error("promo usage read failed", error);
  }
  const entry = usage.get(promo.id);
  return { ...projectPromoCode(promo, entry, products), redemptions: entry?.redemptions ?? [] };
}
