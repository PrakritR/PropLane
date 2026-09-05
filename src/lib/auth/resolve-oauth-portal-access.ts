import type { AuthRole } from "@/components/auth/portal-switcher";
import { GET_STARTED_PATH } from "@/lib/auth/get-started-path";
import { MANAGER_PRICING_ENTRY_PATH } from "@/lib/auth/manager-pricing-entry-path";
import { normalizePostAuthPath } from "@/lib/auth/normalize-post-auth-path";
import { PASSWORD_RESET_NEXT_PATH } from "@/lib/auth/password-reset-url";
import { normalizePortalRoles } from "@/lib/auth/portal-access";
import { portalDashboardPath } from "@/lib/auth/portal-roles";
import {
  applyOAuthSurfaceToPath,
  defaultOAuthNextPath,
  isGenericOAuthContinuePath,
  resolvePostOAuthPathFromRoles,
  type OAuthSignInIntent,
  type OAuthSurface,
} from "@/lib/auth/post-oauth-routing";
import { completeResidentSignupFromOAuth } from "@/lib/auth/complete-resident-signup-oauth";
import {
  findManagerPurchaseForAccount,
  isManagerOnboardingComplete,
  managerNeedsPricingSelection,
} from "@/lib/auth/manager-onboarding";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { managerOauthFinishPath } from "@/lib/auth/manager-oauth-finish-path";
import { resolveManagerPortalEntryPath } from "@/lib/auth/manager-google-services-onboarding.server";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import { loadResidentPortalAccessState, residentPortalHomePath } from "@/lib/resident-portal-access";
import type { SupabaseClient, User } from "@supabase/supabase-js";

function isAuthRole(value: string): value is AuthRole {
  return value === "resident" || value === "manager" || value === "admin" || value === "vendor";
}

function isBypassOAuthGatePath(path: string): boolean {
  return (
    // A recovery session must land on the reset form, whatever role the account has.
    // Routing it through the portal gate sent residents to /resident/… and role-less
    // accounts to Get started, so the user was signed in but never shown the form.
    path === PASSWORD_RESET_NEXT_PATH ||
    path.startsWith("/auth/manager-") ||
    path.startsWith("/auth/resident-") ||
    path.startsWith("/auth/vendor-") ||
    path.startsWith("/partner/pricing") ||
    path.startsWith(MANAGER_PRICING_ENTRY_PATH) ||
    path.startsWith("/auth/create-account") ||
    path.startsWith("/auth/callback/") ||
    path === "/auth/manager-register-oauth" ||
    path.startsWith("/auth/connect-google-services")
  );
}

async function managerPortalDestination(
  supabase: SupabaseClient,
  userId: string,
  safeIntended: string,
): Promise<string> {
  if (
    safeIntended.startsWith("/auth/continue") ||
    safeIntended.startsWith("/resident/") ||
    safeIntended === "/partner/pricing" ||
    safeIntended.startsWith("/partner/pricing")
  ) {
    return resolveManagerPortalEntryPath(supabase, userId);
  }
  if (safeIntended === portalDashboardPath("manager") || safeIntended.startsWith("/portal/dashboard")) {
    return resolveManagerPortalEntryPath(supabase, userId);
  }
  return safeIntended;
}

function applicationBucket(rowData: unknown): string {
  if (!rowData || typeof rowData !== "object" || Array.isArray(rowData)) return "";
  return String((rowData as Record<string, unknown>).bucket ?? "").toLowerCase();
}

/** Primary admin signing up or continuing as a property manager — not ops admin. */
function primaryAdminWantsManagerPortal(
  intent: OAuthSignInIntent | null | undefined,
  safeIntended: string,
): boolean {
  if (intent === "manager") return true;
  if (safeIntended.startsWith("/portal") || safeIntended.startsWith("/pro")) return true;
  if (safeIntended.startsWith("/auth/create-account") && safeIntended.includes("role=manager")) return true;
  if (safeIntended.startsWith(MANAGER_PRICING_ENTRY_PATH) || safeIntended.startsWith("/partner/pricing")) {
    return true;
  }
  return false;
}

async function finishPrimaryAdminManagerPortal(
  supabase: SupabaseClient,
  userId: string,
  safeIntended: string,
  finish: (path: string) => string,
): Promise<string> {
  await ensureProfileRoleRow(supabase, userId, "manager");
  return finish(await managerPortalDestination(supabase, userId, safeIntended));
}

/**
 * After Google OAuth, decide where the user may go.
 * Unknown accounts → free manager portal. Residents need an application. Managers use their tier.
 */
export async function resolveOAuthPortalRedirect(
  supabase: SupabaseClient,
  user: User,
  intendedPath: string,
  options?: {
    intent?: OAuthSignInIntent | null;
    surface?: OAuthSurface | null;
  },
): Promise<string> {
  const intent = options?.intent ?? null;
  const surface = options?.surface ?? null;
  const safeIntended = normalizePostAuthPath(
    intendedPath.startsWith("/") ? intendedPath : defaultOAuthNextPath(intent),
  );

  function finish(path: string): string {
    return applyOAuthSurfaceToPath(path, surface);
  }

  if (isBypassOAuthGatePath(safeIntended)) {
    return finish(safeIntended);
  }

  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) {
    return finish(MANAGER_PRICING_ENTRY_PATH);
  }

  const [{ data: roleRows }, { data: profile }] = await Promise.all([
    supabase.from("profile_roles").select("role").eq("user_id", user.id),
    supabase.from("profiles").select("role, manager_id, full_name, application_approved").eq("id", user.id).maybeSingle(),
  ]);
  const roles = normalizePortalRoles(roleRows, profile?.role);

  // Multi-role users (e.g. admin+manager) always pick their portal explicitly — the chooser
  // must never be skipped by a single-role branch below.
  if (roles.length > 1) {
    if (isPrimaryAdminEmail(email) && primaryAdminWantsManagerPortal(intent, safeIntended)) {
      return await finishPrimaryAdminManagerPortal(supabase, user.id, safeIntended, finish);
    }
    return finish(resolvePostOAuthPathFromRoles(roles, safeIntended));
  }

  const soleRole = roles[0] ?? null;
  if (soleRole === "resident") {
    const access = await loadResidentPortalAccessState({
      userId: user.id,
      role: "resident",
      email,
    });
    const home = residentPortalHomePath(access);
    if (isGenericOAuthContinuePath(safeIntended) || safeIntended === "/resident/dashboard" || safeIntended === "/resident") {
      return finish(home);
    }
    return finish(resolvePostOAuthPathFromRoles(roles, safeIntended));
  }
  if (soleRole === "admin" || soleRole === "vendor") {
    if (soleRole === "admin" && isPrimaryAdminEmail(email) && primaryAdminWantsManagerPortal(intent, safeIntended)) {
      return await finishPrimaryAdminManagerPortal(supabase, user.id, safeIntended, finish);
    }
    return finish(resolvePostOAuthPathFromRoles(roles, safeIntended));
  }
  if (soleRole === "manager") {
    if (await managerNeedsPricingSelection(supabase, user.id, email)) {
      return finish(MANAGER_PRICING_ENTRY_PATH);
    }
    return finish(await managerPortalDestination(supabase, user.id, safeIntended));
  }

  if (isPrimaryAdminEmail(email)) {
    if (primaryAdminWantsManagerPortal(intent, safeIntended)) {
      return await finishPrimaryAdminManagerPortal(supabase, user.id, safeIntended, finish);
    }
    return finish(isGenericOAuthContinuePath(safeIntended) ? portalDashboardPath("admin") : safeIntended);
  }

  const linkedPurchase = await findManagerPurchaseForAccount(supabase, user.id, email);
  if (linkedPurchase && !isManagerOnboardingComplete(linkedPurchase)) {
    return finish(MANAGER_PRICING_ENTRY_PATH);
  }
  if (linkedPurchase && isManagerOnboardingComplete(linkedPurchase)) {
    const { data: existingProfile } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    await supabase.from("profiles").upsert(
      {
        id: user.id,
        email,
        role: primaryRoleWhenAddingManager(existingProfile?.role as string | undefined),
        manager_id: existingProfile?.manager_id?.trim() || linkedPurchase.manager_id,
        full_name: existingProfile?.full_name ?? linkedPurchase.full_name ?? null,
        application_approved: existingProfile?.application_approved ?? true,
      },
      { onConflict: "id" },
    );
    await ensureProfileRoleRow(supabase, user.id, "manager");
    if (safeIntended.startsWith("/auth/continue")) {
      return finish(await resolveManagerPortalEntryPath(supabase, user.id));
    }
    return finish(safeIntended);
  }

  const { data: pendingPurchases } = await supabase
    .from("manager_purchases")
    .select("stripe_checkout_session_id, user_id, paid_at")
    .eq("email", email)
    .is("user_id", null)
    .order("paid_at", { ascending: false })
    .limit(1);

  const pendingPurchase = pendingPurchases?.[0];
  if (pendingPurchase?.stripe_checkout_session_id && pendingPurchase.paid_at) {
    return finish(managerOauthFinishPath(pendingPurchase.stripe_checkout_session_id));
  }

  // Link by rental application (approved OR pending). A pending applicant lands in the
  // resident portal in a limited state — never bounced back to create-account.
  const { data: applicationRows } = await supabase
    .from("manager_application_records")
    .select("id, resident_email, row_data")
    .eq("resident_email", email);

  const approvedApplication = (applicationRows ?? []).find((row) => applicationBucket(row.row_data) === "approved");
  const linkableApplication = approvedApplication ?? (applicationRows ?? [])[0];
  if (linkableApplication) {
    const linked = await completeResidentSignupFromOAuth(supabase, user.id, email, linkableApplication.id);
    if (linked.ok) {
      const access = await loadResidentPortalAccessState({
        userId: user.id,
        role: "resident",
        email,
      });
      return finish(residentPortalHomePath(access));
    }
    const params = new URLSearchParams({ role: "resident", message: "resident_signup_failed" });
    if (linked.error) params.set("error", linked.error);
    return finish(`/auth/create-account?${params.toString()}`);
  }

  // Unknown account: no role, no purchase, no application.
  //
  // A prospect who clicked "Apply" or a tour link arrived carrying
  // `role=resident`, and the OAuth round trip preserves that as the sign-in
  // intent — so asking "how do you want to use PropLane?" here is re-asking a
  // question they already answered, on the far side of a Google redirect they
  // did not choose to take. The chooser honours a `role` it is handed, so it
  // provisions and moves on through the SAME path a manual pick would take.
  //
  // All three roles, because the chooser provisions each one exactly as a manual
  // pick would: manager lands on the PLAN chooser rather than being handed a
  // tier, resident on the apply flow, vendor through the self-serve vendor
  // registration. Nothing is granted here that a click on the same screen would
  // not have granted a second later (AXI-126).
  if (intent) {
    const params = new URLSearchParams({ role: intent });
    // Keep where they were going, so the detour through the chooser is invisible.
    if (!isGenericOAuthContinuePath(safeIntended)) params.set("next", safeIntended);
    return finish(`${GET_STARTED_PATH}?${params.toString()}`);
  }
  return finish(GET_STARTED_PATH);
}

/** Never return `/auth/continue` — callers need a concrete portal or chooser route. */
export async function finalizeOAuthPortalRedirect(
  supabase: SupabaseClient,
  user: User,
  intendedPath: string,
  options?: {
    intent?: OAuthSignInIntent | null;
    surface?: OAuthSurface | null;
  },
): Promise<string> {
  const resolved = normalizePostAuthPath(await resolveOAuthPortalRedirect(supabase, user, intendedPath, options));
  if (resolved !== "/auth/continue") return resolved;

  const email = user.email?.trim().toLowerCase() ?? "";
  const [{ data: roleRows }, { data: profile }] = await Promise.all([
    supabase.from("profile_roles").select("role").eq("user_id", user.id),
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  const roles = normalizePortalRoles(roleRows, profile?.role);
  if (roles.length === 1) {
    if (roles[0] === "resident") {
      const access = await loadResidentPortalAccessState({
        userId: user.id,
        role: "resident",
        email: user.email?.trim().toLowerCase() ?? "",
      });
      return residentPortalHomePath(access);
    }
    return portalDashboardPath(roles[0]!);
  }
  if (roles.length > 1) return "/auth/choose-portal";
  if (isPrimaryAdminEmail(email)) {
    return primaryAdminWantsManagerPortal(options?.intent, intendedPath)
      ? await resolveManagerPortalEntryPath(supabase, user.id)
      : portalDashboardPath("admin");
  }
  return GET_STARTED_PATH;
}
