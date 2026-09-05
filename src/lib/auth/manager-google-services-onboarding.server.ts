import type { SupabaseClient } from "@supabase/supabase-js";

import { MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH } from "@/lib/auth/manager-google-services-onboarding";
import { isGmailPaymentsOAuthConfigured } from "@/lib/gmail-payments/api.server";
import { loadGmailPaymentsConnection, managerHasAnyGmailPaymentsConnection } from "@/lib/gmail-payments/settings";
import {
  isGoogleCalendarOAuthConfigured,
  loadGoogleCalendarConnection,
  warmGoogleCalendarOAuthConfig,
} from "@/lib/google-calendar/settings";

const ROW_KEY = "googleServicesOnboarding";

type OnboardingRow = {
  dismissedAt?: string;
  /** Set when a manager account is first provisioned — gates the one-time setup screen. */
  pendingAt?: string;
};

function readOnboardingRow(rowData: unknown): OnboardingRow {
  const root = rowData && typeof rowData === "object" && !Array.isArray(rowData) ? (rowData as Record<string, unknown>) : {};
  const nested = root[ROW_KEY];
  const row = nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
  const dismissedAt = typeof row.dismissedAt === "string" && row.dismissedAt.trim() ? row.dismissedAt.trim() : undefined;
  const pendingAt = typeof row.pendingAt === "string" && row.pendingAt.trim() ? row.pendingAt.trim() : undefined;
  return { ...(dismissedAt ? { dismissedAt } : {}), ...(pendingAt ? { pendingAt } : {}) };
}

export async function isGoogleServicesOnboardingPending(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(readOnboardingRow(data?.row_data).pendingAt);
}

/** Call when a manager account is first provisioned so the setup screen may appear once. */
export async function markGoogleServicesOnboardingPending(db: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const rowData =
    data?.row_data && typeof data.row_data === "object" && !Array.isArray(data.row_data)
      ? { ...(data.row_data as Record<string, unknown>) }
      : {};
  const current = readOnboardingRow(rowData);
  if (current.dismissedAt || current.pendingAt) return;
  rowData[ROW_KEY] = { pendingAt: new Date().toISOString() };
  const { error: upsertErr } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: userId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (upsertErr) throw upsertErr;
}

export async function isGoogleServicesOnboardingDismissed(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(readOnboardingRow(data?.row_data).dismissedAt);
}

export async function dismissGoogleServicesOnboarding(db: SupabaseClient, userId: string): Promise<void> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const rowData =
    data?.row_data && typeof data.row_data === "object" && !Array.isArray(data.row_data)
      ? { ...(data.row_data as Record<string, unknown>) }
      : {};
  rowData[ROW_KEY] = { dismissedAt: new Date().toISOString() };
  const { error: upsertErr } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: userId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (upsertErr) throw upsertErr;
}

export async function loadGoogleServicesOnboardingStatus(
  db: SupabaseClient,
  userId: string,
): Promise<{
  dismissed: boolean;
  pending: boolean;
  calendarConnected: boolean;
  calendarConfigured: boolean;
  gmailConnected: boolean;
  gmailConfigured: boolean;
  calendarEmail: string | null;
  gmailEmail: string | null;
}> {
  await warmGoogleCalendarOAuthConfig();
  const [dismissed, pending, calendar, gmailConnected] = await Promise.all([
    isGoogleServicesOnboardingDismissed(db, userId),
    isGoogleServicesOnboardingPending(db, userId),
    loadGoogleCalendarConnection(db, userId),
    managerHasAnyGmailPaymentsConnection(db, userId),
  ]);
  const calendarConnected = calendar.connected && Boolean(calendar.refreshToken);
  const legacyGmail = await loadGmailPaymentsConnection(db, userId, "manager");
  return {
    dismissed,
    pending,
    calendarConnected,
    calendarConfigured: isGoogleCalendarOAuthConfigured(),
    gmailConnected,
    gmailConfigured: isGmailPaymentsOAuthConfigured(),
    calendarEmail: calendar.email,
    gmailEmail: legacyGmail.email,
  };
}

export async function resolveManagerPortalEntryPath(db: SupabaseClient, userId: string): Promise<string> {
  if (await isGoogleServicesOnboardingDismissed(db, userId)) {
    return "/portal/dashboard";
  }
  if (!(await isGoogleServicesOnboardingPending(db, userId))) {
    return "/portal/dashboard";
  }
  return MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH;
}
