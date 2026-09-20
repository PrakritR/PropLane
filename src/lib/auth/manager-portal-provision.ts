import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  finalizePendingManagerFreeTier,
  findManagerPurchaseForAccount,
  isAxisPendingSessionId,
  isManagerOnboardingComplete,
  provisionPendingManagerAccount,
} from "@/lib/auth/manager-onboarding";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { markGoogleServicesOnboardingPending } from "@/lib/auth/manager-google-services-onboarding.server";
export type EnsureFreeManagerResult =
  | { status: "portal_ready"; managerId: string; provisioned: boolean }
  | { status: "skipped"; reason: string };

function oauthFullName(user: User): string | null {
  const meta = user.user_metadata ?? {};
  const fullName = typeof meta.full_name === "string" ? meta.full_name.trim() : "";
  if (fullName) return fullName;
  const name = typeof meta.name === "string" ? meta.name.trim() : "";
  return name || null;
}

async function hasManagerPortalAccess(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data: managerRow } = await supabase
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "manager")
    .maybeSingle();
  if (managerRow) return true;
  // An admin `profile_roles` row also counts: an admin who has explicitly added
  // the property portal (or the primary admin, who always holds both) already
  // has manager-portal access and must never be treated as resident-only.
  const { data: adminRow } = await supabase
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (adminRow) return true;
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  return profile?.role === "manager" || profile?.role === "admin";
}

async function isResidentOnlyAccount(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data: residentRole } = await supabase
    .from("profile_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "resident")
    .maybeSingle();
  if (!residentRole) return false;
  return !(await hasManagerPortalAccess(supabase, userId));
}

/**
 * Ensures a brand-new or incomplete auth user has a manager portal account.
 * Idempotent — safe on every OAuth callback and pricing return.
 *
 * `trialForNewManager` controls the default for a GENUINELY NEW account — one with
 * no `manager_purchases` row for this user or email. When true (the default), the
 * account gets a 14-day Pro trial (no card, no Stripe; `tier: "pro"`,
 * `billing: "trial"`, which `manager-tier-expiry.ts` /
 * `applyExpiredManagerPurchaseDowngrade` downgrades back to free after
 * `MANAGER_SUBSCRIPTION_TRIAL_DAYS`). Only the new-account branch honors it, so a
 * second sign-in / any already-provisioned account returns unchanged. Callers that
 * must commit Free immediately (pricing free-select, admin backfill) pass
 * `trialForNewManager: false`.
 *
 * `allowResidentUpgrade` lifts the resident-only refusal below. It defaults to
 * false so an OAuth sign-in callback — which never carries explicit intent to
 * become a manager — keeps refusing to silently upgrade a resident account.
 * The explicit "add another portal type" flow (get-started, add-portal mode)
 * passes `true`: a signed-in resident who clicks "Set up as a property
 * manager" there has said so on purpose.
 */
export async function ensureFreeManagerPortalAccess(
  supabase: SupabaseClient,
  user: User,
  opts?: { trialForNewManager?: boolean; allowResidentUpgrade?: boolean },
): Promise<EnsureFreeManagerResult> {
  const trialForNewManager = opts?.trialForNewManager !== false;
  const allowResidentUpgrade = opts?.allowResidentUpgrade === true;
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) return { status: "skipped", reason: "no_email" };
  if (!allowResidentUpgrade && (await isResidentOnlyAccount(supabase, user.id))) {
    return { status: "skipped", reason: "resident_only" };
  }

  const fullName = oauthFullName(user);
  const purchase = await findManagerPurchaseForAccount(supabase, user.id, email);

  if (purchase && isManagerOnboardingComplete(purchase)) {
    // A completed purchase matched by email/user id always ends up holding the
    // manager role row — an account reached through this branch (e.g. a
    // resident upgrading via a completed purchase on their email) must not
    // stay without one.
    await ensureProfileRoleRow(supabase, user.id, "manager");
    try {
      const { scheduleManagerMessagingReady } = await import("@/lib/proplane-sms-transport.server");
      scheduleManagerMessagingReady(user.id);
    } catch {
      /* non-critical */
    }
    return { status: "portal_ready", managerId: purchase.manager_id, provisioned: false };
  }

  const { data: unlinkedPaid } = await supabase
    .from("manager_purchases")
    .select("id")
    .ilike("email", email)
    .is("user_id", null)
    .not("paid_at", "is", null)
    .limit(1);
  if (unlinkedPaid?.length) return { status: "skipped", reason: "unlinked_paid_purchase" };

  let managerId: string;
  let provisioned = false;

  if (purchase && isAxisPendingSessionId(purchase.stripe_checkout_session_id)) {
    const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    await supabase.from("profiles").upsert(
      {
        id: user.id,
        email,
        role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
        manager_id: purchase.manager_id,
        full_name: fullName || existingProfile?.full_name?.trim() || purchase.full_name || null,
        application_approved: existingProfile?.application_approved ?? true,
      },
      { onConflict: "id" },
    );
    await ensureProfileRoleRow(supabase, user.id, "manager");
    if (!purchase.user_id) {
      await supabase.from("manager_purchases").update({ user_id: user.id }).eq("id", purchase.id);
    }
    await finalizePendingManagerFreeTier(supabase, {
      userId: user.id,
      email,
      tier: "free",
      billing: "monthly",
      fullName,
    });
    managerId = purchase.manager_id;
    provisioned = true;
  } else if (!purchase) {
    // Genuinely new account: no manager_purchases row for this user or email.
    const { managerId: pendingId } = await provisionPendingManagerAccount(supabase, {
      userId: user.id,
      email,
      fullName,
    });
    await finalizePendingManagerFreeTier(
      supabase,
      trialForNewManager
        ? { userId: user.id, email, tier: "pro", billing: "trial", fullName }
        : { userId: user.id, email, tier: "free", billing: "monthly", fullName },
    );
    managerId = pendingId;
    provisioned = true;
  } else {
    managerId = purchase.manager_id;
    const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    await supabase.from("profiles").upsert(
      {
        id: user.id,
        email,
        role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
        manager_id: managerId,
        full_name: fullName || existingProfile?.full_name?.trim() || purchase.full_name || null,
        application_approved: existingProfile?.application_approved ?? true,
      },
      { onConflict: "id" },
    );
    await ensureProfileRoleRow(supabase, user.id, "manager");
    if (!purchase.user_id) {
      await supabase.from("manager_purchases").update({ user_id: user.id }).eq("id", purchase.id);
    }
    await finalizePendingManagerFreeTier(supabase, {
      userId: user.id,
      email,
      tier: "free",
      billing: "monthly",
      fullName,
    });
    provisioned = true;
  }

  try {
    const { scheduleManagerMessagingReady } = await import("@/lib/proplane-sms-transport.server");
    scheduleManagerMessagingReady(user.id);
  } catch {
    /* non-critical */
  }

  if (provisioned) {
    await markGoogleServicesOnboardingPending(supabase, user.id).catch(() => undefined);
  }

  return { status: "portal_ready", managerId, provisioned };
}
