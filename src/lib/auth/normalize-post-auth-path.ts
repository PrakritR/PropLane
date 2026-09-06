import { portalDashboardPath, type AuthRole } from "@/lib/auth/portal-roles";
import { isCoManagerInvitePath } from "@/lib/co-manager-invite-path";

/** Legacy / misconfigured Supabase site URLs sometimes land on bare /dashboard. */
export function isBareDashboardPath(path: string): boolean {
  const p = path.trim();
  return p === "/dashboard" || p === "dashboard";
}

const REDIRECT_CHECK_ORIGIN = "https://axis-internal.invalid";

/** Protocol-relative, scheme, or backslash paths must never be used as post-auth redirects. */
export function isUnsafeRedirectPath(path: string): boolean {
  const trimmed = path.trim();
  if (!trimmed) return true;
  if (!trimmed.startsWith("/")) return true;
  if (trimmed.startsWith("//")) return true;
  if (trimmed.startsWith("/\\")) return true;
  if (/^\/https?:/i.test(trimmed)) return true;
  if (trimmed.includes("\\")) return true;

  if (/%2f/i.test(trimmed) || /%5c/i.test(trimmed)) {
    try {
      const decoded = decodeURIComponent(trimmed);
      if (decoded !== trimmed) return isUnsafeRedirectPath(decoded);
    } catch {
      return true;
    }
  }

  // Authoritative check: resolve the path exactly the way a browser resolves
  // `location.replace()` / `<a href>` and require it to stay on the SAME
  // origin. This is what actually catches obfuscated protocol-relative
  // bypasses that slip past the string checks above — e.g. a tab, newline, or
  // carriage return between the two slashes (`"/\t/evil.com"`) is stripped by
  // the URL spec's parser before resolution, so the string never literally
  // starts with `//`, yet the browser still navigates cross-origin. `new URL`
  // implements the same stripping, so comparing the resolved origin closes
  // every such variant in one check instead of enumerating each obfuscation.
  try {
    const resolved = new URL(trimmed, REDIRECT_CHECK_ORIGIN);
    if (resolved.origin !== REDIRECT_CHECK_ORIGIN) return true;
  } catch {
    return true;
  }

  return false;
}

function pathMatchesRole(path: string, role: AuthRole): boolean {
  if (isCoManagerInvitePath(path)) return true;
  if (role === "manager") return path.startsWith("/portal") || path.startsWith("/pro");
  if (role === "resident") return path.startsWith("/resident");
  if (role === "admin") return path.startsWith("/admin");
  return false;
}

function defaultPostAuthPath(role?: AuthRole): string {
  return role ? portalDashboardPath(role) : "/auth/continue";
}

/** Route through /auth/continue when portal access could not be resolved server-side. */
export function failClosedOAuthContinuePath(next: string): string {
  const safe = normalizePostAuthPath(next);
  if (safe === "/auth/continue") return "/auth/continue";
  return `/auth/continue?next=${encodeURIComponent(safe)}`;
}

/** Ensure post-auth redirects always use a safe same-origin portal route. */
export function normalizePostAuthPath(path: string, role?: AuthRole): string {
  const trimmed = path.trim();
  if (!trimmed || isBareDashboardPath(trimmed) || isUnsafeRedirectPath(trimmed)) {
    return defaultPostAuthPath(role);
  }
  if (!trimmed.startsWith("/")) return defaultPostAuthPath(role);
  if (role && !pathMatchesRole(trimmed, role)) {
    return portalDashboardPath(role);
  }
  return trimmed;
}
