import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_LEASE_AUTOMATION_SETTINGS,
  normalizeLeaseAutomationSettings,
  type LeaseAutomationSettings,
} from "@/lib/lease-automation-settings";

const ROW_DATA_KEY = "leaseAutomation";

export async function loadLeaseAutomationSettings(db: SupabaseClient, managerUserId: string): Promise<LeaseAutomationSettings> {
  const { data, error } = await db.from("manager_automation_settings").select("row_data").eq("manager_user_id", managerUserId).maybeSingle();
  if (error) throw error;
  return normalizeLeaseAutomationSettings((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
}

export async function loadLeaseAutomationSettingsForManagers(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, LeaseAutomationSettings>> {
  const out = new Map<string, LeaseAutomationSettings>();
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await db.from("manager_automation_settings").select("manager_user_id, row_data").in("manager_user_id", ids);
  if (error) throw error;
  for (const row of data ?? []) {
    out.set(String(row.manager_user_id), normalizeLeaseAutomationSettings((row.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]));
  }
  for (const id of ids) if (!out.has(id)) out.set(id, DEFAULT_LEASE_AUTOMATION_SETTINGS);
  return out;
}

export async function saveLeaseAutomationSettings(db: SupabaseClient, managerUserId: string, patch: unknown): Promise<LeaseAutomationSettings> {
  const { data: existing } = await db.from("manager_automation_settings").select("row_data").eq("manager_user_id", managerUserId).maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  const current = rowData[ROW_DATA_KEY] && typeof rowData[ROW_DATA_KEY] === "object" ? (rowData[ROW_DATA_KEY] as Record<string, unknown>) : {};
  const incoming = patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
  const next = normalizeLeaseAutomationSettings({ ...current, ...incoming });
  rowData[ROW_DATA_KEY] = next;
  const { error } = await db
    .from("manager_automation_settings")
    .upsert({ manager_user_id: managerUserId, row_data: rowData, updated_at: new Date().toISOString() }, { onConflict: "manager_user_id" });
  if (error) throw error;
  return next;
}
