import { getStripe } from "@/lib/stripe";
import type Stripe from "stripe";
import { RATE_CARD } from "@/lib/billing/rate-card";
import type { ManagerSubscriptionTier, PaidTier, StripeBilling } from "@/lib/stripe-price-ids";

const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { priceId: string; expiresAt: number };

const priceCache = new Map<string, CacheEntry>();

function cacheKey(tier: ManagerSubscriptionTier, billing: StripeBilling): string {
  return `${tier}:${billing}`;
}

function isStripePriceId(value: string | undefined): value is string {
  return Boolean(value?.trim().startsWith("price_"));
}

function envPriceId(tier: ManagerSubscriptionTier, billing: StripeBilling): string | undefined {
  if (tier === "free") {
    return process.env.STRIPE_PRICE_FREE_MONTHLY;
  }
  if (tier === "pro") {
    return billing === "annual" ? process.env.STRIPE_PRICE_PRO_ANNUAL : process.env.STRIPE_PRICE_PRO_MONTHLY;
  }
  return billing === "annual" ? process.env.STRIPE_PRICE_BUSINESS_ANNUAL : process.env.STRIPE_PRICE_BUSINESS_MONTHLY;
}

function lookupKeyFor(tier: ManagerSubscriptionTier, billing: StripeBilling): string {
  if (tier === "free") return "axis_manager_free_monthly";
  return `axis_manager_${tier}_${billing}`;
}

function productKeyFor(tier: ManagerSubscriptionTier): string {
  if (tier === "free") return "axis_free";
  return tier === "pro" ? "axis_pro" : "axis_business";
}

function stripeInterval(billing: StripeBilling): "month" | "year" {
  return billing === "annual" ? "year" : "month";
}

/** Historical subscriptions may carry a Price ID no longer present in env.
 * Read its real cadence and product rather than guessing monthly. This does
 * not reprice the existing subscription. */
export async function readManagerSubscriptionPriceContext(
  stripe: Stripe,
  priceId: string,
): Promise<{ tier: PaidTier; billing: StripeBilling }> {
  const price = await stripe.prices.retrieve(priceId);
  const interval = price.recurring?.interval;
  if (price.type !== "recurring" || price.recurring?.interval_count !== 1 ||
      (interval !== "month" && interval !== "year")) {
    throw new Error("Current subscription price has an unsupported billing cadence.");
  }
  const product = typeof price.product === "string"
    ? await stripe.products.retrieve(price.product)
    : price.product;
  const key = "metadata" in product ? product.metadata?.axis_plan : null;
  if (key !== "axis_pro" && key !== "axis_business") {
    throw new Error("Current subscription price does not identify a PropLane paid plan.");
  }
  return { tier: key === "axis_pro" ? "pro" : "business", billing: interval === "year" ? "annual" : "monthly" };
}

/** A configured Stripe ID is only a pointer. Read the actual charge terms
 * before any Checkout or subscription mutation can use it. */
export async function assertManagerPriceMatchesRateCard(
  stripe: Stripe,
  priceId: string,
  tier: ManagerSubscriptionTier,
  billing: StripeBilling,
): Promise<void> {
  const price = await stripe.prices.retrieve(priceId);
  const expected = tier === "free" || billing === "monthly"
    ? RATE_CARD[tier].floorMonthlyCents : RATE_CARD[tier].floorAnnualCents;
  const interval = tier === "free" ? "month" : stripeInterval(billing);
  if (!price.active || price.currency !== "usd" || price.type !== "recurring" ||
      price.unit_amount !== expected || price.recurring?.interval !== interval ||
      price.recurring.interval_count !== 1) {
    throw new Error(`Stripe price for ${tier} ${billing} does not match the PropLane rate card.`);
  }
  const product = typeof price.product === "string"
    ? await stripe.products.retrieve(price.product)
    : price.product;
  if ("deleted" in product && product.deleted ||
      !("metadata" in product) || product.metadata?.axis_plan !== productKeyFor(tier)) {
    throw new Error(`Stripe price for ${tier} ${billing} belongs to the wrong product.`);
  }
}

/**
 * Resolves a Stripe Price id for manager plans (Free, Pro, Business).
 * Priority: valid env `price_…` override → Stripe lookup_key → product metadata `axis_plan`.
 */
export async function resolveStripePriceIdForManagerTier(
  tier: ManagerSubscriptionTier,
  billing: StripeBilling,
): Promise<string | null> {
  const effectiveBilling = tier === "free" ? "monthly" : billing;
  const key = cacheKey(tier, effectiveBilling);
  const cached = priceCache.get(key);
  const stripe = getStripe();
  if (cached && cached.expiresAt > Date.now()) {
    await assertManagerPriceMatchesRateCard(stripe, cached.priceId, tier, effectiveBilling);
    return cached.priceId;
  }

  const fromEnv = envPriceId(tier, effectiveBilling)?.trim();
  if (isStripePriceId(fromEnv)) {
    await assertManagerPriceMatchesRateCard(stripe, fromEnv, tier, effectiveBilling);
    priceCache.set(key, { priceId: fromEnv, expiresAt: Date.now() + CACHE_TTL_MS });
    return fromEnv;
  }

  const lookupKey = lookupKeyFor(tier, effectiveBilling);

  try {
    const prices = await stripe.prices.list({ lookup_keys: [lookupKey], limit: 1, active: true });
    const byLookup = prices.data[0];
    if (byLookup?.id) {
      await assertManagerPriceMatchesRateCard(stripe, byLookup.id, tier, effectiveBilling);
      priceCache.set(key, { priceId: byLookup.id, expiresAt: Date.now() + CACHE_TTL_MS });
      return byLookup.id;
    }
  } catch {
    /* fall through to product metadata scan */
  }

  const listed = await stripe.products.list({ limit: 100, active: true });
  const product = listed.data.find((p) => p.metadata?.axis_plan === productKeyFor(tier));
  if (!product) return null;

  const interval = stripeInterval(effectiveBilling);
  const priceList = await stripe.prices.list({ product: product.id, limit: 100, active: true });
  const match = priceList.data.find((p) => {
    if (p.type !== "recurring") return false;
    if (tier === "free") return p.unit_amount === RATE_CARD.free.floorMonthlyCents && p.recurring?.interval === "month";
    return p.unit_amount === (effectiveBilling === "annual" ? RATE_CARD[tier].floorAnnualCents : RATE_CARD[tier].floorMonthlyCents) && p.recurring?.interval === interval;
  });
  if (!match?.id) return null;
  await assertManagerPriceMatchesRateCard(stripe, match.id, tier, effectiveBilling);

  priceCache.set(key, { priceId: match.id, expiresAt: Date.now() + CACHE_TTL_MS });
  return match.id;
}

/** @deprecated Use resolveStripePriceIdForManagerTier */
export async function resolveStripePriceIdForPaidTier(
  tier: PaidTier,
  billing: StripeBilling,
): Promise<string | null> {
  return resolveStripePriceIdForManagerTier(tier, billing);
}

/** Clears in-memory cache (tests). */
export function clearManagerPriceCache(): void {
  priceCache.clear();
}
