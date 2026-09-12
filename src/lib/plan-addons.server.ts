import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  EMPTY_PLAN_ADDON_QUANTITIES,
  PLAN_ADDONS,
  isPlanAddonId,
  planTierCanHoldAddons,
  type PaidPlanTier,
  type PlanAddonId,
  type PlanAddonQuantities,
} from "@/lib/plan-addons";

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
 * Add-on purchase changes are temporarily unavailable. Existing quantities
 * remain readable for the quotas that already honor them.
 */
export async function setManagerPlanAddonQuantity(input: {
  managerUserId: string;
  addonId: PlanAddonId;
  quantity: number;
}): Promise<SetPlanAddonResult> {
  const managerUserId = input.managerUserId.trim();
  const quantity = Math.round(input.quantity);
  if (!managerUserId) return { ok: false, status: 403, error: "Sign in to change add-ons." };
  if (!Number.isFinite(quantity) || quantity < 0 || quantity > 100) {
    return { ok: false, status: 400, error: "Choose a quantity between 0 and 100." };
  }

  // Keep identity and request-shape errors stable, then stop before every plan,
  // service-role, Stripe, or entitlement read/write boundary.
  return {
    ok: false,
    status: 503,
    code: "add_on_purchases_unavailable",
    error: "Add-on purchases are not available yet. Your current plan and existing add-ons remain unchanged.",
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
    // Purchase writes are intentionally closed until their billing workflow is
    // independently safe to release. Existing quantities remain readable.
    purchasable: false,
  }));
}
