import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";

/** The same-origin `redirectTo` a portal route answered with when the phone gate applies, else null. */
export function phoneGateRedirectTo(body: unknown): string | null {
  const value = (body as { redirectTo?: unknown } | null)?.redirectTo;
  return typeof value === "string" && !isUnsafeRedirectPath(value) ? value : null;
}
