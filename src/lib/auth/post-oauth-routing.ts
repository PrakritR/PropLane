import { MANAGER_PRICING_ENTRY_PATH } from "@/lib/auth/manager-pricing-entry-path";
import { portalDashboardPath, type AuthRole } from "@/lib/auth/portal-roles";
import { isCoManagerInvitePath } from "@/lib/co-manager-invite-path";

export type OAuthSignInIntent = "manager" | "resident" | "vendor";
export type OAuthSurface = "native" | "web";

export const OAUTH_INTENT_STORAGE_KEY = "axis_oauth_intent";
export const OAUTH_SURFACE_STORAGE_KEY = "axis_oauth_surface";
export const OAUTH_INTENT_COOKIE = "axis_oauth_intent";
export const OAUTH_SURFACE_COOKIE = "axis_oauth_surface";

const GENERIC_CONTINUE = "/auth/continue";

const NATIVE_WEB_PATH_MAP: Record<string, string> = {
  "/partner/pricing": MANAGER_PRICING_ENTRY_PATH,
  "/pricing": MANAGER_PRICING_ENTRY_PATH,
};

function isAuthRole(value: string): value is AuthRole {
  return value === "resident" || value === "manager" || value === "admin" || value === "vendor";
}

/** Default post-auth path for Google sign-in — matches website sign-in intent. */
export function defaultOAuthNextPath(intent?: OAuthSignInIntent | null): string {
  if (intent === "resident") return "/resident/applications/apply";
  if (intent === "vendor") return "/vendor/dashboard";
  if (intent === "manager") return portalDashboardPath("manager");
  return GENERIC_CONTINUE;
}

export function isGenericOAuthContinuePath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed === GENERIC_CONTINUE || trimmed.startsWith(`${GENERIC_CONTINUE}?`);
}

/** Map marketing URLs to in-app routes when OAuth completes in the native shell. */
export function mapPostOAuthPathForNative(path: string): string {
  try {
    const url = new URL(path, "http://local");
    const mapped = NATIVE_WEB_PATH_MAP[url.pathname];
    if (!mapped) return path;
    return `${mapped}${url.search}${url.hash}`;
  } catch {
    return NATIVE_WEB_PATH_MAP[path] ?? path;
  }
}

export function applyOAuthSurfaceToPath(path: string, surface: OAuthSurface | null | undefined): string {
  if (surface !== "native") return path;
  return mapPostOAuthPathForNative(path);
}

/**
 * When the server already knows portal roles, finish routing without another /auth/continue hop.
 */
export function resolvePostOAuthPathFromRoles(
  roles: AuthRole[],
  intendedPath: string,
): string {
  const safe = intendedPath.startsWith("/") ? intendedPath : GENERIC_CONTINUE;

  if (roles.length === 1 && isGenericOAuthContinuePath(safe)) {
    return portalDashboardPath(roles[0]!);
  }

  if (roles.length > 1 && isGenericOAuthContinuePath(safe)) {
    return "/auth/choose-portal";
  }

  if (roles.length === 1 && !roleMatchesPath(roles[0]!, safe)) {
    return portalDashboardPath(roles[0]!);
  }

  return safe;
}

function roleMatchesPath(role: AuthRole, path: string): boolean {
  if (isCoManagerInvitePath(path)) return true;
  if (role === "manager") return path.startsWith("/portal") || path.startsWith("/pro");
  if (role === "resident") return path.startsWith("/resident");
  if (role === "admin") return path.startsWith("/admin");
  if (role === "vendor") return path.startsWith("/vendor");
  return false;
}

export function parseOAuthSignInIntent(raw: string | null | undefined): OAuthSignInIntent | null {
  if (raw === "manager" || raw === "resident" || raw === "vendor") return raw;
  return null;
}

/** Sign-in hub: honor explicit `next`, otherwise default from URL `intent`. */
export function resolveSignInNextPath(nextFromUrl: string, intent: OAuthSignInIntent | null): string {
  const trimmed = nextFromUrl.trim();
  if (trimmed.startsWith("/")) return trimmed;
  return defaultOAuthNextPath(intent);
}

export function parseOAuthSurface(raw: string | null | undefined): OAuthSurface | null {
  if (raw === "native" || raw === "web") return raw;
  return null;
}
