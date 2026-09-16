import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  legacyFlagsFromVendorNotificationSettings,
  normalizeVendorNotificationSettings,
  type LegacyVendorNotificationFlags,
  type VendorNotificationSettings,
} from "@/lib/vendor-notification-settings";

const ROW_DATA_KEY = "vendor";

async function loadLegacyFlags(db: SupabaseClient, userId: string): Promise<LegacyVendorNotificationFlags | null> {
  const { data } = await db
    .from("vendor_business_profiles")
    .select("notify_new_offers, notify_schedule_changes, notify_payments")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return null;
  return {
    notifyNewOffers: data.notify_new_offers ?? true,
    notifyScheduleChanges: data.notify_schedule_changes ?? true,
    notifyPayments: data.notify_payments ?? true,
  };
}

/**
 * The vendor's effective settings. A vendor who never opened the new pane is
 * read through the three legacy toggles, so the promise the old pane made
 * ("turn this off and it stops") finally holds.
 */
export async function loadVendorNotificationSettings(
  db: SupabaseClient,
  userId: string,
): Promise<VendorNotificationSettings> {
  const { data } = await db.from("notification_preferences").select("row_data").eq("user_id", userId).maybeSingle();
  const blob = (data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY];
  const hasBlob = blob && typeof blob === "object" && !Array.isArray(blob) && "topics" in (blob as object);
  const legacy = hasBlob ? null : await loadLegacyFlags(db, userId);
  return normalizeVendorNotificationSettings(blob, legacy);
}

/**
 * Save under `row_data.vendor`, preserving the resident-style category rows
 * beside it, and mirror the three legacy booleans so the old columns never
 * disagree with what the vendor now sees.
 */
export async function saveVendorNotificationSettings(
  db: SupabaseClient,
  userId: string,
  raw: unknown,
): Promise<VendorNotificationSettings> {
  const next = normalizeVendorNotificationSettings(raw);
  const { data: existing } = await db.from("notification_preferences").select("row_data").eq("user_id", userId).maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[ROW_DATA_KEY] = next;
  const nowIso = new Date().toISOString();
  const { error } = await db
    .from("notification_preferences")
    .upsert({ user_id: userId, row_data: rowData, updated_at: nowIso }, { onConflict: "user_id" });
  if (error) throw error;

  const legacy = legacyFlagsFromVendorNotificationSettings(next);
  await db
    .from("vendor_business_profiles")
    .update({
      notify_new_offers: legacy.notifyNewOffers,
      notify_schedule_changes: legacy.notifyScheduleChanges,
      notify_payments: legacy.notifyPayments,
      updated_at: nowIso,
    })
    .eq("user_id", userId);
  return next;
}
