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
 * so it answers 403 with `redirectTo` for the client to follow, never the raw "NEXT_REDIRECT" message. An off-site
 * target is not followable, so it is dropped — but the answer is still the gate's own 403, never that message.
 * Returns null only when the error is not a redirect at all.
 */
export function phoneGateJsonResponse(error: unknown): NextResponse | null {
  if (!isRedirectError(error)) return null;
  const redirectTo = redirectTargetFromError(error);
  return NextResponse.json(
    redirectTo ? { error: "Verify your phone to continue.", redirectTo } : { error: "Verify your phone to continue." },
    { status: 403 },
  );
}
