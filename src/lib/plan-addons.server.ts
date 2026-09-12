import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";

import { getEffectiveManagerSkuTier, getManagerPurchaseSku } from "@/lib/manager-access-server";
import {
  EMPTY_PLAN_ADDON_QUANTITIES,
  PLAN_ADDONS,
  isPlanAddonId,
  planAddonMaxQuantity,
  planTierCanHoldAddons,
  stripePriceIdForPlanAddon,
  type PaidPlanTier,
  type PlanAddonId,
  type PlanAddonQuantities,
} from "@/lib/plan-addons";
import { getStripe } from "@/lib/stripe";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export type PlanAddonQuantitiesRead =
  | { ok: true; quantities: PlanAddonQuantities }
  | { ok: false; error: string };

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
    // Before the migration lands the table does not exist; that is "no
    // add-ons", not an outage — the plan bundle still applies.
    if (/manager_plan_addons/i.test(error.message) && /does not exist|schema cache/i.test(error.message)) {
      return { ok: true, quantities: { ...EMPTY_PLAN_ADDON_QUANTITIES } };
    }
    return { ok: false, error: error.message };
  }
  const quantities: PlanAddonQuantities = { ...EMPTY_PLAN_ADDON_QUANTITIES };
  for (const row of data ?? []) {
    if (isPlanAddonId(row.addon_id)) quantities[row.addon_id] = Math.max(0, Number(row.quantity) || 0);
  }
  return { ok: true, quantities };
}

/** The add-on quantity to add to a plan cap — zero when the plan cannot hold add-ons. */
export function addonUnitsForCap(
  quantities: PlanAddonQuantities,
  id: PlanAddonId,
  tier: string | null | undefined,
): number {
  return planTierCanHoldAddons(tier) ? Math.max(0, quantities[id] ?? 0) : 0;
}

export type SetPlanAddonResult =
  | { ok: true; quantities: PlanAddonQuantities; stripeSynced: boolean }
  | { ok: false; status: 400 | 402 | 403 | 409 | 500 | 503; error: string; code?: string };

/**
 * Set how many units of one add-on the account holds.
 *
 * Order matters: the plan is checked first (Free cannot buy add-ons — it
 * upgrades), then the cap, then Stripe — the subscription item is created,
 * updated or removed with proration BEFORE the quantity is written, so a
 * Stripe refusal never leaves a quantity the customer is not being billed
 * for. A comp or admin grant has no subscription to bill; its quantities are
 * recorded as part of the grant.
 */
export async function setManagerPlanAddonQuantity(input: {
  managerUserId: string;
  addonId: PlanAddonId;
  quantity: number;
  deps?: {
    loadStripeSubscription?: (id: string) => Promise<Stripe.Subscription>;
    stripe?: Pick<Stripe, "subscriptionItems">;
  };
}): Promise<SetPlanAddonResult> {
  const managerUserId = input.managerUserId.trim();
  const quantity = Math.round(input.quantity);
  if (!managerUserId) return { ok: false, status: 403, error: "Sign in to change add-ons." };
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 100) {
    return { ok: false, status: 400, error: "Choose a quantity between 0 and 100." };
  }

  const tierResult = await getEffectiveManagerSkuTier(managerUserId);
  if (!tierResult.ok) return { ok: false, status: 503, error: tierResult.error };
  const tier = tierResult.tier;
  if (!planTierCanHoldAddons(tier)) {
    return {
      ok: false,
      status: 403,
      code: "upgrade_required",
      error: "Add-ons are for Pro and Business. Upgrade your plan to add listings, numbers, workspaces or seats.",
    };
  }
  const paidTier: PaidPlanTier = tier;
  const cap = planAddonMaxQuantity(input.addonId, paidTier);
  if (cap !== null && quantity > cap) {
    return { ok: false, status: 400, error: `Your plan can hold up to ${cap} of this add-on.` };
  }

  const svc = createSupabaseServiceRoleClient();
  const current = await loadManagerPlanAddonQuantities(svc, managerUserId);
  if (!current.ok) return { ok: false, status: 503, error: "Could not read your add-ons. Try again." };

  const purchase = await getManagerPurchaseSku(managerUserId);
  if (purchase.readFailed) return { ok: false, status: 503, error: "Could not read your plan. Try again." };
  const subscriptionId = purchase.stripeSubscriptionId?.trim() || null;

  let stripeSynced = false;
  let itemId: string | null = null;
  if (subscriptionId) {
    const priceId = stripePriceIdForPlanAddon(input.addonId, paidTier);
    if (!priceId) {
      return {
        ok: false,
        status: 503,
        code: "price_not_configured",
        error: "This add-on is not available for purchase yet. Contact PropLane support.",
      };
    }
    const stripe = input.deps?.stripe ?? getStripe();
    const { data: existing } = await svc
      .from("manager_plan_addons")
      .select("stripe_subscription_item_id")
      .eq("manager_user_id", managerUserId)
      .eq("addon_id", input.addonId)
      .maybeSingle();
    const existingItemId = (existing?.stripe_subscription_item_id as string | null) ?? null;
    try {
      if (quantity === 0) {
        if (existingItemId) await stripe.subscriptionItems.del(existingItemId, { proration_behavior: "create_prorations" });
        itemId = null;
      } else if (existingItemId) {
        const item = await stripe.subscriptionItems.update(existingItemId, {
          quantity,
          price: priceId,
          proration_behavior: "create_prorations",
        });
        itemId = item.id;
      } else {
        const item = await stripe.subscriptionItems.create({
          subscription: subscriptionId,
          price: priceId,
          quantity,
          proration_behavior: "create_prorations",
        });
        itemId = item.id;
      }
      stripeSynced = true;
    } catch (error) {
      return {
        ok: false,
        status: 402,
        code: "stripe_refused",
        error: error instanceof Error ? error.message : "Stripe could not update your subscription.",
      };
    }
  }

  const now = new Date().toISOString();
  const { error } = await svc.from("manager_plan_addons").upsert(
    {
      manager_user_id: managerUserId,
      addon_id: input.addonId,
      quantity,
      stripe_subscription_item_id: itemId,
      updated_at: now,
    },
    { onConflict: "manager_user_id,addon_id" },
  );
  if (error) return { ok: false, status: 500, error: error.message };

  return {
    ok: true,
    quantities: { ...current.quantities, [input.addonId]: quantity },
    stripeSynced,
  };
}

/** The catalogue with this account's quantities, for the Billing & plan panel. */
export function describePlanAddons(tier: PaidPlanTier, quantities: PlanAddonQuantities) {
  return PLAN_ADDONS.map((addon) => ({
    id: addon.id,
    label: addon.label,
    unit: addon.unit,
    description: addon.description,
    monthlyCents: addon.monthlyCents[tier],
    maxQuantity: addon.maxQuantity[tier],
    quantity: Math.max(0, quantities[addon.id] ?? 0),
    purchasable: Boolean(stripePriceIdForPlanAddon(addon.id, tier)),
  }));
}
