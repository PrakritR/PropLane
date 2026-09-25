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
import {
  createSettingsScopeCache,
  isMissingRelationError,
  resolveSettingsScope,
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
    // Workspace-wide clock setting, like quietHours: a house-level partial
    // (which only ever carries per-kind `rules`) never overrides the pause
    // switch — it always tracks whatever the rung below held.
    messagesPaused: workspace.messagesPaused,
  });
}

export function isEmptyOverride(raw: unknown): boolean {
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

/** `propertyId → workspace_id` for every house belonging to a set of managers. */
async function loadPropertyWorkspaceMapForManagers(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await db.from("manager_property_records").select("id, workspace_id").in("manager_user_id", ids);
  if (error) throw error;
  for (const row of data ?? []) {
    const workspaceId = (row as { workspace_id?: string | null }).workspace_id;
    if (workspaceId) out.set(String((row as { id: string }).id), String(workspaceId));
  }
  return out;
}

/**
 * Batch resolver for the senders (PLAN-0920-0845 phase C, unified with
 * PLAN-0916-1040's per-kind house partials): one query for every manager's
 * account rules, every house's per-kind partial override, the
 * property→workspace map, and every relevant workspace row's `reminderRules`.
 * `resolve(manager, property, workspace?)` then merges bottom-up per kind —
 * account → workspace partial → house partial — so a kind absent from a
 * partial keeps tracking whatever the rung below it holds, including a LATER
 * change to that rung, rather than freezing at whatever value existed the
 * moment a sibling kind was customized. A row with no property and no
 * workspace resolves to the account value, same as before this plan.
 */
export async function loadReminderSettingsResolver(
  db: SupabaseClient,
  managerUserIds: readonly string[],
): Promise<ReminderSettingsResolver> {
  const [account, houseOverrides, propertyWorkspace] = await Promise.all([
    loadReminderSettingsForManagers(db, managerUserIds),
    loadPropertyOverridesForManagers(db, managerUserIds, ROW_DATA_KEY),
    loadPropertyWorkspaceMapForManagers(db, managerUserIds),
  ]);
  const workspaceIds = [...new Set(propertyWorkspace.values())];
  const workspaceRows = await loadWorkspaceReminderRowsForWorkspaces(db, workspaceIds);
  return {
    resolve(managerUserId, propertyId, workspaceId) {
      const accountSettings = account.get(managerUserId) ?? DEFAULT_REMINDER_SETTINGS;
      const wsId = workspaceId ?? (propertyId ? propertyWorkspace.get(propertyId) : undefined) ?? null;
      const workspaceRaw = wsId ? workspaceRows.get(wsId) : undefined;
      const base = workspaceRaw != null ? mergeReminderSettingsOverride(accountSettings, workspaceRaw) : accountSettings;
      if (!propertyId) return base;
      const raw = houseOverrides.get(managerUserId)?.get(propertyId);
      return isEmptyOverride(raw) ? base : mergeReminderSettingsOverride(base, raw);
    },
  };
}

/**
 * Reminder rules for one sweep row, through the full three-rung scope
 * (PLAN-0920-0845 phase C): house override → workspace row → account row →
 * default. `cache` should be one {@link createSettingsScopeCache} shared for
 * an entire sweep pass so many rows under the same house or workspace do not
 * re-query it.
 *
 * @deprecated Prefer {@link loadReminderSettingsResolver} — one batch load per
 * sweep, then `resolver.resolve(managerUserId, propertyId)` per row, rather
 * than one query pair per row. Kept only for a caller resolving a single row
 * outside a sweep's batch loop (a route's one-off read).
 */
export async function resolveReminderSettingsForRow(
  db: SupabaseClient,
  cache: SettingsScopeCache,
  managerUserId: string,
  propertyId: string | null,
): Promise<ReminderSettings> {
  const { value } = await resolveSettingsScope(
    db,
    { managerUserId, propertyId },
    ROW_DATA_KEY,
    { normalize: normalizeReminderSettings, loadAccount: (d, m) => loadReminderSettings(d, m) },
    cache,
  );
  return value;
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
