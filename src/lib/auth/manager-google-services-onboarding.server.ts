import type { SupabaseClient } from "@supabase/supabase-js";

import { MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH } from "@/lib/auth/manager-google-services-onboarding";
import { isGmailPaymentsOAuthConfigured } from "@/lib/gmail-payments/api.server";
import { loadGmailPaymentsConnection } from "@/lib/gmail-payments/settings";
import {
  isGoogleCalendarOAuthConfigured,
  loadGoogleCalendarConnection,
  warmGoogleCalendarOAuthConfig,
} from "@/lib/google-calendar/settings";

const ROW_KEY = "googleServicesOnboarding";

type OnboardingRow = {
  dismissedAt?: string;
};

function readOnboardingRow(rowData: unknown): OnboardingRow {
  const root = rowData && typeof rowData === "object" && !Array.isArray(rowData) ? (rowData as Record<string, unknown>) : {};
  const nested = root[ROW_KEY];
  const row = nested && typeof nested === "object" && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
  const dismissedAt = typeof row.dismissedAt === "string" && row.dismissedAt.trim() ? row.dismissedAt.trim() : undefined;
  return dismissedAt ? { dismissedAt } : {};
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
  calendarConnected: boolean;
  calendarConfigured: boolean;
  gmailConnected: boolean;
  gmailConfigured: boolean;
  calendarEmail: string | null;
  gmailEmail: string | null;
}> {
  await warmGoogleCalendarOAuthConfig();
  const [dismissed, calendar, gmail] = await Promise.all([
    isGoogleServicesOnboardingDismissed(db, userId),
    loadGoogleCalendarConnection(db, userId),
    loadGmailPaymentsConnection(db, userId, "manager"),
  ]);
  const calendarConnected = calendar.connected && Boolean(calendar.refreshToken);
  const gmailConnected = gmail.connected && Boolean(gmail.refreshToken);
  return {
    dismissed,
    calendarConnected,
    calendarConfigured: isGoogleCalendarOAuthConfigured(),
    gmailConnected,
    gmailConfigured: isGmailPaymentsOAuthConfigured(),
    calendarEmail: calendar.email,
    gmailEmail: gmail.email,
  };
}

export async function resolveManagerPortalEntryPath(db: SupabaseClient, userId: string): Promise<string> {
  if (await isGoogleServicesOnboardingDismissed(db, userId)) {
    return "/portal/dashboard";
  }
  return MANAGER_GOOGLE_SERVICES_ONBOARDING_PATH;
}
