import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSensitiveValue, encryptSensitiveValue, isEncryptedSensitiveValue } from "@/lib/security/data-encryption";

import { debugGoogleCalendarLog } from "@/lib/google-calendar/debug-log.server";

export type GoogleCalendarConnection = {
  connected: boolean;
  email: string | null;
  /** When true, PropLane tours are pushed to Google and Google events appear here. */
  syncEnabled: boolean;
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  calendarId: string | null;
};

export const DEFAULT_GOOGLE_CALENDAR_CONNECTION: GoogleCalendarConnection = {
  connected: false,
  email: null,
  syncEnabled: true,
  refreshToken: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  calendarId: "primary",
};

function tokenContext(managerUserId: string, field: "accessToken" | "refreshToken") {
  return { purpose: "google-calendar-oauth", ownerId: managerUserId, recordId: managerUserId, field };
}

function openStoredConnection(raw: unknown, managerUserId: string): GoogleCalendarConnection {
  const connection = normalizeGoogleCalendarConnection(raw);
  for (const field of ["refreshToken", "accessToken"] as const) {
    const value = connection[field];
    if (value && isEncryptedSensitiveValue(value)) {
      connection[field] = decryptSensitiveValue(value, tokenContext(managerUserId, field));
    } else if (value && process.env.DATA_ENCRYPTION_REQUIRE_ENCRYPTED_READS === "true") {
      throw new Error("Unmigrated Google credentials cannot be used.");
    }
    // Legacy plaintext is READ-only compatibility while the backfill runs.
    // Every save below encrypts, even if the patch only changes syncEnabled.
  }
  return connection;
}

function sealConnection(connection: GoogleCalendarConnection, managerUserId: string): GoogleCalendarConnection {
  return {
    ...connection,
    refreshToken: connection.refreshToken
      ? encryptSensitiveValue(connection.refreshToken, tokenContext(managerUserId, "refreshToken")) : null,
    accessToken: connection.accessToken
      ? encryptSensitiveValue(connection.accessToken, tokenContext(managerUserId, "accessToken")) : null,
  };
}

export function normalizeGoogleCalendarConnection(raw: unknown): GoogleCalendarConnection {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const connected = r.connected === true && typeof r.refreshToken === "string" && r.refreshToken.trim().length > 0;
  return {
    connected,
    email: typeof r.email === "string" && r.email.trim() ? r.email.trim() : null,
    syncEnabled: r.syncEnabled !== false,
    refreshToken: connected ? String(r.refreshToken) : null,
    accessToken: typeof r.accessToken === "string" ? r.accessToken : null,
    accessTokenExpiresAt: typeof r.accessTokenExpiresAt === "string" ? r.accessTokenExpiresAt : null,
    calendarId: typeof r.calendarId === "string" && r.calendarId.trim() ? r.calendarId.trim() : "primary",
  };
}

/** Public-safe projection — never expose tokens to the browser. */
export function googleCalendarPublicStatus(
  connection: GoogleCalendarConnection,
  opts?: { googleAuthUser?: boolean; schemaReady?: boolean },
) {
  return {
    connected: connection.connected,
    email: connection.email,
    syncEnabled: connection.syncEnabled,
    configured: isGoogleCalendarOAuthConfigured(),
    schemaReady: opts?.schemaReady !== false,
    perManager: true,
    googleAuthUser: opts?.googleAuthUser === true,
  };
}

type CalendarStorageMode = "column" | "row_data";

let cachedStorageMode: CalendarStorageMode | null = null;

function isMissingGoogleCalendarColumnMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("google_calendar") && normalized.includes("does not exist");
}

function forceRowDataStorageMode(): CalendarStorageMode {
  cachedStorageMode = "row_data";
  debugGoogleCalendarLog("settings.ts:resolveCalendarStorageMode", "using row_data fallback", {
    hypothesisId: "H1",
    forced: true,
  });
  return cachedStorageMode;
}

async function resolveCalendarStorageMode(db: SupabaseClient): Promise<CalendarStorageMode> {
  if (cachedStorageMode) return cachedStorageMode;
  const { error } = await db.from("manager_automation_settings").select("google_calendar").limit(1);
  if (!error) {
    cachedStorageMode = "column";
    debugGoogleCalendarLog("settings.ts:resolveCalendarStorageMode", "using google_calendar column", {
      hypothesisId: "H1",
    });
    return cachedStorageMode;
  }
  if (isMissingGoogleCalendarColumnMessage(error.message)) {
    return forceRowDataStorageMode();
  }
  throw error;
}

async function loadGoogleCalendarConnectionFromRowData(
  db: SupabaseClient,
  managerUserId: string,
): Promise<GoogleCalendarConnection> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return openStoredConnection(rowDataRecord(data?.row_data).google_calendar ?? null, managerUserId);
}

function rowDataRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** True when calendar tokens can be stored (dedicated column or row_data fallback). */
export async function isGoogleCalendarSchemaReady(db: SupabaseClient): Promise<boolean> {
  try {
    await resolveCalendarStorageMode(db);
    return true;
  } catch {
    return false;
  }
}

export type GoogleCalendarOAuthConfig = {
  clientId: string;
  clientSecret: string;
};

let cachedDiscoveredClientId: string | null | undefined;

function envGoogleCalendarClientId(): string | null {
  return process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim() || null;
}

function envGoogleCalendarClientSecret(): string | null {
  return process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim() || null;
}

/** Same Google OAuth client as Supabase Auth — client ID is public in authorize redirects. */
export async function discoverGoogleOAuthClientId(): Promise<string | null> {
  const fromEnv = envGoogleCalendarClientId();
  if (fromEnv) {
    cachedDiscoveredClientId = fromEnv;
    return fromEnv;
  }
  if (cachedDiscoveredClientId !== undefined) return cachedDiscoveredClientId;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (!supabaseUrl || !anon) {
    cachedDiscoveredClientId = null;
    return null;
  }

  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/authorize?provider=google`, {
      headers: { apikey: anon, Authorization: `Bearer ${anon}` },
      redirect: "manual",
    });
    const location = res.headers.get("location") ?? "";
    const match = location.match(/client_id=([^&]+)/);
    cachedDiscoveredClientId = match ? decodeURIComponent(match[1]) : null;
  } catch {
    cachedDiscoveredClientId = null;
  }
  return cachedDiscoveredClientId;
}

export async function warmGoogleCalendarOAuthConfig(): Promise<GoogleCalendarOAuthConfig | null> {
  await discoverGoogleOAuthClientId();
  return resolveGoogleCalendarOAuthConfig();
}

/** App-level OAuth client (one per deployment). Each manager authorizes their personal Google account through it. */
export function resolveGoogleCalendarOAuthConfig(): GoogleCalendarOAuthConfig | null {
  const clientId = envGoogleCalendarClientId() ?? cachedDiscoveredClientId ?? null;
  const clientSecret = envGoogleCalendarClientSecret();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isGoogleCalendarOAuthConfigured(): boolean {
  const clientId = envGoogleCalendarClientId() ?? cachedDiscoveredClientId ?? null;
  return Boolean(clientId && envGoogleCalendarClientSecret());
}

export async function loadGoogleCalendarConnection(
  db: SupabaseClient,
  managerUserId: string,
): Promise<GoogleCalendarConnection> {
  const mode = await resolveCalendarStorageMode(db);
  if (mode === "column") {
    const { data, error } = await db
      .from("manager_automation_settings")
      .select("google_calendar")
      .eq("manager_user_id", managerUserId)
      .maybeSingle();
    if (error && isMissingGoogleCalendarColumnMessage(error.message)) {
      forceRowDataStorageMode();
      return loadGoogleCalendarConnectionFromRowData(db, managerUserId);
    }
    if (error) throw error;
    return openStoredConnection(data?.google_calendar ?? null, managerUserId);
  }

  return loadGoogleCalendarConnectionFromRowData(db, managerUserId);
}

export async function saveGoogleCalendarConnection(
  db: SupabaseClient,
  managerUserId: string,
  patch: Partial<GoogleCalendarConnection>,
): Promise<GoogleCalendarConnection> {
  // Disconnect must remain possible if a key was lost or ciphertext corrupted.
  // This path only erases credentials; it cannot disclose/decrypt anything.
  const disconnecting = patch.connected === false && patch.refreshToken === null && patch.accessToken === null;
  const current = disconnecting ? DEFAULT_GOOGLE_CALENDAR_CONNECTION : await loadGoogleCalendarConnection(db, managerUserId);
  const next = normalizeGoogleCalendarConnection({ ...current, ...patch });
  const stored = sealConnection(next, managerUserId);
  const mode = await resolveCalendarStorageMode(db);
  const updatedAt = new Date().toISOString();

  if (mode === "column") {
    const { error } = await db.from("manager_automation_settings").upsert(
      {
        manager_user_id: managerUserId,
        google_calendar: stored,
        updated_at: updatedAt,
      },
      { onConflict: "manager_user_id" },
    );
    if (error && isMissingGoogleCalendarColumnMessage(error.message)) {
      forceRowDataStorageMode();
    } else if (error) {
      throw error;
    } else {
      debugGoogleCalendarLog("settings.ts:saveGoogleCalendarConnection", "saved connection", {
        hypothesisId: "H4",
        mode: "column",
        connected: next.connected,
        managerSuffix: managerUserId.slice(-6),
      });
      return next;
    }
  }

  const { data: existing, error: readError } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (readError) throw readError;

  const row_data = {
    ...rowDataRecord(existing?.row_data),
    google_calendar: stored,
  };
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data,
      updated_at: updatedAt,
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  debugGoogleCalendarLog("settings.ts:saveGoogleCalendarConnection", "saved connection", {
    hypothesisId: "H4",
    mode: "row_data",
    connected: next.connected,
    managerSuffix: managerUserId.slice(-6),
  });
  return next;
}

export async function clearGoogleCalendarConnection(db: SupabaseClient, managerUserId: string): Promise<void> {
  await saveGoogleCalendarConnection(db, managerUserId, {
    ...DEFAULT_GOOGLE_CALENDAR_CONNECTION,
    connected: false,
    refreshToken: null,
    accessToken: null,
    accessTokenExpiresAt: null,
    email: null,
  });
}
