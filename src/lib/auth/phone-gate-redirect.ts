import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";
import { phoneGateHrefCarrying } from "@/lib/auth/phone-gate-href";

/**
 * The same-origin `redirectTo` a portal route answered with when the phone gate applies, else null.
 *
 * `requestedPath` is the page the caller was heading to (its own `?next=`), carried onto the bare gate the API
 * route had to answer with.
 */
export function phoneGateRedirectTo(body: unknown, requestedPath?: string | null): string | null {
  const value = (body as { redirectTo?: unknown } | null)?.redirectTo;
  if (typeof value !== "string" || isUnsafeRedirectPath(value)) return null;
  return phoneGateHrefCarrying(value, requestedPath);
}
