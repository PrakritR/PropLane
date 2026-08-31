/**
 * Load and save lifecycle task rules.
 *
 * Stored at `manager_automation_settings.row_data.lifecycleTasks`, beside
 * `taskAutomation` and `applicationAutomation` — the same namespaced-blob
 * pattern, so no migration and no second settings store.
 *
 * The legacy `taskAutomation` blob is read as a FALLBACK for the three keys it
 * shared (review_application, review_and_send_lease, collect_rent). A manager
 * who tuned those before this existed keeps their deadlines instead of being
 * silently reset to a default they never chose.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_LIFECYCLE_AUTOMATION,
  normalizeLifecycleAutomation,
  type LifecycleTaskAutomation,
} from "@/lib/task-lifecycle-automation";

const ROW_DATA_KEY = "lifecycleTasks";
const LEGACY_KEY = "taskAutomation";

/** Keys the legacy application automation also configured. */
const LEGACY_SHARED_KEYS = ["review_application", "review_and_send_lease", "collect_rent"] as const;

function mergeLegacy(stored: unknown, legacy: unknown): Record<string, unknown> {
  const storedRow =
    stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};
  const legacyRow =
    legacy && typeof legacy === "object" && !Array.isArray(legacy) ? (legacy as Record<string, unknown>) : {};
  for (const key of LEGACY_SHARED_KEYS) {
    // Only fill a gap — a rule saved under the new key always wins, so editing
    // in the new Settings screen is never undone by the old blob.
    if (storedRow[key] === undefined && legacyRow[key] !== undefined) {
      storedRow[key] = legacyRow[key];
    }
  }
  return storedRow;
}

export async function loadLifecycleAutomation(
  db: SupabaseClient,
  managerUserId: string,
): Promise<LifecycleTaskAutomation> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  const rowData = (data?.row_data as Record<string, unknown> | null) ?? {};
  return normalizeLifecycleAutomation(mergeLegacy(rowData[ROW_DATA_KEY], rowData[LEGACY_KEY]));
}

/** Rules for several managers at once — one query instead of one per manager. */
export async function loadLifecycleAutomationForManagers(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, LifecycleTaskAutomation>> {
  const out = new Map<string, LifecycleTaskAutomation>();
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return out;

  const { data, error } = await db
    .from("manager_automation_settings")
    .select("manager_user_id, row_data")
    .in("manager_user_id", ids);
  if (error) throw error;

  for (const row of data ?? []) {
    const rowData = ((row as { row_data?: Record<string, unknown> | null }).row_data ?? {}) as Record<string, unknown>;
    out.set(
      String((row as { manager_user_id: string }).manager_user_id),
      normalizeLifecycleAutomation(mergeLegacy(rowData[ROW_DATA_KEY], rowData[LEGACY_KEY])),
    );
  }
  // A manager with no stored row still gets rules — an untouched account should
  // generate tasks, not sit silent.
  for (const id of ids) if (!out.has(id)) out.set(id, DEFAULT_LIFECYCLE_AUTOMATION);
  return out;
}

export async function saveLifecycleAutomation(
  db: SupabaseClient,
  managerUserId: string,
  automation: unknown,
): Promise<LifecycleTaskAutomation> {
  const normalized = normalizeLifecycleAutomation(automation);
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  // Merge rather than replace: sibling namespaces in this blob belong to other
  // features and must survive a lifecycle save.
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[ROW_DATA_KEY] = normalized;

  const { error } = await db.from("manager_automation_settings").upsert(
    { manager_user_id: managerUserId, row_data: rowData, updated_at: new Date().toISOString() },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
}
