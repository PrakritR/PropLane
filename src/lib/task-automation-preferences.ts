/**
 * Default operational tasks (review application, send lease, collect rent) with
 * per-manager deadlines and reminder preferences. Stored in
 * `manager_automation_settings.row_data.taskAutomation` alongside application
 * automation — no schema migration.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const DEFAULT_TASK_TEMPLATE_KEYS = [
  "review_application",
  "review_and_send_lease",
  "collect_rent",
] as const;

export type DefaultTaskTemplateKey = (typeof DEFAULT_TASK_TEMPLATE_KEYS)[number];

export type TaskTemplateConfig = {
  /** When false, no auto-task is created for this trigger. */
  enabled: boolean;
  /** Days after the trigger event (application submitted, lease approved, etc.). */
  daysAfterTrigger: number;
  /** Team member user id; null = property manager (owner). */
  defaultAssigneeUserId: string | null;
  /** Email the assignee when the task is created and again on due date if still open. */
  sendEmailReminder: boolean;
};

export type TaskAutomationPreferences = Record<DefaultTaskTemplateKey, TaskTemplateConfig>;

export const DEFAULT_TASK_TEMPLATE_LABELS: Record<DefaultTaskTemplateKey, string> = {
  review_application: "Review application",
  review_and_send_lease: "Review and send lease",
  collect_rent: "Collect rent",
};

export const DEFAULT_TASK_AUTOMATION: TaskAutomationPreferences = {
  review_application: {
    enabled: true,
    daysAfterTrigger: 2,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
  },
  review_and_send_lease: {
    enabled: true,
    daysAfterTrigger: 2,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
  },
  collect_rent: {
    enabled: true,
    daysAfterTrigger: 3,
    defaultAssigneeUserId: null,
    sendEmailReminder: true,
  },
};

function normalizeTemplateConfig(raw: unknown, fallback: TaskTemplateConfig): TaskTemplateConfig {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const days =
    typeof row.daysAfterTrigger === "number" && Number.isFinite(row.daysAfterTrigger)
      ? Math.max(0, Math.min(90, Math.round(row.daysAfterTrigger)))
      : fallback.daysAfterTrigger;
  return {
    enabled: typeof row.enabled === "boolean" ? row.enabled : fallback.enabled,
    daysAfterTrigger: days,
    defaultAssigneeUserId:
      typeof row.defaultAssigneeUserId === "string" && row.defaultAssigneeUserId.trim()
        ? row.defaultAssigneeUserId.trim()
        : null,
    sendEmailReminder: row.sendEmailReminder !== false,
  };
}

export function normalizeTaskAutomation(raw: unknown): TaskAutomationPreferences {
  const row = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const templates =
    row.templates && typeof row.templates === "object" && !Array.isArray(row.templates)
      ? (row.templates as Record<string, unknown>)
      : row;
  const out = { ...DEFAULT_TASK_AUTOMATION };
  for (const key of DEFAULT_TASK_TEMPLATE_KEYS) {
    out[key] = normalizeTemplateConfig(templates[key], DEFAULT_TASK_AUTOMATION[key]);
  }
  return out;
}

const ROW_DATA_KEY = "taskAutomation";

export async function loadTaskAutomation(
  db: SupabaseClient,
  managerUserId: string,
): Promise<TaskAutomationPreferences> {
  const { data, error } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  if (error) throw error;
  return normalizeTaskAutomation((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
}

export async function saveTaskAutomation(
  db: SupabaseClient,
  managerUserId: string,
  prefs: unknown,
): Promise<TaskAutomationPreferences> {
  const normalized = normalizeTaskAutomation(prefs);
  const { data: existing } = await db
    .from("manager_automation_settings")
    .select("row_data")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
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

/** ISO end-of-local-day for a calendar due date (YYYY-MM-DD). */
export function dueDateFromDaysAfter(triggerIso: string, daysAfter: number): string {
  const base = new Date(triggerIso);
  if (Number.isNaN(base.getTime())) return new Date().toISOString();
  const due = new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysAfter, 23, 59, 0, 0);
  return due.toISOString();
}
