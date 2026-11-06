import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { NextResponse } from "next/server";
import { recoverySetupRedirect } from "@/lib/auth/account-recovery.server";
import { LAST_PORTAL_COOKIE, lastPortalCookieOptions, portalRoleForPath } from "@/lib/auth/last-portal";
import { ACTIVE_PORTAL_COOKIE } from "@/lib/auth/portal-access";
import type { AuthRole } from "@/lib/auth/portal-roles";
import type { OAuthSignInIntent, OAuthSurface } from "@/lib/auth/post-oauth-routing";
import { reconcileAuthAccountsByEmail } from "@/lib/auth/reconcile-auth-accounts-by-email";
import { finalizeOAuthPortalRedirect } from "@/lib/auth/resolve-oauth-portal-access";

export type PostSignInDestination = {
  redirectTo: string;
  /** A multi-role account was opened straight into this portal (the one this device used last): pin it active. */
  openedRole: AuthRole | null;
  /** The portal `redirectTo` enters, only when the account holds that role: what to remember as "last portal". */
  landedRole: AuthRole | null;
};

/**
 * The ONE decision "where does this freshly signed-in user go", shared by `/api/auth/oauth-portal-access` (every sign-in
 * method, via `/auth/continue`) and the phone verify route (straight to the portal). Throws if a step cannot be read;
 * callers decide the fallback.
 */
export async function resolvePostSignInDestination(input: {
  service: SupabaseClient;
  user: User;
  intendedPath: string;
  intent?: OAuthSignInIntent | null;
  surface?: OAuthSurface | null;
  lastPortalRole?: string | null;
}): Promise<PostSignInDestination> {
  const { service, user } = input;
  const recovery = await recoverySetupRedirect(service, user.id);
  if (recovery) return { redirectTo: recovery, openedRole: null, landedRole: null };
  // Password sign-in reaches this resolver without an OAuth callback, so refresh this account's own
  // profile contact fields here too. An email is never ownership of another account: a same-address
  // login is a separate account and nothing crosses between them.
  try {
    await reconcileAuthAccountsByEmail(service, user);
  } catch (reconcileError) {
    console.error("[oauth-portal-access] reconcileAuthAccountsByEmail failed:", reconcileError);
  }
  const trace: { roles?: AuthRole[]; openedLastPortal?: AuthRole | null } = {};
  const redirectTo = await finalizeOAuthPortalRedirect(service, user, input.intendedPath, {
    intent: input.intent ?? null,
    surface: input.surface ?? null,
    lastPortalRole: input.lastPortalRole ?? null,
    trace,
  });
  const entered = portalRoleForPath(redirectTo);
  return {
    redirectTo,
    openedRole: trace.openedLastPortal ?? null,
    landedRole: entered && trace.roles?.includes(entered) ? entered : null,
  };
}

/** Pin a remembered portal active (multi-role accounts need the active cookie to enter it) and remember the portal just entered. */
export function applyPortalCookies(
  res: NextResponse,
  destination: Pick<PostSignInDestination, "openedRole" | "landedRole">,
  secure: boolean,
) {
  if (destination.openedRole) {
    res.cookies.set(ACTIVE_PORTAL_COOKIE, destination.openedRole, {
      httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365, secure,
    });
  }
  if (destination.landedRole) res.cookies.set(LAST_PORTAL_COOKIE, destination.landedRole, lastPortalCookieOptions(secure));
}
