import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagerSkuTier } from "@/lib/manager-access";
import { invalidateManagerTierCache } from "@/lib/manager-tier-sync-cache";

export const ADMIN_MANAGER_PURCHASE_PREFIX = "admin_" as const;

export type AdminManagerTier = ManagerSkuTier | "pending";

export function isAdminManagedManagerPurchase(
  stripeCheckoutSessionId: string | null | undefined,
): boolean {
  return Boolean(stripeCheckoutSessionId?.trim().startsWith(ADMIN_MANAGER_PURCHASE_PREFIX));
}

/** Billing for admin-assigned tiers without Stripe checkout. */
export function normalizeAdminManagerBilling(
  tier: AdminManagerTier | null | undefined,
  billing: string | null | undefined,
): string {
  if (!tier || tier === "pending" || tier === "free") return "free";
  const normalized = billing?.trim().toLowerCase();
  if (normalized === "monthly" || normalized === "annual") return normalized;
  return "portal";
}

export type ApplyAdminManagerPurchaseInput = {
  userId: string;
  email: string;
  managerId: string;
  tier: AdminManagerTier;
  billing?: string | null;
};

/**
 * Sets manager plan tier from the admin portal without Stripe payment.
 * Clears any Stripe subscription link so reconcile cannot overwrite the admin grant.
 */
export async function applyAdminManagerPurchaseTier(
  supabase: SupabaseClient,
  input: ApplyAdminManagerPurchaseInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const userId = input.userId.trim();
  const email = input.email.trim().toLowerCase();
  const managerId = input.managerId.trim();
  if (!userId || !email || !managerId) {
    return { ok: false, error: "Manager profile is incomplete." };
  }

  const tier = input.tier;
  const billing = normalizeAdminManagerBilling(tier, input.billing);
  const adminSessionId = `${ADMIN_MANAGER_PURCHASE_PREFIX}${managerId}`;

  const { data: existingPurchase } = await supabase
    .from("manager_purchases")
    .select("id")
    .eq("manager_id", managerId)
    .maybeSingle();

  const patch: Record<string, string | null> = {
    email,
    manager_id: managerId,
    user_id: userId,
    stripe_checkout_session_id: adminSessionId,
    stripe_subscription_id: null,
    tier: tier === "pending" ? null : tier,
    billing,
  };

  if (tier !== "pending") {
    patch.paid_at = new Date().toISOString();
  }

  if (existingPurchase) {
    const { error } = await supabase.from("manager_purchases").update(patch).eq("id", existingPurchase.id);
    if (error) return { ok: false, error: error.message };
    invalidateManagerTierCache(userId);
    return { ok: true };
  }

  const { error } = await supabase.from("manager_purchases").insert({
    ...patch,
    paid_at: patch.paid_at ?? new Date().toISOString(),
  });
  if (error) return { ok: false, error: error.message };
  invalidateManagerTierCache(userId);
  return { ok: true };
}
