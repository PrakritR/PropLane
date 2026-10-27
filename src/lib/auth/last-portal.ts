import type { AuthRole } from "@/lib/auth/portal-roles";

/**
 * The portal this DEVICE opened last (role string only, never an id). httpOnly, one year, set by the two server doors
 * that open a portal (`/api/auth/set-active-portal` and the post-sign-in resolver) and deliberately kept across
 * sign-out: it is a device memory, not session state. A multi-role sign-in opens it ONLY if `profile_roles` still
 * grants that role; anything else falls back to the portal chooser.
 */
export const LAST_PORTAL_COOKIE = "pl_last_portal";
export const LAST_PORTAL_MAX_AGE_S = 60 * 60 * 24 * 365;

export function parseLastPortal(raw: string | null | undefined): AuthRole | null {
  const value = raw?.trim() ?? "";
  return value === "resident" || value === "manager" || value === "admin" || value === "vendor" ? value : null;
}

/** The last portal, but only when the account still holds it. */
export function pickLastPortal(roles: readonly AuthRole[], last: string | null | undefined): AuthRole | null {
  const role = parseLastPortal(last);
  return role && roles.includes(role) ? role : null;
}

/** Which portal a post-auth path opens, or null for auth/onboarding paths. */
export function portalRoleForPath(path: string): AuthRole | null {
  const pathname = path.split(/[?#]/)[0] ?? "";
  if (pathname === "/portal" || pathname.startsWith("/portal/") || pathname === "/pro" || pathname.startsWith("/pro/")) return "manager";
  if (pathname === "/resident" || pathname.startsWith("/resident/")) return "resident";
  if (pathname === "/vendor" || pathname.startsWith("/vendor/")) return "vendor";
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return "admin";
  return null;
}

export function lastPortalCookieOptions(secure: boolean) {
  return { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: LAST_PORTAL_MAX_AGE_S, secure };
}
