import { recoverySetupRedirect } from "@/lib/auth/account-recovery.server";
import { resolveRequestOrigin } from "@/lib/app-url";
import { reconcileAuthAccountsByEmail } from "@/lib/auth/reconcile-auth-accounts-by-email";
import { resolveOAuthPortalRedirect } from "@/lib/auth/resolve-oauth-portal-access";
import { clearOAuthNextCookie, readOAuthIntentFromRequest, readOAuthNextPathFromRequest, readOAuthSurfaceFromRequest } from "@/lib/auth/oauth-next-cookie";
import {
  OAUTH_CALLBACK_MISSING_CODE_MESSAGE,
  OAUTH_CALLBACK_SESSION_FAILED_MESSAGE,
  OAUTH_NOT_COMPLETED_MESSAGE,
} from "@/lib/auth/oauth-failure-messages";
import { PASSWORD_RESET_NEXT_PATH } from "@/lib/auth/password-reset-url";
import { maybeLinkGoogleCalendarFromOAuthSession } from "@/lib/google-calendar/link-from-auth.server";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";
import { warmGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import type { SupabaseClient, User } from "@supabase/supabase-js";

type PendingCookie = {
  name: string;
  value: string;
  options?: Parameters<NextResponse["cookies"]["set"]>[2];
};

export type OAuthCallbackOptions = {
  /** Override post-provision redirect (e.g. partner pricing tier routing). */
  resolveRedirect?: (
    service: SupabaseClient,
    user: User,
    safePath: string,
  ) => Promise<string>;
};

function authFailureRedirect(requestOrigin: string, reason: string): NextResponse {
  const params = new URLSearchParams({ error: "oauth", message: reason });
  return NextResponse.redirect(new URL(`/auth/sign-in?${params.toString()}`, requestOrigin));
}

/**
 * Password-reset links minted before the `/auth/confirm` flow shipped still land here
 * carrying a PKCE `code`, and that code can only be exchanged in the browser that
 * requested the reset. Failing those into the sign-in page's OAuth error banner told
 * the user their *Google sign-in* broke. Send them to the reset page instead, which
 * explains the expired link and offers a new one.
 */
function callbackFailureRedirect(requestOrigin: string, reason: string, targetPath: string): NextResponse {
  if (targetPath === PASSWORD_RESET_NEXT_PATH) {
    return NextResponse.redirect(new URL(PASSWORD_RESET_NEXT_PATH, requestOrigin));
  }
  return authFailureRedirect(requestOrigin, reason);
}

/** Exchange Supabase OAuth code for a session, then redirect to a same-origin path. */
export async function handleOAuthCallback(
  request: NextRequest,
  redirectPath: string,
  options?: OAuthCallbackOptions,
): Promise<NextResponse> {
  // Never build redirects from request.url — in dev it reflects the 0.0.0.0 bind
  // address, not the host the browser is on, which strands the user on a host
  // where their freshly-set session cookies don't exist.
  const requestOrigin = resolveRequestOrigin(request);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return NextResponse.redirect(new URL("/auth/sign-in", requestOrigin));
  }

  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const oauthError = requestUrl.searchParams.get("error");
  const oauthDescription = requestUrl.searchParams.get("error_description");
  const safePath = redirectPath.startsWith("/") ? redirectPath : "/auth/continue";

  if (oauthError) {
    // Keep the caller's redirect path (theirs) AND the allow-listed copy (ours): a message that
    // is not in `oauth-failure-messages.ts` degrades to the generic one at render time.
    const message = oauthDescription?.replace(/\+/g, " ").trim() || OAUTH_NOT_COMPLETED_MESSAGE;
    return callbackFailureRedirect(requestOrigin, message, safePath);
  }

  if (!code) {
    return callbackFailureRedirect(requestOrigin, OAUTH_CALLBACK_MISSING_CODE_MESSAGE, safePath);
  }

  const redirectTarget = new URL(safePath, requestOrigin);
  const pendingCookies: PendingCookie[] = [];
  let response = NextResponse.redirect(redirectTarget);

  function applyRedirect(target: URL) {
    response = NextResponse.redirect(target);
    pendingCookies.forEach(({ name, value, options }) => {
      response.cookies.set(name, value, options);
    });
  }

  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          pendingCookies.push({ name, value, options });
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const { data: sessionData, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error("OAuth callback exchange failed:", error.message);
    return callbackFailureRedirect(
      requestOrigin,
      error.message || OAUTH_CALLBACK_SESSION_FAILED_MESSAGE,
      safePath,
    );
  }

  if (safePath === PASSWORD_RESET_NEXT_PATH) {
    clearOAuthNextCookie(response);
    return response;
  }

  try {
    const user = sessionData.session?.user ?? (await supabase.auth.getUser()).data.user ?? null;
    if (user) {
      const service = createSupabaseServiceRoleClient();
      // Fail closed before provider linking or identity reconciliation.
      let recovery: string | null;
      try { recovery = await recoverySetupRedirect(service, user.id); }
      catch {
        applyRedirect(new URL("/auth/recover-account", requestOrigin));
        clearOAuthNextCookie(response);
        return response;
      }
      if (recovery) {
        applyRedirect(new URL(recovery, requestOrigin));
        clearOAuthNextCookie(response);
        return response;
      }
      const oauthIntent = readOAuthIntentFromRequest(request);
      const oauthNextPath = readOAuthNextPathFromRequest(request) ?? safePath;
      let linkResult = { linked: false, reason: "no_session" };
      if (sessionData.session) {
        await warmGoogleCalendarOAuthConfig();
        debugGoogleCalendarLog("oauth-callback-handler.ts", "oauth exchange session", {
          managerSuffix: user.id.slice(-6),
          hasRefresh: Boolean(sessionData.session.provider_refresh_token),
          hasAccess: Boolean(sessionData.session.provider_token),
          intent: oauthIntent,
          nextPath: oauthNextPath,
        });
        linkResult = await maybeLinkGoogleCalendarFromOAuthSession(service, user, sessionData.session, {
          intent: oauthIntent,
          nextPath: oauthNextPath,
        });
      }
      // Link any prior email/password account to this OAuth identity, then resolve the
      // destination ONCE. No auto free-manager provisioning — unknown users pick a role.
      await reconcileAuthAccountsByEmail(service, user);
      const resolvedPath = options?.resolveRedirect
        ? await options.resolveRedirect(service, user, safePath)
        : await resolveOAuthPortalRedirect(service, user, safePath, {
            intent: oauthIntent,
            surface: readOAuthSurfaceFromRequest(request),
          });
      debugGoogleCalendarLog("oauth-callback-handler.ts", "oauth callback resolved", {
        managerSuffix: user.id.slice(-6),
        linkReason: linkResult.reason,
        linked: linkResult.linked,
        resolvedPath,
      });
      if (resolvedPath !== safePath) {
        applyRedirect(new URL(resolvedPath, requestOrigin));
      }
    }
  } catch (syncError) {
    console.error("OAuth profile sync failed:", syncError);
  }

  clearOAuthNextCookie(response);
  return response;
}
