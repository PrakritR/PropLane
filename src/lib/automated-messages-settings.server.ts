import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  normalizeAutomatedMessageSettings,
  type AutomatedMessageSettings,
} from "@/lib/automated-messages-settings";

const ROW_DATA_KEY = "automatedMessages";

export async function loadAutomatedMessageSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<AutomatedMessageSettings> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeAutomatedMessageSettings((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
}

/** Merge one or more entries into the blob; sibling namespaces survive untouched. */
export async function saveAutomatedMessageSettings(
  db: SupabaseClient,
  managerUserId: string,
  patch: unknown,
): Promise<AutomatedMessageSettings> {
  const incoming = normalizeAutomatedMessageSettings(patch);
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  const current = normalizeAutomatedMessageSettings(rowData[ROW_DATA_KEY]);
  const merged: AutomatedMessageSettings = { ...current, ...incoming };
  rowData[ROW_DATA_KEY] = merged;
  const { error } = await db.from("manager_automation_settings").upsert(
    { manager_user_id: managerUserId, row_data: rowData, updated_at: new Date().toISOString() },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return merged;
}
