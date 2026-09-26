import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type GoogleSheetsConnection,
  loadGoogleSheetsConnection,
  saveGoogleSheetsConnection,
} from "@/lib/manager-sheet-link";
import { googleCalendarOAuthRedirectUri } from "@/lib/google-calendar/api.server";
import {
  isGoogleCalendarOAuthConfigured,
  resolveGoogleCalendarOAuthConfig,
} from "@/lib/google-calendar/settings";

/**
 * Only the file you pick. `spreadsheets.readonly` and `drive.metadata.readonly`
 * are dropped: both are broader than one file, and `drive.metadata.readonly`
 * is Google-restricted, which is why the app is "blocked" for every manager
 * except the developer account today. `drive.file` grants access to exactly
 * the file the Picker returns (see `google-spreadsheet-picker.tsx`), and the
 * Sheets API honours that grant for reads on that same file — no separate
 * Sheets scope is needed. Google does not block or restrict `drive.file`, so
 * this needs no verification review. See memory
 * `proplane-google-oauth-blocked` and BUILD-WAVE2.md C210.
 */
export const GOOGLE_SHEETS_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export function googlePickerApiKey(): string | null {
  return (
    process.env.GOOGLE_PICKER_API_KEY?.trim() ||
    process.env.GOOGLE_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY?.trim() ||
    null
  );
}

/**
 * The Picker requires the requesting app's project number (`setAppId`) to
 * grant `drive.file` access to whatever the user picks — without it the
 * picker opens but the returned file id is not actually accessible to the
 * token. A Google OAuth client id is `<project-number>-xxxx.apps.googleusercontent.com`.
 */
export function googlePickerAppId(): string | null {
  const clientId = resolveGoogleCalendarOAuthConfig()?.clientId?.trim();
  const projectNumber = clientId?.split("-")[0]?.trim();
  return projectNumber && /^\d+$/.test(projectNumber) ? projectNumber : null;
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleSheetsPublicStatus(connection: GoogleSheetsConnection) {
  return {
    connected: connection.connected,
    email: connection.email,
    configured: isGoogleCalendarOAuthConfigured(),
    revoked: connection.revoked === true && !connection.connected,
  };
}

export function buildGoogleSheetsOAuthUrl(
  browserOrigin: string,
  state: string,
  opts?: { loginHint?: string | null },
): string {
  const config = resolveGoogleCalendarOAuthConfig();
  if (!config) throw new Error("Google Sheets OAuth is not configured.");
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: googleCalendarOAuthRedirectUri(browserOrigin),
    response_type: "code",
    scope: GOOGLE_SHEETS_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  const hint = opts?.loginHint?.trim();
  if (hint?.includes("@")) params.set("login_hint", hint);
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function googleAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { email?: string };
  return data.email?.trim() || null;
}

export async function exchangeGoogleSheetsCode(
  db: SupabaseClient,
  managerUserId: string,
  code: string,
  browserOrigin: string,
): Promise<GoogleSheetsConnection> {
  const config = resolveGoogleCalendarOAuthConfig();
  if (!config) throw new Error("Google Sheets OAuth is not configured.");
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: googleCalendarOAuthRedirectUri(browserOrigin),
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Could not connect Google Sheets.");
  }
  const existing = await loadGoogleSheetsConnection(db, managerUserId);
  const expiresAt =
    typeof data.expires_in === "number" ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null;
  return saveGoogleSheetsConnection(db, managerUserId, {
    connected: true,
    email: await googleAccountEmail(data.access_token),
    refreshToken: data.refresh_token ?? existing.refreshToken,
    accessToken: data.access_token,
    accessTokenExpiresAt: expiresAt,
  });
}

/** Why `getGoogleSheetsAccessToken` returned `null` — see `getGoogleSheetsAccessTokenDetailed`. */
export type GoogleSheetsAccessTokenFailureReason = "not_connected" | "revoked" | "transient_error";

const GOOGLE_REFRESH_TOKEN_DEAD_ERRORS = new Set(["invalid_grant", "invalid_token"]);

export type GoogleSheetsAccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; accessToken: null; reason: GoogleSheetsAccessTokenFailureReason };

/**
 * Classified counterpart of {@link getGoogleSheetsAccessToken}, for callers
 * (the picker-token route) that need to tell a manager "connect Google" apart
 * from "reconnect Google" apart from "Google is having trouble right now" —
 * the plain function collapses all three into `null`, which is fine for the
 * sheet-sync callers that only ever fall back to a public/unauthenticated
 * read on failure and do not show the manager anything about why.
 */
export async function getGoogleSheetsAccessTokenDetailed(
  db: SupabaseClient,
  managerUserId: string,
): Promise<GoogleSheetsAccessTokenResult> {
  if (!isGoogleCalendarOAuthConfigured()) return { ok: false, accessToken: null, reason: "not_connected" };
  let connection = await loadGoogleSheetsConnection(db, managerUserId);
  if (!connection.connected || !connection.refreshToken) {
    return { ok: false, accessToken: null, reason: "not_connected" };
  }
  const expiresAt = connection.accessTokenExpiresAt ? Date.parse(connection.accessTokenExpiresAt) : 0;
  if (connection.accessToken && expiresAt > Date.now() + 60_000) {
    return { ok: true, accessToken: connection.accessToken };
  }

  const config = resolveGoogleCalendarOAuthConfig();
  if (!config) return { ok: false, accessToken: null, reason: "not_connected" };
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: connection.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !data.access_token) {
    if (data.error && GOOGLE_REFRESH_TOKEN_DEAD_ERRORS.has(data.error)) {
      // Same proactive-disconnect contract as Calendar's `GoogleCalendarRevokedError`
      // handling: never leave `connected: true` on a dead refresh token.
      await saveGoogleSheetsConnection(db, managerUserId, {
        connected: false,
        refreshToken: null,
        accessToken: null,
        accessTokenExpiresAt: null,
        revoked: true,
      }).catch(() => undefined);
      return { ok: false, accessToken: null, reason: "revoked" };
    }
    return { ok: false, accessToken: null, reason: "transient_error" };
  }
  const nextExpires =
    typeof data.expires_in === "number" ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null;
  connection = await saveGoogleSheetsConnection(db, managerUserId, {
    accessToken: data.access_token,
    accessTokenExpiresAt: nextExpires,
    revoked: false,
  });
  return connection.accessToken
    ? { ok: true, accessToken: connection.accessToken }
    : { ok: false, accessToken: null, reason: "transient_error" };
}

export async function getGoogleSheetsAccessToken(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  return (await getGoogleSheetsAccessTokenDetailed(db, managerUserId)).accessToken;
}
