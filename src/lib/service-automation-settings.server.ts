import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_SERVICE_AUTOMATION_SETTINGS,
  normalizeServiceAutomationSettings,
  type ServiceAutomationSettings,
} from "@/lib/service-automation-settings";
import {
  resolveSettingsScope,
  type SettingsScopeCache,
} from "@/lib/settings/scope-resolver.server";

const ROW_DATA_KEY = "serviceAutomation";

export async function loadServiceAutomationSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ServiceAutomationSettings> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeServiceAutomationSettings((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
}

/** One query for a sweep across managers; absent rows fall back to defaults. */
export async function loadServiceAutomationSettingsForManagers(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, ServiceAutomationSettings>> {
  const out = new Map<string, ServiceAutomationSettings>();
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("manager_user_id, row_data")
    .in("manager_user_id", ids);
  if (error) throw error;
  for (const row of data ?? []) {
    const rowData = (row as { row_data?: Record<string, unknown> | null }).row_data ?? null;
    out.set(String((row as { manager_user_id: string }).manager_user_id), normalizeServiceAutomationSettings(rowData?.[ROW_DATA_KEY]));
  }
  for (const id of ids) if (!out.has(id)) out.set(id, DEFAULT_SERVICE_AUTOMATION_SETTINGS);
  return out;
}

/**
 * Service automation for one work order's property, through the full
 * three-rung scope (PLAN-0920-0845 phase C): house override → workspace row →
 * account row → default. `cache` should be one {@link createSettingsScopeCache}
 * shared for an entire sweep pass. A row with no `propertyId` resolves to the
 * account value, exactly today's no-property behaviour.
 */
export async function resolveServiceAutomationSettingsForRow(
  db: SupabaseClient,
  cache: SettingsScopeCache,
  managerUserId: string,
  propertyId: string | null,
): Promise<ServiceAutomationSettings> {
  const { value } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId },
    ROW_DATA_KEY,
    { normalize: normalizeServiceAutomationSettings, loadAccount: (d, m) => loadServiceAutomationSettings(d, m) },
    cache,
  );
  return value;
}

export async function saveServiceAutomationSettings(
  db: SupabaseClient,
  managerUserId: string,
  patch: unknown,
): Promise<ServiceAutomationSettings> {
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  const current = rowData[ROW_DATA_KEY] && typeof rowData[ROW_DATA_KEY] === "object" ? (rowData[ROW_DATA_KEY] as Record<string, unknown>) : {};
  const incoming = patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
  const next = normalizeServiceAutomationSettings({ ...current, ...incoming });
  rowData[ROW_DATA_KEY] = next;
  const { error } = await db.from("manager_automation_settings").upsert(
    { manager_user_id: managerUserId, row_data: rowData, updated_at: new Date().toISOString() },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return next;
}
