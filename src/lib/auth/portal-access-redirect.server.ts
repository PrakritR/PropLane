import { NextResponse } from "next/server";
// Next exposes no public "is this a redirect?" check (`unstable_rethrow` rethrows, it does not inspect), so this reads
// the same internal helpers `redirect()` itself is built on.
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { isUnsafeRedirectPath } from "@/lib/auth/normalize-post-auth-path";

/** The same-origin path a caught `redirect()` was heading to, or null when it is not a redirect (or goes off-site). */
export function redirectTargetFromError(error: unknown): string | null {
  if (!isRedirectError(error)) return null;
  const target = getURLFromRedirectError(error);
  return isUnsafeRedirectPath(target) ? null : target;
}

/**
 * `getPortalAccessContext()` calls `redirect()` (the phone gate) and that throws. A JSON route has no page to redirect,
 * so it answers 403 with `redirectTo` for the client to follow, never the raw "NEXT_REDIRECT" message.
 * Returns null when the error is not a followable redirect.
 */
export function phoneGateJsonResponse(error: unknown): NextResponse | null {
  const redirectTo = redirectTargetFromError(error);
  if (!redirectTo) return null;
  return NextResponse.json({ error: "Verify your phone to continue.", redirectTo }, { status: 403 });
}
