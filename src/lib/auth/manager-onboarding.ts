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

export type PurchaseEmailProof = { emailVerified?: boolean };
export class ManagerPurchaseReadError extends Error {
  readonly detail: { code?: string | null; message?: string | null } | null;
  constructor(detail: { code?: string | null; message?: string | null } | null) {
    super("Could not read this account's manager signup. Please try again.");
    this.name = "ManagerPurchaseReadError";
    this.detail = detail ?? null;
  }
}
export function isManagerPurchaseReadError(error: unknown): error is ManagerPurchaseReadError {
  return error instanceof ManagerPurchaseReadError;
}

export async function findManagerPurchaseForAccount(
  supabase: SupabaseClient,
  userId: string,
  _email: string,
  _proof: PurchaseEmailProof = {},
): Promise<ManagerPurchaseRow | null> {
  void _proof;
  void _email; // Retained for callers; email alone is not purchase ownership.
  const { data: byUser, error } = await supabase
    .from("manager_purchases")
    .select("id, email, manager_id, tier, billing, stripe_checkout_session_id, user_id, full_name, paid_at")
    .eq("user_id", userId)
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new ManagerPurchaseReadError(error);
  const purchase = byUser as ManagerPurchaseRow | null;
  return purchase?.user_id === userId ? purchase : null;
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
  if (purchase.stripe_checkout_session_id.startsWith("cs_")) {
    throw new Error("A checkout is already in progress. Finish that checkout before choosing another plan.");
  }

  const sessionId = isAxisPendingSessionId(purchase.stripe_checkout_session_id)
    ? `axis_intent_${randomUUID()}`
    : isAxisIntentSessionId(purchase.stripe_checkout_session_id)
      ? purchase.stripe_checkout_session_id
      : `axis_intent_${randomUUID()}`;

  const { data: updated, error } = await supabase
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
    .eq("id", purchase.id)
    .eq("user_id", opts.userId)
    .eq("stripe_checkout_session_id", purchase.stripe_checkout_session_id)
    .select("id")
    .maybeSingle();

  if (error) throw error;
  if (!updated) throw new Error("Your signup changed. Please try again.");

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
