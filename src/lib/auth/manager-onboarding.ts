import { normalizeManagerSkuTier } from "@/lib/manager-access";
import { ensureSandboxManagerLandlordProfile } from "@/lib/manager-landlord-profile";
import { generateManagerId } from "@/lib/manager-id";
import { isAxisIntentSessionId } from "@/lib/manager-signup-intent";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { randomUUID } from "crypto";
import { track } from "@/lib/analytics/posthog";
import type { SupabaseClient } from "@supabase/supabase-js";

/** Reserved purchase row before the manager picks Free / Pro / Business on pricing. */
export const AXIS_PENDING_PREFIX = "axis_pending_" as const;

export function isAxisPendingSessionId(id: string): boolean {
  return id.startsWith(AXIS_PENDING_PREFIX);
}

export function newAxisPendingSessionId(): string {
  return `${AXIS_PENDING_PREFIX}${randomUUID()}`;
}

export type ManagerPurchaseRow = {
  id: string;
  email: string;
  manager_id: string;
  tier: string | null;
  billing: string | null;
  stripe_checkout_session_id: string;
  user_id: string | null;
  full_name?: string | null;
  paid_at?: string | null;
};

export function isManagerOnboardingComplete(purchase: ManagerPurchaseRow | null | undefined): boolean {
  if (!purchase) return false;
  if (isAxisPendingSessionId(purchase.stripe_checkout_session_id)) return false;
  const tier = normalizeManagerSkuTier(purchase.tier);
  if (!tier) return false;
  if (!purchase.paid_at) return false;
  if (tier === "free" || isAxisIntentSessionId(purchase.stripe_checkout_session_id)) {
    return true;
  }
  return !isAxisIntentSessionId(purchase.stripe_checkout_session_id);
}

const PURCHASE_SELECT =
  "id, email, manager_id, tier, billing, stripe_checkout_session_id, user_id, full_name, paid_at";

/** The account's own mailbox is proven (confirmed Auth address, or a just-verified password). */
export type PurchaseEmailProof = { emailVerified?: boolean };

/**
 * The `manager_purchases` row this account owns.
 *
 * By `user_id` first. The by-email half exists only for the pre-auth signup row (`email` / `manager_id`,
 * no `user_id` yet), and it is an ENTITLEMENT - it hands over a tier, a workspace and the manager role -
 * so matching an ADDRESS is never ownership of someone else's account:
 *
 * - it reads UNCLAIMED rows only, so a row another account already holds can never be adopted (the
 *   `user_id` read above already covers rows this account holds);
 * - `emailVerified: false` drops it entirely, for a session whose mailbox nothing has proven;
 * - a read error returns null, so nothing is granted from an answer we could not get.
 */
export async function findManagerPurchaseForAccount(
  supabase: SupabaseClient,
  userId: string,
  email: string,
  proof: PurchaseEmailProof = {},
): Promise<ManagerPurchaseRow | null> {
  const { data: byUser, error: byUserError } = await supabase
    .from("manager_purchases")
    .select(PURCHASE_SELECT)
    .eq("user_id", userId)
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (byUserError) return null;
  if (byUser) return byUser as ManagerPurchaseRow;

  if (proof.emailVerified === false) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;

  const { data: byEmail, error: byEmailError } = await supabase
    .from("manager_purchases")
    .select(PURCHASE_SELECT)
    .eq("email", normalized)
    .is("user_id", null)
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (byEmailError) return null;
  return (byEmail as ManagerPurchaseRow | null) ?? null;
}

export async function managerNeedsPricingSelection(
  supabase: SupabaseClient,
  userId: string,
  email: string,
  proof: PurchaseEmailProof = {},
): Promise<boolean> {
  const purchase = await findManagerPurchaseForAccount(supabase, userId, email, proof);
  return !isManagerOnboardingComplete(purchase);
}

/** Creates auth profile + manager role + pending purchase (tier not chosen yet). */
export async function provisionPendingManagerAccount(
  supabase: SupabaseClient,
  opts: { userId: string; email: string; fullName?: string | null },
): Promise<{ managerId: string; created: boolean }> {
  const email = opts.email.trim().toLowerCase();
  const fullName = opts.fullName?.trim() || null;

  const existingPurchase = await findManagerPurchaseForAccount(supabase, opts.userId, email);
  if (existingPurchase && isManagerOnboardingComplete(existingPurchase)) {
    throw new Error("A manager account already exists for this email.");
  }

  if (existingPurchase && isAxisPendingSessionId(existingPurchase.stripe_checkout_session_id)) {
    const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", opts.userId).maybeSingle();
    await supabase.from("profiles").upsert(
      {
        id: opts.userId,
        email,
        role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
        manager_id: existingPurchase.manager_id,
        full_name: fullName || existingProfile?.full_name || existingPurchase.full_name || null,
        application_approved: existingProfile?.application_approved ?? true,
      },
      { onConflict: "id" },
    );
    await ensureProfileRoleRow(supabase, opts.userId, "manager");
    if (!existingPurchase.user_id) {
      await supabase.from("manager_purchases").update({ user_id: opts.userId }).eq("id", existingPurchase.id);
    }
    const { scheduleManagerMessagingReady } = await import("@/lib/proplane-sms-transport.server");
    scheduleManagerMessagingReady(opts.userId);
    await ensureSandboxManagerLandlordProfile(supabase, {
      managerUserId: opts.userId,
      email,
      fullName,
    });
    return { managerId: existingPurchase.manager_id, created: false };
  }

  const managerId = existingPurchase?.manager_id ?? generateManagerId();
  const sessionId = existingPurchase?.stripe_checkout_session_id ?? newAxisPendingSessionId();

  const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", opts.userId).maybeSingle();

  const { error: profileErr } = await supabase.from("profiles").upsert(
    {
      id: opts.userId,
      email,
      role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
      manager_id: managerId,
      full_name: fullName || existingProfile?.full_name || null,
      application_approved: existingProfile?.application_approved ?? true,
    },
    { onConflict: "id" },
  );
  if (profileErr) throw profileErr;

  await ensureProfileRoleRow(supabase, opts.userId, "manager");

  if (existingPurchase) {
    const { error: linkErr } = await supabase
      .from("manager_purchases")
      .update({ user_id: opts.userId, full_name: fullName || existingPurchase.full_name })
      .eq("id", existingPurchase.id);
    if (linkErr) throw linkErr;
  } else {
    const { error: insErr } = await supabase.from("manager_purchases").insert({
      stripe_checkout_session_id: sessionId,
      email,
      manager_id: managerId,
      tier: null,
      billing: null,
      user_id: opts.userId,
      full_name: fullName,
    });
    if (insErr) throw insErr;
  }

  // Prepare the manager's own SMS registration/number record; never stamp a shared line.
  const { scheduleManagerMessagingReady } = await import("@/lib/proplane-sms-transport.server");
  scheduleManagerMessagingReady(opts.userId);
  await ensureSandboxManagerLandlordProfile(supabase, {
    managerUserId: opts.userId,
    email,
    fullName,
  });

  return { managerId, created: true };
}

/** After Free tier (or 100% waiver) is chosen on pricing for an already-provisioned manager. */
export async function finalizePendingManagerFreeTier(
  supabase: SupabaseClient,
  opts: {
    userId: string;
    email: string;
    tier: "free" | "pro" | "business";
    billing: "monthly" | "annual" | "free" | "trial";
    fullName?: string | null;
    promo?: string | null;
  },
): Promise<{ sessionId: string; managerId: string }> {
  const purchase = await findManagerPurchaseForAccount(supabase, opts.userId, opts.email);
  if (!purchase) {
    throw new Error("No manager signup found for this account.");
  }

  const sessionId = isAxisPendingSessionId(purchase.stripe_checkout_session_id)
    ? `axis_intent_${randomUUID()}`
    : isAxisIntentSessionId(purchase.stripe_checkout_session_id)
      ? purchase.stripe_checkout_session_id
      : `axis_intent_${randomUUID()}`;

  const { error } = await supabase
    .from("manager_purchases")
    .update({
      stripe_checkout_session_id: sessionId,
      tier: opts.tier,
      billing: opts.billing,
      promo_code: opts.promo ?? null,
      paid_at: new Date().toISOString(),
      user_id: opts.userId,
      full_name: opts.fullName?.trim() || purchase.full_name || null,
    })
    .eq("id", purchase.id);

  if (error) throw error;

  // The one choke point every live manager signup passes through (email
  // register, Google/Apple callbacks, pricing, get-started). Fire only on the
  // pending -> complete transition so a repeat call never double counts.
  if (!isManagerOnboardingComplete(purchase)) {
    track("manager_account_created", opts.userId, {
      manager_id: purchase.manager_id,
      signup_method: opts.billing === "trial" ? "trial" : opts.tier === "free" ? "free_tier" : "pricing",
      tier: opts.tier,
      billing: opts.billing,
    });
  }

  return { sessionId, managerId: purchase.manager_id };
}
