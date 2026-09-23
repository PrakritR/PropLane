import "server-only";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RATE_CARD, RATE_CARD_VERSION, type RateCardTier } from "@/lib/billing/rate-card";
import { loadManagerDoorCount } from "@/lib/billing/door-count.server";
import type { PaidTier } from "@/lib/stripe-price-ids";
import { META_RATE_CARD_VERSION } from "@/lib/stripe-subscription-metadata";

/**
 * Per-door billing, step 3: the ONE path that changes a Stripe subscription's
 * door-overage quantity (PLAN-0921/PLAN-0922).
 *
 * The subscription shape this assumes: one item for the tier's floor price
 * (already created by checkout / `update-tier`, unchanged by this file), plus
 * ONE item for the tier's per-extra-door price whose `quantity` is doors above
 * the tier's included allowance (`RATE_CARD[tier].includedDoors`). That second
 * item is found by its Price's stable `lookup_key`
 * (`doorOverageLookupKey`) — the exact idempotent pattern
 * `plan-addons.server.ts`'s `ensureAddonPrice` already uses for add-on prices
 * (env override -> existing Price by lookup_key -> create Product + Price) —
 * reused here rather than inventing a second mechanism, so there is never a
 * need to store a subscription-item id in our own database to find it again.
 *
 * `syncManagerDoorQuantity` NEVER changes the floor item, the tier, or any
 * plan/entitlement field — it only ever writes `items: [{ ...single door item
 * change... }]` to Stripe. Adding a room is a quantity change, not a plan
 * change: routing it through plan-change code would re-evaluate entitlements
 * on every room a manager adds, which is the documented failure mode this
 * file exists to avoid. A tier change (which DOES move the included
 * allowance) still goes through this same function — callers just pass the
 * new tier — but the Stripe write this function issues still only ever
 * touches the door-overage item, never the floor item's price.
 */

const doorOveragePriceCache = new Map<PaidTier, string>();

/** Doors billable above a tier's included allowance. Free is a hard cap (no overage rate), so it is always 0. */
export function doorOverageQuantity(tier: RateCardTier, doors: number): number {
  if (tier === "free") return 0;
  const included = RATE_CARD[tier].includedDoors;
  const normalizedDoors = Number.isFinite(doors) && doors > 0 ? Math.floor(doors) : 0;
  return Math.max(0, normalizedDoors - included);
}

export type DoorOverageResolution =
  | { ok: true; doors: number; quantity: number }
  | { ok: false; error: string };

/**
 * Resolves the LIVE door count for `managerUserId` and the overage quantity it
 * implies for `tier`. A failed read is a RESULT, never a silent zero — the
 * caller must fail closed rather than defaulting quantity to 0 (which would
 * silently undercharge) or to the account total (which would silently
 * overcharge and skip the included allowance).
 */
export async function resolveManagerDoorOverage(
  db: SupabaseClient,
  managerUserId: string,
  tier: RateCardTier,
): Promise<DoorOverageResolution> {
  const counted = await loadManagerDoorCount(db, managerUserId);
  if (!counted.ok) return { ok: false, error: counted.error };
  return { ok: true, doors: counted.totalDoors, quantity: doorOverageQuantity(tier, counted.totalDoors) };
}

/**
 * The stable `lookup_key` an auto-created per-door overage Price (and its
 * Product, given the same value as an explicit id) is filed under — same
 * idempotency role as `planAddonLookupKey` in `plan-addons.ts`. Never change
 * the format without a migration: it is how an existing Price, and the
 * subscription item that references it, are found again.
 */
export function doorOverageLookupKey(tier: PaidTier): string {
  return `proplane_door_overage_${tier}`;
}

function doorOverageEnvPriceId(tier: PaidTier): string | undefined {
  const raw = process.env[`STRIPE_PRICE_DOOR_OVERAGE_${tier.toUpperCase()}`]?.trim();
  return raw?.startsWith("price_") ? raw : undefined;
}

function isStripeAlreadyExistsError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: string }).code) : "";
  return code === "resource_already_exists";
}

/** The Product an auto-created door-overage Price attaches to; its id IS the lookup key (Stripe's own idempotency key for this). */
async function ensureDoorOverageProduct(
  stripe: Pick<Stripe, "products">,
  lookupKey: string,
  tier: PaidTier,
): Promise<string> {
  try {
    const created = await stripe.products.create({
      id: lookupKey,
      name: `Per-door overage (${tier})`,
      metadata: { rate_card_tier: tier, rate_card_purpose: "door_overage" },
    });
    return created.id;
  } catch (err) {
    if (isStripeAlreadyExistsError(err)) return lookupKey;
    throw err;
  }
}

/**
 * Resolves the Stripe Price id for one tier's per-door overage line, creating
 * it if nothing purchasable exists yet. Order: env override
 * (`STRIPE_PRICE_DOOR_OVERAGE_<TIER>`) -> an existing Price under this tier's
 * `lookup_key` -> create the Product + Price from `RATE_CARD`. The lookup key
 * makes both steps idempotent across processes; the in-memory cache only
 * saves the network round trip within one.
 */
export async function ensureDoorOveragePrice(
  stripe: Pick<Stripe, "prices" | "products">,
  tier: PaidTier,
): Promise<string> {
  const envPrice = doorOverageEnvPriceId(tier);
  if (envPrice) return envPrice;

  const cached = doorOveragePriceCache.get(tier);
  if (cached) return cached;

  const lookupKey = doorOverageLookupKey(tier);
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (existing.data[0]?.id) {
    doorOveragePriceCache.set(tier, existing.data[0].id);
    return existing.data[0].id;
  }

  const productId = await ensureDoorOverageProduct(stripe, lookupKey, tier);
  const perDoorCents = RATE_CARD[tier].perExtraDoorMonthlyCents;
  if (perDoorCents === null) {
    throw new Error(`ensureDoorOveragePrice: ${tier} has no overage rate`);
  }
  try {
    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: perDoorCents,
      recurring: { interval: "month" },
      product: productId,
      lookup_key: lookupKey,
      nickname: `Door overage (${tier})`,
    });
    doorOveragePriceCache.set(tier, price.id);
    return price.id;
  } catch (err) {
    // Another process won the race on the same lookup_key; use its Price.
    if (isStripeAlreadyExistsError(err)) {
      const raced = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      if (raced.data[0]?.id) {
        doorOveragePriceCache.set(tier, raced.data[0].id);
        return raced.data[0].id;
      }
    }
    throw err;
  }
}

/**
 * A `RATE_CARD_VERSION` metadata patch for a subscription, or `null` when one
 * is already pinned. NEVER overwrites an existing value — once an account is
 * pinned to the version it migrated on, a later rate-card change must never
 * silently re-price it. Callers merge the returned object into whatever
 * metadata they are already writing; they do nothing when this returns `null`.
 */
export function resolveRateCardVersionMetadataPatch(
  existingMetadata: Record<string, string> | Stripe.Metadata | null | undefined,
): Record<string, string> | null {
  const current = existingMetadata?.[META_RATE_CARD_VERSION];
  if (typeof current === "string" && current.trim()) return null;
  return { [META_RATE_CARD_VERSION]: RATE_CARD_VERSION };
}

const DOOR_OVERAGE_LOOKUP_PREFIX = "proplane_door_overage_";

function isDoorOverageLookupKey(key: unknown): key is string {
  return typeof key === "string" && key.startsWith(DOOR_OVERAGE_LOOKUP_PREFIX);
}

/**
 * The subscription's door-overage item, if any, found by lookup-key PREFIX —
 * not by the given tier's own key. A tier change moves the account onto a
 * different Price (Pro's $3/door vs. Business's $2/door are different
 * Prices, not the same Price at a different quantity), so an item left over
 * from the account's PREVIOUS tier is still "the door item", just a stale
 * one `syncManagerDoorQuantity` must replace rather than ignore.
 */
function findDoorOverageItem(sub: Pick<Stripe.Subscription, "items">): Stripe.SubscriptionItem | undefined {
  return sub.items.data.find((item) => {
    const price = item.price;
    return typeof price === "object" && price !== null && isDoorOverageLookupKey((price as Stripe.Price).lookup_key);
  });
}

export type SyncManagerDoorQuantityInput = {
  stripe: Pick<Stripe, "subscriptions" | "prices" | "products">;
  db: SupabaseClient;
  managerUserId: string;
  stripeSubscriptionId: string;
  tier: PaidTier;
  /**
   * Pass the already-retrieved subscription (with `expand: ["items.data.price"]`)
   * when the caller already has one — e.g. right after its own price-change
   * update — to avoid a second read. Omit it to have this function retrieve
   * one itself.
   */
  subscription?: Stripe.Subscription;
};

export type SyncManagerDoorQuantityResult =
  | { ok: true; doors: number; quantity: number; changed: boolean }
  | { ok: false; error: string };

/**
 * The one function that ever changes a door-overage Stripe quantity.
 *
 * - Resolves the account's current doors and the overage `tier` implies.
 *   Never defaults to 0 or to the account total on a resolution failure —
 *   returns `{ ok: false }` and makes NO Stripe call at all.
 * - Idempotent: if the subscription's door item already matches `tier`'s
 *   `lookup_key` AND the computed quantity, this returns `changed: false`
 *   and issues no Stripe write.
 * - The Stripe write it issues, when one is needed, touches ONLY the door
 *   item(s): `{ id, quantity }` to update an existing same-tier item,
 *   `{ price, quantity }` to add a brand-new one, `{ id, deleted: true }`
 *   when the recomputed overage drops to 0, and — on a tier change, whose
 *   per-door rate is a different Stripe Price, not just a different quantity
 *   on the same one — both a delete of the stale tier's item and (if the new
 *   tier still has overage) a create of the new tier's, in the SAME call.
 *   It never includes the floor item's id or price, and never sends a
 *   tier/plan field — a tier change is applied by the CALLER (e.g.
 *   `update-tier`), which then calls this function to recompute the
 *   allowance; this function itself only ever prices doors.
 */
export async function syncManagerDoorQuantity(
  input: SyncManagerDoorQuantityInput,
): Promise<SyncManagerDoorQuantityResult> {
  const resolved = await resolveManagerDoorOverage(input.db, input.managerUserId, input.tier);
  if (!resolved.ok) return resolved;

  const sub =
    input.subscription ??
    (await input.stripe.subscriptions.retrieve(input.stripeSubscriptionId, {
      expand: ["items.data.price"],
    }));

  const lookupKey = doorOverageLookupKey(input.tier);
  const existingItem = findDoorOverageItem(sub);
  const existingPrice = existingItem && typeof existingItem.price === "object" ? existingItem.price : null;
  const belongsToCurrentTier = existingPrice?.lookup_key === lookupKey;
  const existingQuantity = belongsToCurrentTier ? (existingItem?.quantity ?? 0) : 0;

  if (belongsToCurrentTier && existingQuantity === resolved.quantity) {
    return { ok: true, doors: resolved.doors, quantity: resolved.quantity, changed: false };
  }

  const items: Stripe.SubscriptionUpdateParams.Item[] = [];
  if (existingItem?.id && !belongsToCurrentTier) {
    // Stale item from a tier this account is no longer on — its Price is
    // wrong for the new tier's rate, so it is removed regardless of the new
    // quantity, never repriced in place.
    items.push({ id: existingItem.id, deleted: true });
  }
  if (resolved.quantity === 0) {
    if (belongsToCurrentTier && existingItem?.id) items.push({ id: existingItem.id, deleted: true });
  } else if (belongsToCurrentTier && existingItem?.id) {
    items.push({ id: existingItem.id, quantity: resolved.quantity });
  } else {
    const priceId = await ensureDoorOveragePrice(input.stripe, input.tier);
    items.push({ price: priceId, quantity: resolved.quantity });
  }

  if (!items.length) {
    // Recomputed to 0 but there was never an item to remove — nothing to send.
    return { ok: true, doors: resolved.doors, quantity: resolved.quantity, changed: false };
  }

  await input.stripe.subscriptions.update(input.stripeSubscriptionId, {
    items,
    proration_behavior: "create_prorations",
  });

  return { ok: true, doors: resolved.doors, quantity: resolved.quantity, changed: true };
}
