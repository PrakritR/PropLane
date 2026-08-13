import type { SupabaseClient } from "@supabase/supabase-js";

import { isGoogleCalendarOAuthConfigured } from "@/lib/google-calendar/settings";

import {
  gmailPaymentsStorageKey,
  MANAGER_PAYMENT_RECEIPT_CHANNELS,
  type GmailPaymentTrackRole,
  type ManagerPaymentReceiptChannel,
} from "./portal-role";

export type GmailPaymentsConnection = {
  connected: boolean;
  email: string | null;
  refreshToken: string | null;
  accessToken: string | null;
  accessTokenExpiresAt: string | null;
  lastSyncAt: string | null;
  lastSyncMarkedPaid: number | null;
};

export const DEFAULT_GMAIL_PAYMENTS_CONNECTION: GmailPaymentsConnection = {
  connected: false,
  email: null,
  refreshToken: null,
  accessToken: null,
  accessTokenExpiresAt: null,
  lastSyncAt: null,
  lastSyncMarkedPaid: null,
};

export function normalizeGmailPaymentsConnection(raw: unknown): GmailPaymentsConnection {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const connected = r.connected === true && typeof r.refreshToken === "string" && r.refreshToken.trim().length > 0;
  return {
    connected,
    email: typeof r.email === "string" && r.email.trim() ? r.email.trim() : null,
    refreshToken: connected ? String(r.refreshToken) : null,
    accessToken: typeof r.accessToken === "string" ? r.accessToken : null,
    accessTokenExpiresAt: typeof r.accessTokenExpiresAt === "string" ? r.accessTokenExpiresAt : null,
    lastSyncAt: typeof r.lastSyncAt === "string" ? r.lastSyncAt : null,
    lastSyncMarkedPaid: typeof r.lastSyncMarkedPaid === "number" ? r.lastSyncMarkedPaid : null,
  };
}

export function gmailPaymentsPublicStatus(connection: GmailPaymentsConnection) {
  return {
    connected: connection.connected,
    email: connection.email,
    configured: isGoogleCalendarOAuthConfigured(),
    lastSyncAt: connection.lastSyncAt,
    lastSyncMarkedPaid: connection.lastSyncMarkedPaid,
  };
}

function rowDataRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

function readConnectionFromRowData(
  rowData: Record<string, unknown>,
  role: GmailPaymentTrackRole,
  channel?: ManagerPaymentReceiptChannel,
): GmailPaymentsConnection {
  const key = gmailPaymentsStorageKey(role, channel);
  const nested = rowData[key];
  if (nested) return normalizeGmailPaymentsConnection(nested);

  // Per-channel keys absent — fall back to the legacy single manager inbox.
  if (role === "manager" && channel) {
    if (rowData.gmailPaymentsManager) {
      return normalizeGmailPaymentsConnection(rowData.gmailPaymentsManager);
    }
    if (rowData.gmailPayments) {
      return normalizeGmailPaymentsConnection(rowData.gmailPayments);
    }
  }

  if (role === "manager" && !channel) {
    if (rowData.gmailPaymentsManager) {
      return normalizeGmailPaymentsConnection(rowData.gmailPaymentsManager);
    }
    if (rowData.gmailPayments) {
      return normalizeGmailPaymentsConnection(rowData.gmailPayments);
    }
  }

  return { ...DEFAULT_GMAIL_PAYMENTS_CONNECTION };
}

export async function loadGmailPaymentsConnection(
  db: SupabaseClient,
  userId: string,
  role: GmailPaymentTrackRole,
  channel?: ManagerPaymentReceiptChannel,
): Promise<GmailPaymentsConnection> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return readConnectionFromRowData(rowDataRecord(data?.row_data), role, channel);
}

/** Connected manager receipt inboxes — one per Zelle/Venmo channel, plus legacy single inbox. */
export async function listConnectedManagerReceiptChannels(
  db: SupabaseClient,
  userId: string,
): Promise<{ channel: ManagerPaymentReceiptChannel | null; connection: GmailPaymentsConnection }[]> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const rowData = rowDataRecord(data?.row_data);

  const out: { channel: ManagerPaymentReceiptChannel | null; connection: GmailPaymentsConnection }[] = [];
  for (const channel of MANAGER_PAYMENT_RECEIPT_CHANNELS) {
    const connection = readConnectionFromRowData(rowData, "manager", channel);
    if (connection.connected) {
      out.push({ channel, connection });
    }
  }

  if (out.length === 0) {
    const legacy = readConnectionFromRowData(rowData, "manager");
    if (legacy.connected) {
      out.push({ channel: null, connection: legacy });
    }
  }

  return out;
}

export async function managerHasAnyGmailPaymentsConnection(
  db: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const connected = await listConnectedManagerReceiptChannels(db, userId);
  return connected.length > 0;
}

export async function saveGmailPaymentsConnection(
  db: SupabaseClient,
  userId: string,
  role: GmailPaymentTrackRole,
  patch: Partial<GmailPaymentsConnection>,
  channel?: ManagerPaymentReceiptChannel,
): Promise<GmailPaymentsConnection> {
  const current = await loadGmailPaymentsConnection(db, userId, role, channel);
  const next = normalizeGmailPaymentsConnection({ ...current, ...patch });
  const { data: existing, error: readError } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (readError) throw readError;

  const row_data = rowDataRecord(existing?.row_data);
  const key = gmailPaymentsStorageKey(role, channel);
  row_data[key] = next;
  if (role === "manager" && !channel) {
    row_data.gmailPayments = next;
    row_data.gmailPaymentsManager = next;
  }

  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: userId,
      row_data,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return next;
}

export async function clearGmailPaymentsConnection(
  db: SupabaseClient,
  userId: string,
  role: GmailPaymentTrackRole,
  channel?: ManagerPaymentReceiptChannel,
): Promise<void> {
  await saveGmailPaymentsConnection(
    db,
    userId,
    role,
    {
      ...DEFAULT_GMAIL_PAYMENTS_CONNECTION,
      connected: false,
    },
    channel,
  );
}
