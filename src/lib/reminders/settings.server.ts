/**
 * Load and save reminder rules.
 *
 * Lives in `manager_automation_settings.row_data.reminderRules`, beside
 * `taskAutomation` and `applicationAutomation` — the same namespaced-blob
 * pattern those use, so there is no migration and no second settings store to
 * keep in sync.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_REMINDER_SETTINGS,
  normalizeReminderSettings,
  type ReminderSettings,
} from "@/lib/reminders/rules";

const ROW_DATA_KEY = "reminderRules";

export async function loadReminderSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<ReminderSettings> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeReminderSettings((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
}

/**
 * Read rules for several managers at once.
 *
 * The dispatcher needs a rule per manager and would otherwise issue one query
 * per queued reminder. A manager with no stored row falls back to defaults
 * rather than being skipped — an untouched account should still get reminders.
 */
export async function loadReminderSettingsForManagers(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, ReminderSettings>> {
  const out = new Map<string, ReminderSettings>();
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return out;

  const { data, error } = await db
    .from("manager_automation_settings")
    .select("manager_user_id, row_data")
    .in("manager_user_id", ids);
  if (error) throw error;

  for (const row of data ?? []) {
    const rowData = (row as { row_data?: Record<string, unknown> | null }).row_data ?? null;
    out.set(
      String((row as { manager_user_id: string }).manager_user_id),
      normalizeReminderSettings(rowData?.[ROW_DATA_KEY]),
    );
  }
  for (const id of ids) {
    if (!out.has(id)) out.set(id, DEFAULT_REMINDER_SETTINGS);
  }
  return out;
}

export async function saveReminderSettings(
  db: SupabaseClient,
  managerUserId: string,
  settings: unknown,
): Promise<ReminderSettings> {
  const normalized = normalizeReminderSettings(settings);
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  // Merge rather than replace: sibling namespaces in this blob belong to other
  // features and must survive a reminder save.
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[ROW_DATA_KEY] = normalized;

  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
}
