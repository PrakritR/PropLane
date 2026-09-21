import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-property overrides for Operations settings (PLAN-0916-1040, extended by
 * PLAN-0920-0845).
 *
 * A house that wants its own reminders / automation stores a blob at
 * `manager_property_records.row_data.operationsSettings.<namespace>` — the
 * same per-property JSON record the Payments service-fee payer already lives
 * in (`manager-manual-payment-settings.server.ts`). No migration.
 *
 * This module is the PROPERTY rung only. Resolution across every rung — house
 * override → workspace row (`workspace_automation_settings`) → account row
 * (this manager's own settings — what earlier comments here called "the
 * workspace default", before a real `portal_workspaces`-scoped rung existed) →
 * built-in default — lives in `@/lib/settings/scope-resolver.server`, which
 * calls into this module for the first rung.
 *
 * `savePropertyOverride` MERGES the incoming value's own top-level keys onto
 * whatever is already stored for that namespace, rather than replacing the
 * whole thing. For a namespace whose value is itself keyed by "kind" —
 * `reminderRules`, stored as `{ <ReminderSubjectKind>: ReminderRule, ... }` —
 * this is exactly the per-kind partial override contract: a house that
 * customizes one reminder kind stores ONLY that kind, and every other kind
 * keeps tracking the workspace value at read time (see
 * `mergeReminderSettingsOverride` in `reminders/settings.server.ts`, which
 * does that workspace-merge on the way out). A caller whose namespace value
 * is genuinely atomic (`lifecycleTasks`, `automatedMessages` today) already
 * passes its whole normalized shape on every save — every key present every
 * time — so the merge and a full replace produce the same stored value; nothing
 * changes for those namespaces. `clearPropertyOverride` accepts an optional
 * `kind` to delete one top-level key (or one nested `rules.<kind>` on a
 * pre-existing whole-blob override saved before this change) instead of the
 * whole namespace — "Reset to account/workspace default" for one kind is one
 * delete, and the result resolves to whatever the next rung up holds.
 *
 * A pre-existing whole-blob `reminderRules` override (saved before per-kind
 * partial overrides existed) already has every kind present under a nested
 * `rules` key — callers that understand that shape (`extractRulesPartial` in
 * `reminders/settings.server.ts`) read it as "a partial with every kind",
 * with any top-level kind winning over the nested copy, so it resolves
 * exactly as it did before. The first per-kind save on such a house lifts
 * the nested kinds to the top level in place (`liftLegacyReminderRulesOverride`).
 *
 * Ownership is verified on every read and write against the `managerUserId`
 * the caller passes in. The literal owner of record
 * (`manager_property_records.manager_user_id`) always passes. A co-manager
 * with an accepted grant for the property may also reach this module — the
 * CALLING ROUTE resolves and authorizes that first, through
 * `resolveSettingsPropertyOwner`/`resolveReminderKindsSettingsPropertyOwner`
 * (`@/lib/auth/manager-settings-module-access.server`) or, for a named
 * workspace or a foreign owner's property, `assertSettingsScopeOwned` — both
 * reuse the same `assertCoManagerModuleAccess` gate every other co-manager-
 * aware settings surface uses (never a wider check), then pass the resolved
 * PROPERTY OWNER's id in here — this module never resolves ownership itself,
 * only verifies the id it was given. That is a permission-gated read/write,
 * never an ownership transfer. A `propertyId` not in scope at all throws
 * {@link ForeignPropertyError}, which the routes map to 403; it is never a
 * silent fallback to the workspace or account value.
 */

/** The `row_data` key every Operations override namespace hangs under. */
export const OPERATIONS_SETTINGS_KEY = "operationsSettings";

/**
 * The namespaces a house may override. These mirror the keys the account-level
 * settings already use inside `manager_automation_settings.row_data` (and, for
 * a workspace rung, `workspace_automation_settings.row_data`), so the override
 * is conceptually the same blob stored one level down on the house.
 *
 * `applicationAutomation` and `tourSettings` (PLAN-0920-0845) join the set
 * `resolveSettingsScope` resolves through all three rungs. `paymentAutomation`
 * and `serviceAutomation` were declared here but never wired to a route until
 * the same change — see `src/app/api/portal/automation-settings/route.ts` and
 * `src/app/api/portal/service-automation-settings/route.ts`.
 */
export type OperationsNamespace =
  | "reminderRules"
  | "paymentAutomation"
  | "lifecycleTasks"
  | "serviceAutomation"
  | "automatedMessages"
  | "applicationAutomation"
  | "tourSettings";

/** A `propertyId` that is not in this manager's workspace. Routes map it to 403. */
export class ForeignPropertyError extends Error {
  readonly code = "FOREIGN_PROPERTY";
  constructor(message = "That property is not in your workspace.") {
    super(message);
    this.name = "ForeignPropertyError";
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * Read the property's `row_data`, proving it belongs to `managerUserId` —
 * the literal owner, or the owner id a co-manager call was already resolved
 * and authorized against (see the module doc). Throws
 * {@link ForeignPropertyError} when the id is not one of that manager's
 * houses.
 */
async function ownedRowData(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
): Promise<Record<string, unknown>> {
  const id = propertyId.trim();
  if (!id) throw new ForeignPropertyError();
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ForeignPropertyError();
  return asObject(data.row_data);
}

async function writeRowData(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  nextRowData: Record<string, unknown>,
): Promise<void> {
  const { error } = await db
    .from("manager_property_records")
    .update({ row_data: nextRowData, updated_at: new Date().toISOString() })
    .eq("manager_user_id", managerUserId)
    .eq("id", propertyId.trim());
  if (error) throw error;
}

/**
 * Read only the one namespace's stored value out of `row_data`, proving
 * ownership the same way as {@link ownedRowData} — a narrower `select` than a
 * full `row_data` read (WS7 egress), since a read-only resolution never needs
 * every other namespace or the listing payload riding alongside it.
 */
async function ownedNamespaceValue(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  namespace: OperationsNamespace,
): Promise<unknown | null> {
  const id = propertyId.trim();
  if (!id) throw new ForeignPropertyError();
  const { data, error } = await db
    .from("manager_property_records")
    .select(`id, value:row_data->${OPERATIONS_SETTINGS_KEY}->${namespace}`)
    .eq("manager_user_id", managerUserId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ForeignPropertyError();
  const value = (data as { value?: unknown }).value;
  return value == null ? null : value;
}

/** The raw stored override for one house + namespace, or `null` when none. */
export async function loadPropertyOverride(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  namespace: OperationsNamespace,
): Promise<unknown | null> {
  return ownedNamespaceValue(db, managerUserId, propertyId, namespace);
}

/**
 * A `reminderRules` override saved before per-kind partials existed nests
 * every kind under its own `rules` key. Lifted to the per-kind shape — each
 * `rules.<kind>` becomes a top-level key, every other key (`quietHours`,
 * `automationSendMode`) is kept as-is — so a per-kind merge lands beside the
 * legacy kinds instead of being shadowed by them on read. A value with no
 * nested `rules` object is returned untouched.
 */
export function liftLegacyReminderRulesOverride(value: Record<string, unknown>): Record<string, unknown> {
  const nested = value.rules;
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return value;
  const rest = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "rules"));
  return { ...rest, ...(nested as Record<string, unknown>) };
}

/**
 * Store a house's override for a namespace. MERGES `value`'s own top-level
 * keys onto whatever is already stored — see the module doc for what that
 * means for a per-kind namespace (`reminderRules`) versus an atomic one. A
 * legacy whole-blob `reminderRules` override is migrated in place to the
 * per-kind shape before the merge (`liftLegacyReminderRulesOverride`).
 */
export async function savePropertyOverride(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  namespace: OperationsNamespace,
  value: unknown,
): Promise<void> {
  const rowData = await ownedRowData(db, managerUserId, propertyId);
  const ops = { ...asObject(rowData[OPERATIONS_SETTINGS_KEY]) };
  const stored = asObject(ops[namespace]);
  const existing = namespace === "reminderRules" ? liftLegacyReminderRulesOverride(stored) : stored;
  const incoming = asObject(value);
  ops[namespace] = { ...existing, ...incoming };
  await writeRowData(db, managerUserId, propertyId, { ...rowData, [OPERATIONS_SETTINGS_KEY]: ops });
}

/**
 * Drop one house's override for a namespace — the whole namespace when `kind`
 * is omitted, or one top-level key when given. Idempotent either way.
 *
 * A `kind` clear also opportunistically deletes a same-named key nested under
 * a legacy whole-blob override's own `rules` object (a `reminderRules`
 * override saved before per-kind overrides existed nests every kind there),
 * so resetting one kind on a pre-existing house override works without a
 * migration.
 */
export async function clearPropertyOverride(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  namespace: OperationsNamespace,
  kind?: string,
): Promise<void> {
  const rowData = await ownedRowData(db, managerUserId, propertyId);
  const ops = { ...asObject(rowData[OPERATIONS_SETTINGS_KEY]) };
  if (!(namespace in ops)) return;

  if (kind == null) {
    delete ops[namespace];
    await writeRowData(db, managerUserId, propertyId, { ...rowData, [OPERATIONS_SETTINGS_KEY]: ops });
    return;
  }

  const existing = asObject(ops[namespace]);
  const next = { ...existing };
  let changed = false;
  if (kind in next) {
    delete next[kind];
    changed = true;
  }
  const nestedRules = asObject(next.rules);
  if (kind in nestedRules) {
    const nextRules = { ...nestedRules };
    delete nextRules[kind];
    next.rules = nextRules;
    changed = true;
  }
  if (!changed) return;
  ops[namespace] = next;
  await writeRowData(db, managerUserId, propertyId, { ...rowData, [OPERATIONS_SETTINGS_KEY]: ops });
}

/** Ids of every house in this manager's workspace that has its own override. */
export async function listPropertyOverrides(
  db: SupabaseClient,
  managerUserId: string,
  namespace: OperationsNamespace,
): Promise<string[]> {
  const { data, error } = await db
    .from("manager_property_records")
    .select(`id, value:row_data->${OPERATIONS_SETTINGS_KEY}->${namespace}`)
    .eq("manager_user_id", managerUserId);
  if (error) throw error;
  const out: string[] = [];
  for (const row of data ?? []) {
    const value = (row as { value?: unknown }).value;
    if (value != null) out.push(String((row as { id: string }).id));
  }
  return out;
}

export type OperationsScope = "workspace" | "property";

/**
 * The one resolution helper the atomic-namespace routes use: override →
 * workspace → default.
 *
 * `propertyId === null` (the "All properties" scope) always returns the
 * workspace value. With `ops.mergeOverride` given, the workspace value is
 * always loaded and any non-empty override is merged onto it by the caller's
 * own domain-aware merge (per-kind namespaces like `reminderRules` need
 * this); otherwise (the atomic-namespace path, unchanged) a present override
 * is normalized and returned directly, with no workspace read at all. A house
 * without an override, or whose override is an empty object (every key
 * cleared), returns the workspace value flagged `inherited: true`.
 */
export async function resolveOperationsOverride<T>(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string | null,
  namespace: OperationsNamespace,
  ops: {
    loadWorkspace: () => Promise<T>;
    normalize?: (raw: unknown) => T;
    mergeOverride?: (workspace: T, raw: unknown) => T;
  },
): Promise<{ settings: T; scope: OperationsScope; inherited: boolean }> {
  if (!propertyId) {
    return { settings: await ops.loadWorkspace(), scope: "workspace", inherited: false };
  }
  const override = await loadPropertyOverride(db, managerUserId, propertyId, namespace);
  const isEmpty = override == null || (typeof override === "object" && !Array.isArray(override) && Object.keys(override).length === 0);

  if (ops.mergeOverride) {
    const workspace = await ops.loadWorkspace();
    if (isEmpty) return { settings: workspace, scope: "workspace", inherited: true };
    return { settings: ops.mergeOverride(workspace, override), scope: "property", inherited: false };
  }

  if (!isEmpty && ops.normalize) {
    return { settings: ops.normalize(override), scope: "property", inherited: false };
  }
  return { settings: await ops.loadWorkspace(), scope: "workspace", inherited: true };
}

/**
 * Every house override for a namespace across a set of managers, for the
 * senders — one query instead of one per queued row. Keyed
 * `managerUserId → (propertyId → raw override)`. A row with no override, or a
 * manager with no houses, simply is not in the map, so the caller falls back
 * to the workspace rule.
 */
export async function loadPropertyOverridesForManagers(
  db: SupabaseClient,
  managerUserIds: readonly string[],
  namespace: OperationsNamespace,
): Promise<Map<string, Map<string, unknown>>> {
  const out = new Map<string, Map<string, unknown>>();
  const ids = [...new Set(managerUserIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("manager_property_records")
    .select(`id, manager_user_id, value:row_data->${OPERATIONS_SETTINGS_KEY}->${namespace}`)
    .in("manager_user_id", ids);
  if (error) throw error;
  for (const row of data ?? []) {
    const value = (row as { value?: unknown }).value;
    if (value == null) continue;
    const managerUserId = String((row as { manager_user_id: string }).manager_user_id);
    const propertyId = String((row as { id: string }).id);
    const byProperty = out.get(managerUserId) ?? new Map<string, unknown>();
    byProperty.set(propertyId, value);
    out.set(managerUserId, byProperty);
  }
  return out;
}
