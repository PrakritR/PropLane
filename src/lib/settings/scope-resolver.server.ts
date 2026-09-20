import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadPropertyOverride, type OperationsNamespace } from "@/lib/settings/property-overrides.server";

/**
 * The three-rung settings resolver (PLAN-0920-0845 phase A).
 *
 * `property-overrides.server.ts` already resolves house override → account
 * row (it called the account row "workspace" before this plan; see that
 * file's header). This module adds the WORKSPACE rung in between —
 * `workspace_automation_settings`, one row per `portal_workspaces` id — so
 * resolution for every settings namespace becomes:
 *
 *   property override → workspace row → account row → built-in default
 *
 * Each rung is optional. A `propertyId` with no override falls through to its
 * workspace (looked up from `manager_property_records.workspace_id` when the
 * caller did not already know it); a request with only a `workspaceId` skips
 * the property rung entirely; a request with neither always resolves the
 * account row. The `workspace_automation_settings` table may not exist yet in
 * an environment that has not run this plan's migration — a missing-relation
 * error (Postgres `42P01`, or PostgREST's "does not exist" schema-cache
 * message) is treated as "this workspace has no row", never thrown, so a
 * sweep or route never breaks because the migration has not landed there yet.
 * Any OTHER database error still throws — this module fails closed on a real
 * problem, and only shrugs off the one specific "the rung does not exist"
 * shape.
 *
 * `source` is the truthful tag for the UI: which rung actually answered. It
 * is `"account"` whenever neither a property nor a workspace override exists
 * AND the caller supplied an account-row loader (`ops.loadAccount`) — which is
 * every namespace phase A+B wires, so `"default"` is reachable only for a
 * namespace resolved with no account loader at all (a future/partial caller).
 * This intentionally pins today's behaviour: before this plan, an unset
 * account row already resolved silently to that namespace's built-in
 * defaults via its own loader, and callers labelled that "workspace" (really
 * "account"). The same resolved VALUE comes back now, just honestly tagged.
 */

export type SettingsResolutionSource = "property" | "workspace" | "account" | "default";

export type SettingsScopeInput = {
  managerUserId: string;
  propertyId?: string | null;
  workspaceId?: string | null;
};

export type ResolvedSettingsScope<T> = {
  value: T;
  source: SettingsResolutionSource;
};

export type NamespaceResolution<T> = {
  /** Normalize a raw stored value (property override, workspace row, or unknown) into `T`. */
  normalize: (raw: unknown) => T;
  /**
   * The account row loader — the namespace's existing `load<Namespace>Settings`
   * function, which already normalizes and already defaults when no row
   * exists. Omit only for a namespace with no account-level storage at all;
   * `defaultValue` answers in that case instead.
   */
  loadAccount?: (db: SupabaseClient, managerUserId: string) => Promise<T>;
  /** Used only when `loadAccount` is omitted. */
  defaultValue?: T;
};

/**
 * A per-request (or per-sweep) cache so resolving the same namespace for many
 * rows that share a manager or workspace does not re-query it every time.
 * Callers own the cache's lifetime — create one per HTTP request or per sweep
 * pass, never a module-level singleton (that would leak one manager's answer
 * to the next request).
 */
export type SettingsScopeCache = Map<string, unknown>;

export function createSettingsScopeCache(): SettingsScopeCache {
  return new Map<string, unknown>();
}

function cacheKey(parts: (string | null | undefined)[]): string {
  return parts.map((part) => part ?? "\u0000").join("\u0001");
}

/** Postgres `42P01` (undefined_table) or a PostgREST schema-cache "does not exist" message. */
function isMissingRelationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "42P01") return true;
  const message = String((error as { message?: unknown } | null)?.message ?? "").toLowerCase();
  return message.includes("does not exist") || message.includes("could not find the table");
}

async function resolveWorkspaceIdForProperty(
  db: SupabaseClient,
  cache: SettingsScopeCache,
  propertyId: string,
): Promise<string | null> {
  const key = cacheKey(["property-workspace", propertyId]);
  if (cache.has(key)) return cache.get(key) as string | null;
  const { data, error } = await db
    .from("manager_property_records")
    .select("workspace_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) throw error;
  const workspaceId = data?.workspace_id ? String(data.workspace_id) : null;
  cache.set(key, workspaceId);
  return workspaceId;
}

async function loadWorkspaceRowData(
  db: SupabaseClient,
  cache: SettingsScopeCache,
  workspaceId: string,
): Promise<Record<string, unknown> | null> {
  const key = cacheKey(["workspace-row", workspaceId]);
  if (cache.has(key)) return cache.get(key) as Record<string, unknown> | null;
  try {
    const { data, error } = await db
      .from("workspace_automation_settings")
      .select("row_data")
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) {
      if (isMissingRelationError(error)) {
        cache.set(key, null);
        return null;
      }
      throw error;
    }
    const rowData =
      data?.row_data && typeof data.row_data === "object" && !Array.isArray(data.row_data)
        ? (data.row_data as Record<string, unknown>)
        : null;
    cache.set(key, rowData);
    return rowData;
  } catch (error) {
    if (isMissingRelationError(error)) {
      cache.set(key, null);
      return null;
    }
    throw error;
  }
}

/**
 * Resolve one namespace for `(managerUserId, propertyId?, workspaceId?)`
 * through every rung. `managerUserId` is the ACCOUNT being read — the
 * workspace/property owner, not necessarily the authenticated caller; routes
 * resolve that with `assertSettingsScopeOwned` before calling this.
 */
export async function resolveSettingsScope<T>(
  db: SupabaseClient,
  input: SettingsScopeInput,
  namespace: OperationsNamespace,
  resolution: NamespaceResolution<T>,
  cache: SettingsScopeCache = createSettingsScopeCache(),
): Promise<ResolvedSettingsScope<T>> {
  const propertyId = input.propertyId?.trim() || null;
  let workspaceId = input.workspaceId?.trim() || null;

  if (propertyId) {
    const override = await loadPropertyOverride(db, input.managerUserId, propertyId, namespace);
    if (override != null) {
      return { value: resolution.normalize(override), source: "property" };
    }
    if (!workspaceId) {
      workspaceId = await resolveWorkspaceIdForProperty(db, cache, propertyId);
    }
  }

  if (workspaceId) {
    const rowData = await loadWorkspaceRowData(db, cache, workspaceId);
    const raw = rowData?.[namespace];
    if (raw != null) {
      return { value: resolution.normalize(raw), source: "workspace" };
    }
  }

  if (resolution.loadAccount) {
    return { value: await resolution.loadAccount(db, input.managerUserId), source: "account" };
  }
  return { value: resolution.normalize(resolution.defaultValue ?? undefined), source: "default" };
}

/** Ids of every workspace row that has its own stored value for a namespace, for a set of workspaces. */
export async function listWorkspaceOverrides(
  db: SupabaseClient,
  workspaceIds: readonly string[],
  namespace: OperationsNamespace,
): Promise<string[]> {
  const ids = [...new Set(workspaceIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  try {
    const { data, error } = await db.from("workspace_automation_settings").select("workspace_id, row_data").in("workspace_id", ids);
    if (error) {
      if (isMissingRelationError(error)) return [];
      throw error;
    }
    const out: string[] = [];
    for (const row of data ?? []) {
      const rowData = (row as { row_data?: unknown }).row_data;
      const value =
        rowData && typeof rowData === "object" && !Array.isArray(rowData) ? (rowData as Record<string, unknown>)[namespace] : null;
      if (value != null) out.push(String((row as { workspace_id: string }).workspace_id));
    }
    return out;
  } catch (error) {
    if (isMissingRelationError(error)) return [];
    throw error;
  }
}

/**
 * Write one namespace's value onto a workspace row — create-or-merge, never a
 * whole-row replace (sibling namespaces belong to other settings modules and
 * must survive this save, the same rule `saveReminderSettings` follows for
 * the account row).
 */
export async function saveWorkspaceNamespaceSettings(
  db: SupabaseClient,
  workspaceId: string,
  ownerUserId: string,
  namespace: OperationsNamespace,
  value: unknown,
): Promise<void> {
  const { data: existing, error: readError } = await db
    .from("workspace_automation_settings")
    .select("row_data")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readError && !isMissingRelationError(readError)) throw readError;
  const rowData =
    existing?.row_data && typeof existing.row_data === "object" && !Array.isArray(existing.row_data)
      ? { ...(existing.row_data as Record<string, unknown>) }
      : {};
  rowData[namespace] = value;
  const { error } = await db.from("workspace_automation_settings").upsert(
    {
      workspace_id: workspaceId,
      owner_user_id: ownerUserId,
      row_data: rowData,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw error;
}

/** Drop one workspace's stored value for a namespace. Idempotent. */
export async function clearWorkspaceNamespaceSettings(
  db: SupabaseClient,
  workspaceId: string,
  namespace: OperationsNamespace,
): Promise<void> {
  const { data: existing, error: readError } = await db
    .from("workspace_automation_settings")
    .select("row_data")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (readError) {
    if (isMissingRelationError(readError)) return;
    throw readError;
  }
  if (!existing?.row_data || typeof existing.row_data !== "object") return;
  const rowData = { ...(existing.row_data as Record<string, unknown>) };
  if (!(namespace in rowData)) return;
  delete rowData[namespace];
  const { error } = await db
    .from("workspace_automation_settings")
    .update({ row_data: rowData, updated_at: new Date().toISOString() })
    .eq("workspace_id", workspaceId);
  if (error) throw error;
}
