import type { Session, SupabaseClient, User } from "@supabase/supabase-js";

import { isManagerOAuthPath } from "@/lib/auth/google-oauth-calendar";
import type { OAuthSignInIntent } from "@/lib/auth/post-oauth-routing";
import {
  loadGoogleCalendarConnection,
  saveGoogleCalendarConnection,
} from "@/lib/google-calendar/settings";
import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";

/** True when this login used Google OAuth (not merely a @gmail.com address). */
export function signedInWithGoogle(user: User): boolean {
  if ((user.identities ?? []).some((identity) => identity.provider === "google")) return true;
  if (user.app_metadata?.provider === "google") return true;
  const providers = user.app_metadata?.providers;
  return Array.isArray(providers) && providers.includes("google");
}

async function userHasManagerPortalRole(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data: roles, error } = await db.from("profile_roles").select("role").eq("user_id", userId);
  if (error) return false;
  return (roles ?? []).some((row) => ["manager", "admin"].includes(String(row.role).toLowerCase()));
}

function shouldLinkForUser(
  intent: OAuthSignInIntent | null | undefined,
  nextPath: string | null | undefined,
  isManager: boolean,
): boolean {
  if (intent === "resident" || intent === "vendor") return false;
  if (intent === "manager") return true;
  if (nextPath && isManagerOAuthPath(null, nextPath)) return true;
  return isManager;
}

function debugCalendarLink(payload: Record<string, unknown>): void {
  debugGoogleCalendarLog("link-from-auth.server.ts", "google calendar auto-link", payload);
}

/**
 * After Google sign-in, persist this manager's personal calendar tokens when Supabase
 * returns provider tokens (requires calendar scopes on the sign-in OAuth request).
 */
export async function maybeLinkGoogleCalendarFromOAuthSession(
  db: SupabaseClient,
  user: User,
  session: Session,
  opts: { intent?: OAuthSignInIntent | null; nextPath?: string | null },
): Promise<{ linked: boolean; reason: string }> {
  const managerSuffix = user.id.slice(-6);
  if (!signedInWithGoogle(user)) {
    debugCalendarLink({ managerSuffix, reason: "not_google", intent: opts.intent, nextPath: opts.nextPath });
    return { linked: false, reason: "not_google" };
  }

  const isManager = await userHasManagerPortalRole(db, user.id);
  if (!shouldLinkForUser(opts.intent ?? null, opts.nextPath ?? null, isManager)) {
    debugCalendarLink({
      managerSuffix,
      reason: "not_manager",
      intent: opts.intent,
      nextPath: opts.nextPath,
      isManager,
    });
    return { linked: false, reason: "not_manager" };
  }

  const refreshToken = session.provider_refresh_token?.trim() || null;
  const accessToken = session.provider_token?.trim() || null;
  if (!refreshToken && !accessToken) {
    debugCalendarLink({
      managerSuffix,
      reason: "no_provider_token",
      intent: opts.intent,
      nextPath: opts.nextPath,
      hasRefresh: false,
      hasAccess: false,
    });
    return { linked: false, reason: "no_provider_token" };
  }

  const existing = await loadGoogleCalendarConnection(db, user.id);
  if (existing.connected && existing.refreshToken) {
    debugCalendarLink({ managerSuffix, reason: "already_connected", intent: opts.intent });
    return { linked: false, reason: "already_connected" };
  }

  try {
    await saveGoogleCalendarConnection(db, user.id, {
      connected: true,
      email: user.email?.trim() || existing.email,
      syncEnabled: true,
      refreshToken: refreshToken ?? existing.refreshToken,
      accessToken: accessToken ?? existing.accessToken,
      accessTokenExpiresAt: session.expires_at
        ? new Date(session.expires_at * 1000).toISOString()
        : existing.accessTokenExpiresAt,
      calendarId: existing.calendarId ?? "primary",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "save_failed";
    const schemaError = message.toLowerCase().includes("google_calendar") && message.toLowerCase().includes("does not exist");
    debugCalendarLink({ managerSuffix, reason: schemaError ? "schema_missing" : "save_failed", error: message, intent: opts.intent });
    return { linked: false, reason: schemaError ? "schema_missing" : "save_failed" };
  }

  debugCalendarLink({
    managerSuffix,
    reason: "linked",
    intent: opts.intent,
    nextPath: opts.nextPath,
    hasRefresh: Boolean(refreshToken),
    hasAccess: Boolean(accessToken),
  });
  return { linked: true, reason: "linked" };
}

/** After Google sign-in, start dedicated calendar OAuth when inline tokens were not returned. */
export function shouldRedirectToGoogleCalendarConnect(input: {
  linkResult: { linked: boolean; reason: string };
  resolvedPath: string;
  intent: OAuthSignInIntent | null | undefined;
  nextPath: string | null | undefined;
  googleAuthUser: boolean;
  calendarOAuthConfigured: boolean;
}): boolean {
  if (!input.calendarOAuthConfigured || !input.googleAuthUser) return false;
  if (input.linkResult.linked || input.linkResult.reason === "already_connected") return false;
  const destination = input.resolvedPath.trim();
  if (!destination.startsWith("/portal") && !destination.startsWith("/pro")) return false;
  if (input.intent === "resident" || input.intent === "vendor") return false;
  if (input.intent === "manager") return true;
  if (input.nextPath && isManagerOAuthPath(null, input.nextPath)) return true;
  return destination.startsWith("/portal") || destination.startsWith("/pro");
}
