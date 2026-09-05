import {
  findManagerPurchaseForAccount,
  finalizePendingManagerFreeTier,
  isManagerOnboardingComplete,
  provisionPendingManagerAccount,
} from "@/lib/auth/manager-onboarding";
import { markGoogleServicesOnboardingPending } from "@/lib/auth/manager-google-services-onboarding.server";
import type { SupabaseClient } from "@supabase/supabase-js";

type Tier = "free" | "pro" | "business";
type Billing = "monthly" | "annual" | "free" | "trial";

export async function resolveManagerPurchaseForPricing(
  supabase: SupabaseClient,
  userId: string,
  email: string,
): Promise<
  | { kind: "complete" }
  | { kind: "pending"; managerId: string; purchaseId: string }
  | { kind: "none" }
> {
  const purchase = await findManagerPurchaseForAccount(supabase, userId, email);
  if (!purchase) return { kind: "none" };
  if (isManagerOnboardingComplete(purchase)) return { kind: "complete" };
  return { kind: "pending", managerId: purchase.manager_id, purchaseId: purchase.id };
}

/** Ensures profile + pending purchase exist for a signed-in user starting or resuming pricing. */
export async function ensureProvisionedManagerForPricing(
  supabase: SupabaseClient,
  opts: { userId: string; email: string; fullName?: string | null },
): Promise<{ kind: "complete" } | { kind: "ready"; managerId: string }> {
  const state = await resolveManagerPurchaseForPricing(supabase, opts.userId, opts.email);
  if (state.kind === "complete") return { kind: "complete" };

  if (state.kind === "none") {
    const { managerId } = await provisionPendingManagerAccount(supabase, opts);
    return { kind: "ready", managerId };
  }

  await provisionPendingManagerAccount(supabase, opts);
  return { kind: "ready", managerId: state.managerId };
}

export async function completeFreeManagerTierForUser(
  supabase: SupabaseClient,
  opts: {
    userId: string;
    email: string;
    fullName?: string | null;
    tier: Tier;
    billing: Billing;
    promo?: string | null;
  },
): Promise<{ managerId: string; alreadyLinked: boolean }> {
  const prepared = await ensureProvisionedManagerForPricing(supabase, opts);
  if (prepared.kind === "complete") {
    throw new Error("A manager account already exists for this email. Sign in instead.");
  }

  await finalizePendingManagerFreeTier(supabase, opts);
  await markGoogleServicesOnboardingPending(supabase, opts.userId).catch(() => undefined);
  return { managerId: prepared.managerId, alreadyLinked: true };
}
