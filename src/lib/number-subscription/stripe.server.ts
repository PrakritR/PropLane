import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertTestWorkspaceProviderEffectAllowed } from "@/lib/test-workspaces/effects.server";
import {
  NUMBER_SUBSCRIPTION_LOOKUP_KEY,
  NUMBER_SUBSCRIPTION_PRICE_CENTS,
  NUMBER_SUBSCRIPTION_PRODUCT_NAME,
  type NumberOwnerRole,
} from "./constants";

let cachedPriceId: string | null = null;

/** Test hook: the per-process cache must not leak between cases. */
export function resetNumberPriceCacheForTests() {
  cachedPriceId = null;
}

function isAlreadyExists(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "resource_already_exists";
}

/** A Price we found under our lookup key must be exactly $5.00 USD monthly, or we refuse to sell it. */
function assertPriceShape(price: Stripe.Price): void {
  if (
    price.unit_amount !== NUMBER_SUBSCRIPTION_PRICE_CENTS ||
    price.currency !== "usd" ||
    price.recurring?.interval !== "month" ||
    (price.recurring?.interval_count ?? 1) !== 1 ||
    price.type !== "recurring"
  ) {
    throw new Error("The PropLane Number price in Stripe does not match $5.00/month.");
  }
}

/**
 * The Stripe Price id for the $5/month PropLane Number, created lazily and idempotently exactly like
 * `ensureAddonPrice`: an existing Price under `proplane_number_monthly` first, else a fixed-id Product
 * plus a Price carrying that lookup key. Safe across processes (a lost race re-reads the winner).
 */
export async function ensureNumberSubscriptionPrice(stripe: Pick<Stripe, "prices" | "products">): Promise<string> {
  if (cachedPriceId) return cachedPriceId;
  const find = async () =>
    (await stripe.prices.list({ lookup_keys: [NUMBER_SUBSCRIPTION_LOOKUP_KEY], active: true, limit: 1 })).data[0] ?? null;

  const existing = await find();
  if (existing) {
    assertPriceShape(existing);
    cachedPriceId = existing.id;
    return existing.id;
  }
  let productId: string = NUMBER_SUBSCRIPTION_LOOKUP_KEY;
  try {
    const product = await stripe.products.create({
      id: NUMBER_SUBSCRIPTION_LOOKUP_KEY,
      name: NUMBER_SUBSCRIPTION_PRODUCT_NAME,
      metadata: { proplane_product: "number" },
    });
    productId = product.id;
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
  }
  try {
    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: NUMBER_SUBSCRIPTION_PRICE_CENTS,
      recurring: { interval: "month" },
      product: productId,
      lookup_key: NUMBER_SUBSCRIPTION_LOOKUP_KEY,
      nickname: NUMBER_SUBSCRIPTION_PRODUCT_NAME,
    });
    cachedPriceId = price.id;
    return price.id;
  } catch (err) {
    if (isAlreadyExists(err)) {
      const raced = await find();
      if (raced) {
        assertPriceShape(raced);
        cachedPriceId = raced.id;
        return raced.id;
      }
    }
    throw err;
  }
}

/**
 * The owner's Stripe Customer, shared with the resident one: `profiles.stripe_customer_id`. Resolved
 * from the authenticated user's own profile row, never from the request. A concurrent first call
 * writes only into a still-empty column, then re-reads the winner.
 */
export async function ensureNumberOwnerStripeCustomerId(
  stripe: Pick<Stripe, "customers">,
  db: SupabaseClient,
  userId: string,
  email: string,
  role: NumberOwnerRole,
): Promise<string> {
  await assertTestWorkspaceProviderEffectAllowed({
    userId,
    kind: "payment",
    summary: "Stripe customer setup refused for a test workspace.",
    db,
  });
  const { data: profile, error } = await db
    .from("profiles")
    .select("stripe_customer_id, full_name")
    .eq("id", userId)
    .maybeSingle();
  if (error) throw new Error("Your billing account could not be loaded.");
  const existing = profile?.stripe_customer_id?.trim();
  if (existing) return existing;

  const customer = await stripe.customers.create(
    {
      email: email.trim().toLowerCase() || undefined,
      name: profile?.full_name?.trim() || undefined,
      metadata: { axis_portal: role, axis_user_id: userId },
    },
    { idempotencyKey: `number-customer:${userId}` },
  );
  const { error: updateError } = await db
    .from("profiles")
    .update({ stripe_customer_id: customer.id, updated_at: new Date().toISOString() })
    .eq("id", userId)
    .is("stripe_customer_id", null);
  if (updateError) throw new Error("Your billing account could not be saved.");
  const { data: reread } = await db.from("profiles").select("stripe_customer_id").eq("id", userId).maybeSingle();
  return reread?.stripe_customer_id?.trim() || customer.id;
}
