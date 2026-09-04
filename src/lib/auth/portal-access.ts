import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import type { AuthRole } from "@/components/auth/portal-switcher";
import { normalizePortalRoles } from "@/lib/auth/portal-roles";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getServerSessionProfile, type ServerProfile } from "@/lib/auth/server-profile";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import { isProductionRuntime } from "@/lib/server-env";

export const ACTIVE_PORTAL_COOKIE = "axis_active_portal";

export { normalizePortalRoles } from "@/lib/auth/portal-roles";

export type PortalAccessContext = {
  user: { id: string; email?: string | null } | null;
  profile: ServerProfile | null;
  roles: AuthRole[];
  effectiveRole: AuthRole | null;
};

function isAuthRole(value: string): value is AuthRole {
  return value === "resident" || value === "manager" || value === "admin" || value === "vendor";
}

function mapLegacyPortalRole(role: string | null | undefined): AuthRole | null {
  const value = String(role ?? "").toLowerCase();
  if (value === "owner") return "manager";
  return isAuthRole(value) ? value : null;
}

function normalizeRoles(
  rows: { role: string }[] | null | undefined,
  fallbackRole: string | null | undefined,
): AuthRole[] {
  return normalizePortalRoles(rows, fallbackRole);
}

/**
 * Roles from profile_roles (or legacy profiles.role), plus which portal is active via cookie when multi-role.
 */
export const getPortalAccessContext = cache(async (): Promise<PortalAccessContext> => {
  const base = await getServerSessionProfile();
  if (!base.user) {
    return { user: null, profile: null, roles: [], effectiveRole: null };
  }

  const fallbackRole = base.profile?.role ?? null;

  let roles: AuthRole[];
  try {
    const supabase = await createSupabaseServerClient();
    const { data: roleRows, error: roleErr } = await supabase.from("profile_roles").select("role").eq("user_id", base.user.id);
    roles = roleErr ? normalizeRoles(null, fallbackRole) : normalizeRoles(roleRows, fallbackRole);
  } catch {
    roles = normalizeRoles(null, fallbackRole);
  }

  let cookieRole: AuthRole | null = null;
  try {
    const c = await cookies();
    const cookieRaw = c.get(ACTIVE_PORTAL_COOKIE)?.value?.trim() ?? "";
    cookieRole = isAuthRole(cookieRaw) ? cookieRaw : null;
  } catch {
    cookieRole = null;
  }

  let effectiveRole: AuthRole | null;
  if (roles.length === 1) {
    effectiveRole = roles[0]!;
  } else {
    effectiveRole = cookieRole && roles.includes(cookieRole) ? cookieRole : null;
  }

  return {
    user: base.user,
    profile: base.profile,
    roles,
    effectiveRole,
  };
});

export function hasRole(ctx: PortalAccessContext, role: AuthRole): boolean {
  return ctx.roles.includes(role);
}

export function hasAdminRole(ctx: PortalAccessContext): boolean {
  return hasRole(ctx, "admin");
}

/**
 * In the live production deployment an admin (founder/ops) identity must NOT be
 * able to cross into the manager/property portal — an ops account should never
 * operate as a landlord on the real site. The block is lifted outside
 * production (local, preview) so day-to-day and staging work is unaffected, and
 * it keys on the `admin` role, which genuine manager accounts never hold, so
 * real managers are untouched.
 *
 * The sole primary admin (`PRIMARY_ADMIN_EMAIL`) is exempt: that account is
 * intentionally both ops and property manager on production.
 */
export function adminBlockedFromManagerPortal(ctx: PortalAccessContext): boolean {
  if (isPrimaryAdminEmail(ctx.user?.email)) return false;
  return hasAdminRole(ctx) && isProductionRuntime();
}

/**
 * Whether `role`'s portal is reachable for this account given the current
 * runtime. Layered on top of role membership: a role the account does not hold
 * is never reachable, and the production admin→manager block above removes
 * `manager` for admin identities. This is the single source of truth for both
 * hiding the portal switch and refusing the server-side switch/route.
 */
export function isPortalRoleReachable(ctx: PortalAccessContext, role: AuthRole): boolean {
  if (!hasRole(ctx, role)) return false;
  if (role === "manager" && adminBlockedFromManagerPortal(ctx)) return false;
  return true;
}

/** Roles whose portals this account may actually enter in the current runtime. */
export function reachablePortalRoles(ctx: PortalAccessContext): AuthRole[] {
  return ctx.roles.filter((role) => isPortalRoleReachable(ctx, role));
}

/**
 * Server-side guard for the manager/property portal layout. Ensures a
 * production admin identity cannot load the property portal by typing the URL,
 * not merely by having the switch hidden. Genuine managers and non-production
 * runtimes are unaffected.
 */
export async function assertPropertyPortalAccess() {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) return; // middleware handles the unauthenticated case for /portal/*
  if (adminBlockedFromManagerPortal(ctx)) {
    redirect("/admin/dashboard");
  }
}

export async function assertAdminPortalAccess() {
  const ctx = await getPortalAccessContext();
  if (!ctx.user) redirect("/auth/sign-in");
  if (!hasAdminRole(ctx)) redirect("/auth/sign-in");
  /** Admin routes use profile_roles admin membership only. Do not require `axis_active_portal=admin`:
   *  multi-role admin+manager users otherwise bounce /admin → /pro → /admin when preview cookies are unset. */
}
