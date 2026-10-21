import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import { safeNextPath } from "@/lib/auth/safe-next-path";

/**
 * Where the phone-required gate sends an unverified account, carrying the page it was heading to.
 *
 * `requestedPath` is the middleware-stamped `x-requested-path` (the caller can never supply it). It is still
 * validated as a same-origin relative path, and the auth screens and API routes are never carried: those would
 * loop the gate back onto itself or hand the verify screen something that is not a destination.
 */
export function phoneGateHref(requestedPath: string | null | undefined): string {
  const next = safeNextPath(requestedPath);
  if (!next || isUnsafeRedirectPath(next)) return "/auth/verify-phone";
  const path = next.split(/[?#]/)[0] ?? "";
  if (path === "/auth" || path.startsWith("/auth/") || path === "/api" || path.startsWith("/api/")) {
    return "/auth/verify-phone";
  }
  return `/auth/verify-phone?next=${encodeURIComponent(next)}`;
}
