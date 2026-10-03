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
  createSettingsScopeCache,
  isMissingRelationError,
  type SettingsScopeCache,
} from "@/lib/settings/scope-resolver.server";

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

export function isEmptyOverride(raw: unknown): boolean {
  return raw == null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0);
}

/** Workspace message edits are read by the delivery spine; property-era overrides remain inactive. */
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
  const stored = normalizeReminderSettings((data?.row_data as Record<string, unknown> | null)?.[ROW_DATA_KEY]);
  return stored;
}

/** Workspace message edits are read by the delivery spine; property-era overrides remain inactive. */
export async function loadReminderSettingsForManagers(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, ReminderSettings>> {
  const out = new Map<string, ReminderSettings>();
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (!ids.length) return out;
  const { data, error } = await db.from("manager_automation_settings").select("manager_user_id,row_data").in("manager_user_id", ids);
  if (error) throw error;
  for (const id of ids) out.set(id, DEFAULT_REMINDER_SETTINGS);
  for (const row of data ?? []) out.set(row.manager_user_id, normalizeReminderSettings(row.row_data?.[ROW_DATA_KEY]));
  return out;
}

/** Workspace message edits are read by the delivery spine; property-era overrides remain inactive. */
export async function loadReminderSettingsForProperty(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string | null,
): Promise<ReminderSettings> {
  const resolver = await loadReminderSettingsResolver(db, [managerUserId]);
  return resolver.resolve(managerUserId, propertyId);
}

export type ReminderSettingsResolver = {
  /**
   * Reminder rules for `(managerUserId, propertyId?, workspaceId?)` — house
   * override (per kind) → workspace row (per kind) → account row → default.
   * `workspaceId` lets a caller that already knows it (a route scoped to a
   * named workspace) skip the property→workspace lookup; a sweep row instead
   * passes only `propertyId` and the resolver looks its workspace up from the
   * batch it already loaded.
   */
  resolve: (managerUserId: string, propertyId?: string | null, workspaceId?: string | null) => ReminderSettings;
};

/**
 * Every workspace row's stored `reminderRules` raw value, for a set of
 * workspaces — the workspace rung's half of {@link loadReminderSettingsResolver}.
 * Missing-table tolerant, the same as every other `workspace_automation_settings`
 * reader (`resolveSettingsScope`): an environment that has not run the
 * workspace-rung migration yet resolves every workspace to "no row", never throws.
 */
async function loadWorkspaceReminderRowsForWorkspaces(
  db: SupabaseClient,
  workspaceIds: readonly string[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const ids = [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  try {
    const { data, error } = await db.from("workspace_automation_settings").select("workspace_id, row_data").in("workspace_id", ids);
    if (error) {
      if (isMissingRelationError(error)) return out;
      throw error;
    }
    for (const row of data ?? []) {
      const rowData = (row as { row_data?: Record<string, unknown> | null }).row_data;
      const raw = rowData && typeof rowData === "object" && !Array.isArray(rowData) ? (rowData as Record<string, unknown>)[ROW_DATA_KEY] : null;
      if (raw != null) out.set(String((row as { workspace_id: string }).workspace_id), raw);
    }
    return out;
  } catch (error) {
    if (isMissingRelationError(error)) return out;
    throw error;
  }
}

/**
 * A single workspace's raw `reminderRules` value, for a route resolving one
 * scope rather than a sweep's batch. Thin wrapper over the same
 * missing-table-tolerant batch loader {@link loadReminderSettingsResolver} uses.
 */
export async function loadReminderWorkspaceOverride(db: SupabaseClient, workspaceId: string): Promise<unknown | null> {
  const rows = await loadWorkspaceReminderRowsForWorkspaces(db, [workspaceId]);
  return rows.get(workspaceId) ?? null;
}

/** Workspace message edits are read by the delivery spine; property-era overrides remain inactive. */
export async function loadReminderSettingsResolver(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<ReminderSettingsResolver> {
  const ids = [...new Set(managerUserIds.filter(Boolean))];
  if (!ids.length) return { resolve: () => DEFAULT_REMINDER_SETTINGS };
  const [accounts, workspaceResult, propertyResult] = await Promise.all([
    loadReminderSettingsForManagers(db, ids),
    db.from("portal_workspaces").select("id,owner_user_id").in("owner_user_id", ids),
    db.from("manager_property_records").select("id,manager_user_id,workspace_id").in("manager_user_id", ids),
  ]);
  if (workspaceResult.error) throw workspaceResult.error;
  if (propertyResult.error) throw propertyResult.error;
  const owners = new Map((workspaceResult.data ?? []).map((w) => [w.id, w.owner_user_id]));
  const properties = new Map((propertyResult.data ?? []).map((p) => [p.id, p]));
  const workspaceRules = await loadWorkspaceReminderRowsForWorkspaces(db, [...owners.keys()]);
  return { resolve: (managerUserId, propertyId, explicitWorkspaceId) => {
    const base = accounts.get(managerUserId) ?? DEFAULT_REMINDER_SETTINGS;
    const property = propertyId ? properties.get(propertyId) : null;
    const workspaceId = explicitWorkspaceId || (property?.manager_user_id === managerUserId ? property.workspace_id : null);
    if (!workspaceId || owners.get(workspaceId) !== managerUserId) return base;
    const raw = workspaceRules.get(workspaceId);
    return raw ? mergeReminderSettingsOverride(base, raw) : base;
  } };
}

/** Workspace message edits are read by the delivery spine; property-era overrides remain inactive. */
export async function resolveReminderSettingsForRow(
  db: SupabaseClient,
  _cache: SettingsScopeCache,
  managerUserId: string,
  propertyId: string | null,
): Promise<ReminderSettings> {
  return loadReminderSettingsForProperty(db, managerUserId, propertyId);
}

export type { SettingsScopeCache };
export { createSettingsScopeCache };

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
