import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getEffectiveManagerSkuTier, getManagerPurchaseSku } from "@/lib/manager-access-server";
import { getStripe } from "@/lib/stripe";
import { stripeSubscriptionIsBillable } from "@/lib/stripe-subscription-helpers";
import { WORKSPACE_LIMIT, WORKSPACE_PLAN_ENTITLEMENTS } from "@/lib/workspaces/types";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  EMPTY_PLAN_ADDON_QUANTITIES,
  PLAN_ADDONS,
  isPlanAddonId,
  maxExtraWorkNumberQuantity,
  maxExtraWorkspaceQuantity,
  planAddon,
  planAddonLookupKey,
  planTierCanHoldAddons,
  stripePriceIdForPlanAddon,
  type PaidPlanTier,
  type PlanAddonId,
  type PlanAddonQuantities,
} from "@/lib/plan-addons";

export type PlanAddonQuantitiesRead =
  | { ok: true; quantities: PlanAddonQuantities }
  | { ok: false; error: string };

type AddonRow = { addon_id: string; quantity: number; stripe_subscription_item_id?: string | null };

/**
 * Add-on quantities an account holds. A read failure is a RESULT, not zero:
 * a quota that read "could not tell" as "no add-ons" would refuse the very
 * listing a manager is paying $8 a month to hold.
 */
export async function loadManagerPlanAddonQuantities(
  db: SupabaseClient,
  managerUserId: string,
): Promise<PlanAddonQuantitiesRead> {
  const { data, error } = await db
    .from("manager_plan_addons")
    .select("addon_id, quantity")
    .eq("manager_user_id", managerUserId);
  if (error) {
    return { ok: false, error: error.message };
  }
  const quantities: PlanAddonQuantities = { ...EMPTY_PLAN_ADDON_QUANTITIES };
  for (const row of (data ?? []) as AddonRow[]) {
    if (isPlanAddonId(row.addon_id)) quantities[row.addon_id] = Math.max(0, Number(row.quantity) || 0);
  }
  return { ok: true, quantities };
}

/** This account's stored Stripe subscription item id per add-on, `null` where none exists yet. */
async function loadManagerPlanAddonItemIds(
  db: SupabaseClient,
  managerUserId: string,
): Promise<Partial<Record<PlanAddonId, string>>> {
  const { data, error } = await db
    .from("manager_plan_addons")
    .select("addon_id, stripe_subscription_item_id")
    .eq("manager_user_id", managerUserId);
  if (error) throw new Error(error.message);
  const byAddon: Partial<Record<PlanAddonId, string>> = {};
  for (const row of (data ?? []) as AddonRow[]) {
    if (isPlanAddonId(row.addon_id) && row.stripe_subscription_item_id) {
      byAddon[row.addon_id] = row.stripe_subscription_item_id;
    }
  }
  return byAddon;
}

/** The add-on quantity to add to a plan cap — zero when the plan cannot hold add-ons. */
export function addonUnitsForCap(
  quantities: PlanAddonQuantities,
  id: PlanAddonId,
  tier: string | null | undefined,
): number {
  return planTierCanHoldAddons(tier) ? Math.max(0, quantities[id] ?? 0) : 0;
}

export type PlanAddonChangeInput = { addonId: PlanAddonId; quantity: number };

export type SetPlanAddonResult =
  | { ok: true; quantities: PlanAddonQuantities; stripeSynced: boolean }
  | { ok: false; status: 400 | 402 | 403 | 409 | 500 | 503; error: string; code?: string };

// Per-process cache of add-on Price ids created (or found) via `ensureAddonPrice`,
// keyed `${addonId}:${tier}`. Env-configured prices are never cached here — they
// are already free to re-read — so a later env change takes effect immediately.
const addonPriceCache = new Map<string, string>();

function isStripeAlreadyExistsError(err: unknown): boolean {
  const code = typeof err === "object" && err !== null && "code" in err ? String((err as { code?: string }).code) : "";
  return code === "resource_already_exists";
}

/**
 * The Product an auto-created add-on Price attaches to. Its id IS the lookup
 * key, so creating it twice is a 409 from Stripe rather than a duplicate
 * product — `products.create` with a fixed id is Stripe's own idempotency key
 * for this, no extra bookkeeping needed.
 */
async function ensureAddonProduct(
  stripe: Pick<Stripe, "products">,
  lookupKey: string,
  addonId: PlanAddonId,
): Promise<string> {
  try {
    const created = await stripe.products.create({
      id: lookupKey,
      name: `${planAddon(addonId).label} add-on`,
      metadata: { plan_addon_id: addonId },
    });
    return created.id;
  } catch (err) {
    if (isStripeAlreadyExistsError(err)) return lookupKey;
    throw err;
  }
}

/**
 * Resolves the Stripe Price id for one add-on on one plan tier, creating it
 * if nothing purchasable exists yet. Add-ons are always active (PLAN-0920):
 * a missing env price must never block a purchase.
 *
 * Order: env override (`STRIPE_PRICE_ADDON_<ID>_<TIER>`) → an existing Price
 * under this add-on's `lookup_key` → create the Product + Price. The lookup
 * key makes both steps idempotent across processes; the in-memory cache only
 * saves the network round trip within one.
 */
export async function ensureAddonPrice(
  stripe: Pick<Stripe, "prices" | "products">,
  addonId: PlanAddonId,
  tier: PaidPlanTier,
): Promise<string> {
  const envPrice = stripePriceIdForPlanAddon(addonId, tier);
  if (envPrice) return envPrice;

  const cacheKey = `${addonId}:${tier}`;
  const cached = addonPriceCache.get(cacheKey);
  if (cached) return cached;

  const lookupKey = planAddonLookupKey(addonId, tier);
  const existing = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  if (existing.data[0]?.id) {
    addonPriceCache.set(cacheKey, existing.data[0].id);
    return existing.data[0].id;
  }

  const productId = await ensureAddonProduct(stripe, lookupKey, addonId);
  const addon = planAddon(addonId);
  try {
    const price = await stripe.prices.create({
      currency: "usd",
      unit_amount: addon.monthlyCents[tier],
      recurring: { interval: "month" },
      product: productId,
      lookup_key: lookupKey,
      nickname: `${addon.label} (${tier})`,
    });
    addonPriceCache.set(cacheKey, price.id);
    return price.id;
  } catch (err) {
    // Another process won the race on the same lookup_key; use its Price.
    if (isStripeAlreadyExistsError(err)) {
      const raced = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
      if (raced.data[0]?.id) {
        addonPriceCache.set(cacheKey, raced.data[0].id);
        return raced.data[0].id;
      }
    }
    throw err;
  }
}

/** Total workspaces (included + the `extra_workspace` quantity) this add-on set implies. */
function totalWorkspacesFor(tier: PaidPlanTier, quantities: PlanAddonQuantities): number {
  return WORKSPACE_PLAN_ENTITLEMENTS[tier].workspaces + Math.max(0, quantities.extra_workspace ?? 0);
}

/** The catalogue with this account's quantities, for the Billing & plan panel. Never disabled: every row is purchasable. */
export function describePlanAddons(tier: PaidPlanTier, quantities: PlanAddonQuantities) {
  const totalWorkspaces = totalWorkspacesFor(tier, quantities);
  const includedWorkspaces = WORKSPACE_PLAN_ENTITLEMENTS[tier].workspaces;
  return PLAN_ADDONS.map((addon) => {
    const maxQuantity =
      addon.id === "extra_work_number"
        ? maxExtraWorkNumberQuantity(tier, totalWorkspaces)
        : addon.id === "extra_workspace"
          ? maxExtraWorkspaceQuantity(tier, includedWorkspaces, WORKSPACE_LIMIT)
          : addon.maxQuantity[tier];
    return {
      id: addon.id,
      label: addon.label,
      unit: addon.unit,
      description: addon.description,
      monthlyCents: addon.monthlyCents[tier],
      maxQuantity,
      quantity: Math.max(0, quantities[addon.id] ?? 0),
      purchasable: true,
    };
  });
}

function validateChanges(changes: PlanAddonChangeInput[]): { ok: true } | { ok: false; error: string } {
  if (!changes.length) return { ok: false, error: "Choose at least one add-on to change." };
  const seen = new Set<PlanAddonId>();
  for (const change of changes) {
    if (!isPlanAddonId(change.addonId)) return { ok: false, error: "Unknown add-on." };
    if (seen.has(change.addonId)) return { ok: false, error: "Each add-on can only change once per request." };
    seen.add(change.addonId);
    const quantity = Math.round(change.quantity);
    if (!Number.isFinite(quantity) || quantity < 0 || quantity > 100) {
      return { ok: false, error: "Choose a quantity between 0 and 100." };
    }
  }
  return { ok: true };
}

/**
 * Applies a batch of add-on quantity changes as ONE Stripe subscription
 * update — all-or-nothing, prorated. On any Stripe failure nothing is
 * written and the caller's existing quantities are returned unchanged. An
 * account with no billable Stripe subscription (comp / admin / waiver /
 * Apple) writes quantities directly with no Stripe call, exactly as those
 * grants already bypass Stripe elsewhere.
 */
export async function setManagerPlanAddonQuantities(input: {
  managerUserId: string;
  changes: PlanAddonChangeInput[];
}): Promise<SetPlanAddonResult> {
  const managerUserId = input.managerUserId.trim();
  if (!managerUserId) return { ok: false, status: 403, error: "Sign in to change add-ons." };

  const validated = validateChanges(input.changes);
  if (!validated.ok) return { ok: false, status: 400, error: validated.error };
  const changes = input.changes.map((c) => ({ addonId: c.addonId, quantity: Math.round(c.quantity) }));

  const tierResult = await getEffectiveManagerSkuTier(managerUserId);
  if (!tierResult.ok) return { ok: false, status: 503, error: "Could not read your plan." };
  if (!planTierCanHoldAddons(tierResult.tier)) {
    return { ok: false, status: 402, error: "Add-ons are for Pro and Business. Upgrade your plan to add them." };
  }
  const tier = tierResult.tier;

  const db = createSupabaseServiceRoleClient();
  const current = await loadManagerPlanAddonQuantities(db, managerUserId);
  if (!current.ok) return { ok: false, status: 503, error: "Could not read your add-ons." };

  const nextQuantities: PlanAddonQuantities = { ...current.quantities };
  for (const change of changes) nextQuantities[change.addonId] = change.quantity;

  for (const addon of PLAN_ADDONS) {
    if (addon.id === "extra_work_number" || addon.id === "extra_workspace") continue;
    const max = addon.maxQuantity[tier];
    if (max !== null && nextQuantities[addon.id] > max) {
      return { ok: false, status: 400, error: `Your plan can hold up to ${max} of ${addon.unit}s.` };
    }
  }

  const totalWorkspaces = totalWorkspacesFor(tier, nextQuantities);
  const maxWorkspaceAddon = maxExtraWorkspaceQuantity(tier, WORKSPACE_PLAN_ENTITLEMENTS[tier].workspaces, WORKSPACE_LIMIT);
  if (nextQuantities.extra_workspace > maxWorkspaceAddon) {
    return {
      ok: false,
      status: 400,
      error: `Your plan can hold up to ${maxWorkspaceAddon} extra workspace${maxWorkspaceAddon === 1 ? "" : "s"}.`,
    };
  }
  const maxNumberAddon = maxExtraWorkNumberQuantity(tier, totalWorkspaces);
  if (nextQuantities.extra_work_number > maxNumberAddon) {
    return {
      ok: false,
      status: 400,
      error: "Each workspace can hold at most 2 work numbers. Add another workspace first.",
    };
  }

  const purchase = await getManagerPurchaseSku(managerUserId);
  const stripeManaged = await stripeSubscriptionIsBillable(purchase.stripeSubscriptionId);

  if (!stripeManaged) {
    const write = await writeManagerPlanAddonQuantities(db, managerUserId, changes, {});
    if (!write.ok) return { ok: false, status: 500, error: write.error };
    return { ok: true, quantities: nextQuantities, stripeSynced: false };
  }

  const stripe = getStripe();
  const existingItemIds = await loadManagerPlanAddonItemIds(db, managerUserId);

  const priceIdByAddon: Partial<Record<PlanAddonId, string>> = {};
  const items: Stripe.SubscriptionUpdateParams.Item[] = [];
  for (const change of changes) {
    const existingItemId = existingItemIds[change.addonId];
    if (change.quantity === 0) {
      if (existingItemId) items.push({ id: existingItemId, deleted: true });
      continue;
    }
    if (existingItemId) {
      items.push({ id: existingItemId, quantity: change.quantity });
    } else {
      const priceId = await ensureAddonPrice(stripe, change.addonId, tier);
      priceIdByAddon[change.addonId] = priceId;
      items.push({ price: priceId, quantity: change.quantity });
    }
  }

  if (!items.length) {
    // Every change matched what Stripe already holds (e.g. removing an
    // add-on that never had a subscription item). Nothing to send.
    const write = await writeManagerPlanAddonQuantities(db, managerUserId, changes, {});
    if (!write.ok) return { ok: false, status: 500, error: write.error };
    return { ok: true, quantities: nextQuantities, stripeSynced: false };
  }

  let updated: Stripe.Subscription;
  try {
    updated = await stripe.subscriptions.update(purchase.stripeSubscriptionId!, {
      items,
      proration_behavior: "create_prorations",
    });
  } catch (err) {
    // All-or-nothing: on any Stripe failure, write nothing and hand back
    // what the account actually still holds.
    return {
      ok: false,
      status: 402,
      code: "addon_purchase_failed",
      error: err instanceof Error ? err.message : "We couldn't update your add-ons. Nothing changed.",
    };
  }

  const newItemIdByAddon: Partial<Record<PlanAddonId, string | null>> = {};
  for (const change of changes) {
    if (change.quantity === 0) {
      newItemIdByAddon[change.addonId] = null;
      continue;
    }
    // An add-on that already had an item keeps the same item id (quantity-only
    // update); a first purchase matches the item Stripe created for the new price.
    const newPriceId = priceIdByAddon[change.addonId];
    if (!newPriceId) {
      newItemIdByAddon[change.addonId] = existingItemIds[change.addonId] ?? null;
      continue;
    }
    const matched = updated.items.data.find((item) => {
      const itemPriceId = typeof item.price === "string" ? item.price : item.price?.id;
      return itemPriceId === newPriceId;
    });
    newItemIdByAddon[change.addonId] = matched?.id ?? null;
  }

  const write = await writeManagerPlanAddonQuantities(db, managerUserId, changes, newItemIdByAddon);
  if (!write.ok) return { ok: false, status: 500, error: write.error };

  return { ok: true, quantities: nextQuantities, stripeSynced: true };
}

/** Convenience wrapper for a single add-on change. */
export async function setManagerPlanAddonQuantity(input: {
  managerUserId: string;
  addonId: PlanAddonId;
  quantity: number;
}): Promise<SetPlanAddonResult> {
  return setManagerPlanAddonQuantities({
    managerUserId: input.managerUserId,
    changes: [{ addonId: input.addonId, quantity: input.quantity }],
  });
}

async function writeManagerPlanAddonQuantities(
  db: SupabaseClient,
  managerUserId: string,
  changes: PlanAddonChangeInput[],
  itemIdByAddon: Partial<Record<PlanAddonId, string | null>>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const rows = changes.map((change) => ({
    manager_user_id: managerUserId,
    addon_id: change.addonId,
    quantity: change.quantity,
    stripe_subscription_item_id: Object.prototype.hasOwnProperty.call(itemIdByAddon, change.addonId)
      ? itemIdByAddon[change.addonId]
      : undefined,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await db.from("manager_plan_addons").upsert(rows, { onConflict: "manager_user_id,addon_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
