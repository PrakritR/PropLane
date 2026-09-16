import type { OAuthSignInIntent } from "@/lib/auth/post-oauth-routing";

export function isManagerOAuthPath(intent: OAuthSignInIntent | null | undefined, nextPath: string): boolean {
  if (intent === "manager") return true;
  if (intent === "resident" || intent === "vendor") return false;
  const path = nextPath.trim();
  if (!path.startsWith("/")) return false;
  return (
    path.startsWith("/portal") ||
    path.startsWith("/pro") ||
    path.startsWith("/partner/pricing") ||
    path.startsWith("/auth/manager") ||
    path.startsWith("/pricing")
  );
}

/**
 * Google sign-in/sign-up does NOT request the Calendar scope — managers
 * connect it progressively on /auth/connect-google-services after account
 * creation so consent is explicit and scoped.
 */
export function shouldRequestGoogleCalendarOnSignIn(
  _intent: OAuthSignInIntent | null | undefined,
  _nextPath: string,
): boolean {
  return false;
}

export type GoogleSignInOAuthOptions = {
  scopes?: string;
  queryParams: { prompt: string; access_type?: string };
};

export function googleSignInOAuthOptions(
  _intent: OAuthSignInIntent | null | undefined,
  _nextPath: string,
): GoogleSignInOAuthOptions {
  return { queryParams: { prompt: "select_account" } };
}
