import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import { safeNextPath } from "@/lib/auth/safe-next-path";

/** The verify screen itself, with nothing carried. */
export const PHONE_GATE_PATH = "/auth/verify-phone";

/**
 * Where the phone-required gate sends an unverified account, carrying the page it was heading to.
 *
 * `requestedPath` is the middleware-stamped `x-requested-path` (the caller can never supply it). It is still
 * validated as a same-origin relative path, and the auth screens and API routes are never carried: those would
 * loop the gate back onto itself or hand the verify screen something that is not a destination.
 */
export function phoneGateHref(requestedPath: string | null | undefined): string {
  const next = safeNextPath(requestedPath);
  if (!next || isUnsafeRedirectPath(next)) return PHONE_GATE_PATH;
  const path = next.split(/[?#]/)[0] ?? "";
  if (path === "/auth" || path.startsWith("/auth/") || path === "/api" || path.startsWith("/api/")) {
    return PHONE_GATE_PATH;
  }
  return `${PHONE_GATE_PATH}?next=${encodeURIComponent(next)}`;
}

/**
 * A JSON route's `x-requested-path` is its own `/api/...` path, which the gate refuses to carry, so such a route
 * always answers the bare gate. The page that made the call knows where the person was actually heading: this adds
 * it through the same rule, and leaves any gate href that already carries a destination untouched.
 */
export function phoneGateHrefCarrying(gateHref: string, requestedPath: string | null | undefined): string {
  if (gateHref !== PHONE_GATE_PATH) return gateHref;
  return phoneGateHref(requestedPath);
}
