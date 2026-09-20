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
  DEFAULT_REMINDER_RULES,
  DEFAULT_REMINDER_SETTINGS,
  REMINDER_SUBJECT_KINDS,
  normalizeReminderSettings,
  normalizeRule,
  type ReminderRules,
  type ReminderSettings,
} from "@/lib/reminders/rules";
import {
  loadPropertyOverride,
  loadPropertyOverridesForManagers,
} from "@/lib/settings/property-overrides.server";

const ROW_DATA_KEY = "reminderRules";

/**
 * The per-kind partial a house's `reminderRules` override stores, keyed by
 * `ReminderSubjectKind`. A pre-existing WHOLE-BLOB override (saved before
 * per-kind partial overrides existed, PLAN-0916-1040) nests every kind under
 * its own `rules` key instead — that shape already has every kind present, so
 * reading it as "a partial with every kind" resolves it exactly as it did
 * before. Both shapes are read together: a top-level kind (a per-kind save
 * that landed on a legacy blob) always wins over the nested copy.
 */
function extractRulesPartial(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const row = raw as Record<string, unknown>;
  const nested =
    row.rules && typeof row.rules === "object" && !Array.isArray(row.rules)
      ? (row.rules as Record<string, unknown>)
      : {};
  const topLevel: Record<string, unknown> = {};
  for (const kind of REMINDER_SUBJECT_KINDS) {
    if (kind in row) topLevel[kind] = row[kind];
  }
  return { ...nested, ...topLevel };
}

/**
 * Resolution for a house's `reminderRules` override (PLAN-0916-1040): the
 * workspace value, deep-merged with the house's own partial PER KIND. A kind
 * absent from the partial keeps tracking the workspace value — including a
 * later change to it — rather than being frozen at whatever the workspace
 * held the moment a sibling kind was first customized.
 */
export function mergeReminderSettingsOverride(workspace: ReminderSettings, raw: unknown): ReminderSettings {
  const partial = extractRulesPartial(raw);
  const rules = { ...workspace.rules } as ReminderRules;
  for (const kind of REMINDER_SUBJECT_KINDS) {
    if (kind in partial) {
      rules[kind] = normalizeRule(partial[kind], workspace.rules[kind] ?? DEFAULT_REMINDER_RULES[kind], kind);
    }
  }
  return normalizeReminderSettings({
    rules,
    quietHours: workspace.quietHours,
    automationSendMode: workspace.automationSendMode,
  });
}

function isEmptyOverride(raw: unknown): boolean {
  return raw == null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0);
}

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

/**
 * Reminder rules for one manager + one house (PLAN-0916-1040).
 *
 * `propertyId === null` — a row with no property, such as an unanswered inbox
 * thread — keeps the workspace rule. A house with its own `reminderRules`
 * override returns it; otherwise the workspace value. Verifies the property
 * belongs to the manager (a foreign id throws, never a silent workspace fall
 * back), so only call it with a `propertyId` that came from the row itself.
 */
export async function loadReminderSettingsForProperty(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string | null,
): Promise<ReminderSettings> {
  const workspace = await loadReminderSettings(db, managerUserId);
  if (!propertyId) return workspace;
  const override = await loadPropertyOverride(db, managerUserId, propertyId, ROW_DATA_KEY);
  return isEmptyOverride(override) ? workspace : mergeReminderSettingsOverride(workspace, override);
}

export type ReminderSettingsResolver = {
  /** Reminder rules for `(managerUserId, propertyId)` — override → workspace → default. */
  resolve: (managerUserId: string, propertyId: string | null) => ReminderSettings;
};

/**
 * Batch resolver for the senders: one query for every manager's workspace rules
 * and one for every house override, then `resolve(manager, property)` picks the
 * house's own rule when it has one, else the workspace's. A row with no property
 * (`propertyId === null`) always gets the workspace rule.
 */
export async function loadReminderSettingsResolver(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<ReminderSettingsResolver> {
  const [workspace, overrides] = await Promise.all([
    loadReminderSettingsForManagers(db, managerUserIds),
    loadPropertyOverridesForManagers(db, managerUserIds, ROW_DATA_KEY),
  ]);
  return {
    resolve(managerUserId, propertyId) {
      const ws = workspace.get(managerUserId) ?? DEFAULT_REMINDER_SETTINGS;
      if (!propertyId) return ws;
      const raw = overrides.get(managerUserId)?.get(propertyId);
      return isEmptyOverride(raw) ? ws : mergeReminderSettingsOverride(ws, raw);
    },
  };
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
