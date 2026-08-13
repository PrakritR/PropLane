import { createHmac, timingSafeEqual } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  isGoogleCalendarOAuthConfigured,
  warmGoogleCalendarOAuthConfig,
  resolveGoogleCalendarOAuthConfig,
} from "@/lib/google-calendar/settings";
import { resolveGoogleCalendarRedirectOrigin } from "@/lib/google-calendar/api.server";
import { sanitizeOAuthReturnPath } from "@/lib/auth/oauth-return-path";

import { GMAIL_PAYMENTS_OAUTH_SCOPES } from "./scopes";
import type { GmailPaymentTrackRole, ManagerPaymentReceiptChannel } from "./portal-role";
import {
  loadGmailPaymentsConnection,
  saveGmailPaymentsConnection,
  type GmailPaymentsConnection,
} from "./settings";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

function clientId(): string {
  void warmGoogleCalendarOAuthConfig();
  const id = resolveGoogleCalendarOAuthConfig()?.clientId;
  if (!id) throw new Error("Google OAuth is not configured.");
  return id;
}

function clientSecret(): string {
  const secret = resolveGoogleCalendarOAuthConfig()?.clientSecret;
  if (!secret) throw new Error("Google OAuth is not configured.");
  return secret;
}

function stateSecret(): string {
  return clientSecret();
}

export function isGmailPaymentsOAuthConfigured(): boolean {
  return isGoogleCalendarOAuthConfigured();
}

export function gmailPaymentsOAuthRedirectUri(browserOrigin: string, role: GmailPaymentTrackRole = "manager"): string {
  const base = resolveGoogleCalendarRedirectOrigin(browserOrigin);
  if (role === "vendor") return `${base}/api/vendor/gmail-payments/callback`;
  return `${base}/api/portal/gmail-payments/callback`;
}

export type GmailPaymentsOAuthState = {
  userId: string;
  returnOrigin: string;
  returnPath: string;
  role: GmailPaymentTrackRole;
  channel?: ManagerPaymentReceiptChannel;
};

function signOAuthState(
  userId: string,
  returnOrigin: string,
  role: GmailPaymentTrackRole,
  returnPath?: string,
  channel?: ManagerPaymentReceiptChannel,
): string {
  const payload = JSON.stringify({
    uid: userId,
    t: Date.now(),
    returnOrigin,
    kind: "gmail-payments",
    role,
    ...(returnPath ? { returnPath } : {}),
    ...(channel ? { channel } : {}),
  });
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return Buffer.from(`${payload}|${sig}`).toString("base64url");
}

export function verifyGmailPaymentsOAuthState(state: string): GmailPaymentsOAuthState | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const sep = decoded.lastIndexOf("|");
    if (sep < 0) return null;
    const payload = decoded.slice(0, sep);
    const sig = decoded.slice(sep + 1);
    const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(payload) as {
      uid?: string;
      t?: number;
      returnOrigin?: string;
      returnPath?: string;
      kind?: string;
      role?: GmailPaymentTrackRole;
      channel?: ManagerPaymentReceiptChannel;
    };
    if (parsed.kind !== "gmail-payments" || !parsed.uid || typeof parsed.t !== "number") return null;
    if (Date.now() - parsed.t > 15 * 60 * 1000) return null;
    const returnOrigin =
      typeof parsed.returnOrigin === "string" && parsed.returnOrigin.trim()
        ? parsed.returnOrigin.trim().replace(/\/$/, "")
        : null;
    if (!returnOrigin) return null;
    const role = parsed.role === "vendor" ? "vendor" : "manager";
    const channel = parsed.channel === "venmo" || parsed.channel === "zelle" ? parsed.channel : undefined;
    const defaultReturn = role === "vendor" ? "/vendor/payments" : "/portal/payments";
    return {
      userId: parsed.uid,
      returnOrigin,
      returnPath: sanitizeOAuthReturnPath(parsed.returnPath, defaultReturn),
      role,
      ...(channel ? { channel } : {}),
    };
  } catch {
    return null;
  }
}

export function buildGmailPaymentsOAuthUrl(
  browserOrigin: string,
  userId: string,
  role: GmailPaymentTrackRole = "manager",
  returnPath?: string,
  channel?: ManagerPaymentReceiptChannel,
): string {
  const returnOrigin = browserOrigin.replace(/\/$/, "");
  const redirectUri = gmailPaymentsOAuthRedirectUri(browserOrigin, role);
  const state = signOAuthState(userId, returnOrigin, role, returnPath, channel);
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_PAYMENTS_OAUTH_SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

async function fetchGoogleAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { email?: string };
  return data.email?.trim() || null;
}

export async function exchangeGmailPaymentsCode(
  db: SupabaseClient,
  userId: string,
  code: string,
  browserOrigin: string,
  role: GmailPaymentTrackRole = "manager",
  channel?: ManagerPaymentReceiptChannel,
): Promise<GmailPaymentsConnection> {
  const redirectUri = gmailPaymentsOAuthRedirectUri(browserOrigin, role);
  const body = new URLSearchParams({
    code,
    client_id: clientId(),
    client_secret: clientSecret(),
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
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
    const detail = data.error_description?.trim() || data.error || "Could not connect Gmail.";
    throw new Error(detail);
  }

  const email = await fetchGoogleAccountEmail(data.access_token);
  const expiresAt =
    typeof data.expires_in === "number"
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null;

  const existing = await loadGmailPaymentsConnection(db, userId, role, channel);
  return saveGmailPaymentsConnection(
    db,
    userId,
    role,
    {
      connected: true,
      email,
      refreshToken: data.refresh_token ?? existing.refreshToken,
      accessToken: data.access_token,
      accessTokenExpiresAt: expiresAt,
    },
    channel,
  );
}

async function refreshAccessToken(connection: GmailPaymentsConnection): Promise<{
  accessToken: string;
  expiresAt: string | null;
}> {
  if (!connection.refreshToken) throw new Error("Gmail session expired. Reconnect.");
  const body = new URLSearchParams({
    client_id: clientId(),
    client_secret: clientSecret(),
    refresh_token: connection.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description?.trim() || data.error || "Could not refresh Gmail session.");
  }
  return {
    accessToken: data.access_token,
    expiresAt:
      typeof data.expires_in === "number"
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : null,
  };
}

export async function ensureGmailPaymentsAccessToken(
  db: SupabaseClient,
  userId: string,
  role: GmailPaymentTrackRole = "manager",
  channel?: ManagerPaymentReceiptChannel,
): Promise<{ accessToken: string; connection: GmailPaymentsConnection }> {
  const connection = await loadGmailPaymentsConnection(db, userId, role, channel);
  if (!connection.connected || !connection.refreshToken) {
    throw new Error("Gmail is not connected.");
  }
  const expiresAt = connection.accessTokenExpiresAt
    ? Date.parse(connection.accessTokenExpiresAt)
    : 0;
  if (connection.accessToken && expiresAt > Date.now() + 60_000) {
    return { accessToken: connection.accessToken, connection };
  }
  const refreshed = await refreshAccessToken(connection);
  const next = await saveGmailPaymentsConnection(
    db,
    userId,
    role,
    {
      accessToken: refreshed.accessToken,
      accessTokenExpiresAt: refreshed.expiresAt,
    },
    channel,
  );
  return { accessToken: refreshed.accessToken, connection: next };
}

export type GmailMessageSummary = {
  id: string;
  fromEmail: string;
  subject: string;
  body: string;
};

function headerValue(headers: { name?: string; value?: string }[] | undefined, name: string): string {
  const hit = (headers ?? []).find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return hit?.value?.trim() ?? "";
}

function decodeGmailBody(payload: {
  mimeType?: string;
  body?: { data?: string };
  parts?: { mimeType?: string; body?: { data?: string }; parts?: unknown[] }[];
}): string {
  const decodePart = (data?: string) => {
    if (!data) return "";
    try {
      return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      return "";
    }
  };
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodePart(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/plain" && part.body?.data) {
      return decodePart(part.body.data);
    }
  }
  for (const part of payload.parts ?? []) {
    if (part.mimeType === "text/html" && part.body?.data) {
      const html = decodePart(part.body.data);
      return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  if (payload.body?.data) return decodePart(payload.body.data);
  return "";
}

export async function listPaymentReceiptMessages(
  accessToken: string,
  query: string,
  maxResults = 30,
): Promise<GmailMessageSummary[]> {
  const listUrl = new URL(`${GMAIL_API}/messages`);
  listUrl.searchParams.set("q", query);
  listUrl.searchParams.set("maxResults", String(maxResults));
  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) {
    const err = (await listRes.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(err.error?.message ?? "Could not list Gmail messages.");
  }
  const listData = (await listRes.json()) as { messages?: { id: string }[] };
  const ids = (listData.messages ?? []).map((m) => m.id).filter(Boolean);
  const out: GmailMessageSummary[] = [];
  for (const id of ids) {
    const msgRes = await fetch(`${GMAIL_API}/messages/${id}?format=full`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!msgRes.ok) continue;
    const msg = (await msgRes.json()) as {
      id?: string;
      payload?: { headers?: { name?: string; value?: string }[]; mimeType?: string; body?: { data?: string }; parts?: unknown[] };
    };
    const fromRaw = headerValue(msg.payload?.headers, "From");
    const fromEmail = fromRaw.match(/<([^>]+)>/)?.[1]?.trim() || fromRaw.trim();
    out.push({
      id: msg.id ?? id,
      fromEmail,
      subject: headerValue(msg.payload?.headers, "Subject"),
      body: decodeGmailBody((msg.payload ?? {}) as Parameters<typeof decodeGmailBody>[0]),
    });
  }
  return out;
}
