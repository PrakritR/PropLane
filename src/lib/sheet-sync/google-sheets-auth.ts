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

export const GOOGLE_SHEETS_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
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

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export function googleSheetsPublicStatus(connection: GoogleSheetsConnection) {
  return {
    connected: connection.connected,
    email: connection.email,
    configured: isGoogleCalendarOAuthConfigured(),
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

export async function getGoogleSheetsAccessToken(
  db: SupabaseClient,
  managerUserId: string,
): Promise<string | null> {
  if (!isGoogleCalendarOAuthConfigured()) return null;
  let connection = await loadGoogleSheetsConnection(db, managerUserId);
  if (!connection.connected || !connection.refreshToken) return null;
  const expiresAt = connection.accessTokenExpiresAt ? Date.parse(connection.accessTokenExpiresAt) : 0;
  if (connection.accessToken && expiresAt > Date.now() + 60_000) return connection.accessToken;

  const config = resolveGoogleCalendarOAuthConfig();
  if (!config) return null;
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
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !data.access_token) return null;
  const nextExpires =
    typeof data.expires_in === "number" ? new Date(Date.now() + data.expires_in * 1000).toISOString() : null;
  connection = await saveGoogleSheetsConnection(db, managerUserId, {
    accessToken: data.access_token,
    accessTokenExpiresAt: nextExpires,
  });
  return connection.accessToken;
}
