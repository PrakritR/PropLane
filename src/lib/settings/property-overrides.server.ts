import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Per-property overrides for Operations settings (PLAN-0916-1040).
 *
 * A house that wants its own reminders / automation stores a whole namespace
 * blob at `manager_property_records.row_data.operationsSettings.<namespace>` —
 * the same per-property JSON record the Payments service-fee payer already
 * lives in (`manager-manual-payment-settings.server.ts`). No migration.
 *
 * Resolution is always: house override → workspace default → built-in default.
 * An override is stored and cleared WHOLE per namespace per house (no
 * field-level merge), so "Reset to workspace default" is one delete and the
 * result is always exactly the workspace values.
 *
 * Ownership is verified on every read and write against the manager who owns
 * the property record — the same `manager_user_id = managerUserId AND id = …`
 * check the manual-payment settings use. A `propertyId` not in this manager's
 * workspace throws {@link ForeignPropertyError}, which the routes map to 403;
 * it is never a silent fallback to the workspace value. The per-module
 * co-manager authorization (`assertReminderKindCoManagerAccess` and siblings)
 * still runs in front of every route path — this module is the ownership gate,
 * not the module gate.
 */

/** The `row_data` key every Operations override namespace hangs under. */
export const OPERATIONS_SETTINGS_KEY = "operationsSettings";

/**
 * The namespaces a house may override. These mirror the keys the workspace
 * settings already use inside `manager_automation_settings.row_data`, so the
 * override is conceptually the same blob stored one level down on the house.
 */
export type OperationsNamespace =
  | "reminderRules"
  | "paymentAutomation"
  | "lifecycleTasks"
  | "serviceAutomation";

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
 * Read the property's `row_data`, proving it belongs to this manager. Throws
 * {@link ForeignPropertyError} when the id is not one of the manager's houses.
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

/** The raw stored override for one house + namespace, or `null` when none. */
export async function loadPropertyOverride(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  namespace: OperationsNamespace,
): Promise<unknown | null> {
  const rowData = await ownedRowData(db, managerUserId, propertyId);
  const ops = asObject(rowData[OPERATIONS_SETTINGS_KEY]);
  const value = ops[namespace];
  return value == null ? null : value;
}

/** Store (create or replace) the whole namespace blob on one house. */
export async function savePropertyOverride(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  namespace: OperationsNamespace,
  value: unknown,
): Promise<void> {
  const rowData = await ownedRowData(db, managerUserId, propertyId);
  const ops = { ...asObject(rowData[OPERATIONS_SETTINGS_KEY]) };
  ops[namespace] = value;
  await writeRowData(db, managerUserId, propertyId, { ...rowData, [OPERATIONS_SETTINGS_KEY]: ops });
}

/** Drop one house's override for a namespace. Idempotent. */
export async function clearPropertyOverride(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  namespace: OperationsNamespace,
): Promise<void> {
  const rowData = await ownedRowData(db, managerUserId, propertyId);
  const ops = { ...asObject(rowData[OPERATIONS_SETTINGS_KEY]) };
  if (!(namespace in ops)) return;
  delete ops[namespace];
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
    .select("id, row_data")
    .eq("manager_user_id", managerUserId);
  if (error) throw error;
  const out: string[] = [];
  for (const row of data ?? []) {
    const ops = asObject(asObject((row as { row_data?: unknown }).row_data)[OPERATIONS_SETTINGS_KEY]);
    if (ops[namespace] != null) out.push(String((row as { id: string }).id));
  }
  return out;
}

export type OperationsScope = "workspace" | "property";

/**
 * The one resolution helper the routes use: override → workspace → default.
 *
 * `propertyId === null` (the "All properties" scope) always returns the
 * workspace value. A house with an override returns it (`scope: "property"`);
 * a house without one returns the workspace value flagged `inherited: true`,
 * so the UI can show "Uses workspace defaults" without a second round trip.
 */
export async function resolveOperationsOverride<T>(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string | null,
  namespace: OperationsNamespace,
  ops: { loadWorkspace: () => Promise<T>; normalize: (raw: unknown) => T },
): Promise<{ settings: T; scope: OperationsScope; inherited: boolean }> {
  if (!propertyId) {
    return { settings: await ops.loadWorkspace(), scope: "workspace", inherited: false };
  }
  const override = await loadPropertyOverride(db, managerUserId, propertyId, namespace);
  if (override != null) {
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
    .select("id, manager_user_id, row_data")
    .in("manager_user_id", ids);
  if (error) throw error;
  for (const row of data ?? []) {
    const ops = asObject(asObject((row as { row_data?: unknown }).row_data)[OPERATIONS_SETTINGS_KEY]);
    const value = ops[namespace];
    if (value == null) continue;
    const managerUserId = String((row as { manager_user_id: string }).manager_user_id);
    const propertyId = String((row as { id: string }).id);
    const byProperty = out.get(managerUserId) ?? new Map<string, unknown>();
    byProperty.set(propertyId, value);
    out.set(managerUserId, byProperty);
  }
  return out;
}
