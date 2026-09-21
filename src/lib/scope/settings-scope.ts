import "server-only";

import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import type { CoManagerPermissionId, CoManagerPermissionLevel } from "@/lib/co-manager-permissions";
import { track } from "@/lib/analytics/posthog";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { SettingsResolutionSource } from "@/lib/settings/scope-resolver.server";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * Shared `?workspaceId=&propertyId=` parsing and ownership check for the
 * eight settings routes (PLAN-0920-0845 phase B).
 */

export type ParsedSettingsScope = {
  workspaceId?: string;
  propertyId?: string;
};

function readTrimmedString(source: unknown, key: string): string | undefined {
  if (!source) return undefined;
  if (source instanceof URLSearchParams) {
    const raw = source.get(key);
    return raw?.trim() ? raw.trim() : undefined;
  }
  if (typeof source !== "object" || Array.isArray(source)) return undefined;
  const raw = (source as Record<string, unknown>)[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** Parse `{ workspaceId?, propertyId? }` out of a `URLSearchParams` or a JSON body. */
export function parseSettingsScope(source: URLSearchParams | Record<string, unknown> | null | undefined): ParsedSettingsScope {
  const workspaceId = readTrimmedString(source, "workspaceId");
  const propertyId = readTrimmedString(source, "propertyId");
  return {
    ...(workspaceId ? { workspaceId } : {}),
    ...(propertyId ? { propertyId } : {}),
  };
}

/**
 * The query string and the body both named in the brief ("the same in the
 * body or query"); the body wins, matching the existing `propertyId` idiom in
 * `reminder-settings/route.ts` ("`propertyId` may ride in the body … or the
 * query; the body wins").
 */
export function resolveSettingsScopeParams(requestUrl: string, body?: Record<string, unknown> | null): ParsedSettingsScope {
  const fromQuery = parseSettingsScope(new URL(requestUrl).searchParams);
  const fromBody = parseSettingsScope(body ?? undefined);
  return { ...fromQuery, ...fromBody };
}

export type SettingsScopeAccess =
  | {
      ok: true;
      /** The account this scope resolves against — the workspace/property owner, which may differ from the caller. */
      ownerUserId: string;
      workspaceId: string | null;
      propertyId: string | null;
    }
  | { ok: false; status: 403; error: string };

/**
 * Refuse a `workspaceId` the caller does not own (or, with `opts.module`,
 * does not hold that co-manager module permission on at least one property
 * in), and a `propertyId` not in that workspace or not reachable by the
 * caller — reusing the existing workspace ownership reader
 * (`portal_workspaces.owner_user_id`) and the existing per-property
 * co-manager permission reader (`managerHasCoManagerPermissionForProperty`,
 * the same one `assertCoManagerModuleAccess` uses) rather than a new query.
 *
 * `opts.module` omitted means ownership-only: the scope must be the caller's
 * own workspace or property. Every one of the eight routes already resolves
 * its own `CoManagerPermissionId` for its existing module gate, so they pass
 * the same one here.
 */
export async function assertSettingsScopeOwned(
  db: ServiceClient,
  callerUserId: string,
  scope: ParsedSettingsScope,
  opts?: { module?: CoManagerPermissionId; level?: CoManagerPermissionLevel },
): Promise<SettingsScopeAccess> {
  const level = opts?.level ?? "read";
  const propertyId = scope.propertyId?.trim() || null;
  const workspaceId = scope.workspaceId?.trim() || null;

  if (propertyId) {
    const { data, error } = await db
      .from("manager_property_records")
      .select("id, manager_user_id, workspace_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (error) throw error;
    const ownerUserId = data?.manager_user_id ? String(data.manager_user_id) : "";
    if (!ownerUserId) {
      return { ok: false, status: 403, error: "That property is not in your workspace." };
    }
    const propertyWorkspaceId = data?.workspace_id ? String(data.workspace_id) : null;
    if (workspaceId && propertyWorkspaceId && propertyWorkspaceId !== workspaceId) {
      return { ok: false, status: 403, error: "That property is not in that workspace." };
    }
    if (ownerUserId === callerUserId) {
      return { ok: true, ownerUserId, workspaceId: propertyWorkspaceId ?? workspaceId, propertyId };
    }
    if (!opts?.module) {
      return { ok: false, status: 403, error: "That property is not in your workspace." };
    }
    const allowed = await managerHasCoManagerPermissionForProperty(db, callerUserId, propertyId, opts.module, level);
    if (!allowed) {
      return { ok: false, status: 403, error: "You do not have access to this section for this property." };
    }
    return { ok: true, ownerUserId, workspaceId: propertyWorkspaceId ?? workspaceId, propertyId };
  }

  if (workspaceId) {
    const { data, error } = await db.from("portal_workspaces").select("id, owner_user_id").eq("id", workspaceId).maybeSingle();
    if (error) throw error;
    const ownerUserId = data?.owner_user_id ? String(data.owner_user_id) : "";
    if (!ownerUserId) {
      return { ok: false, status: 403, error: "That workspace is not yours." };
    }
    if (ownerUserId === callerUserId) {
      return { ok: true, ownerUserId, workspaceId, propertyId: null };
    }
    if (!opts?.module) {
      return { ok: false, status: 403, error: "That workspace is not yours." };
    }
    const { data: properties, error: propertiesError } = await db
      .from("manager_property_records")
      .select("id")
      .eq("workspace_id", workspaceId);
    if (propertiesError) throw propertiesError;
    for (const property of properties ?? []) {
      const id = String((property as { id: string }).id);
      if (await managerHasCoManagerPermissionForProperty(db, callerUserId, id, opts.module, level)) {
        return { ok: true, ownerUserId, workspaceId, propertyId: null };
      }
    }
    return { ok: false, status: 403, error: "You do not have access to this workspace's settings." };
  }

  return { ok: true, ownerUserId: callerUserId, workspaceId: null, propertyId: null };
}

export type SettingsScopeChangeScope = "account" | "workspace" | "properties";

/** The write's rung, in the `settings_scope_changed` event's vocabulary. */
export function settingsScopeChangeScopeFor(rung: "property" | "workspace" | "account"): SettingsScopeChangeScope {
  if (rung === "property") return "properties";
  if (rung === "workspace") return "workspace";
  return "account";
}

/** How many properties a write at `rung` touched — 1 for a house, the workspace's own count for a workspace save, else the whole account. */
export async function countScopedProperties(
  db: ServiceClient,
  rung: "property" | "workspace" | "account",
  ownerUserId: string,
  workspaceId: string | null,
): Promise<number> {
  if (rung === "property") return 1;
  if (rung === "workspace" && workspaceId) {
    const { count } = await db
      .from("manager_property_records")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId);
    return count ?? 0;
  }
  const { count } = await db
    .from("manager_property_records")
    .select("id", { count: "exact", head: true })
    .eq("manager_user_id", ownerUserId);
  return count ?? 0;
}

/**
 * Emit `settings_scope_changed` from a settings write. `module` names the
 * settings surface (e.g. `"reminders"`, `"task_automation"`); `rung` is which
 * storage the write actually landed on. Never PII — `module`/`scope` are
 * fixed enums and `count` is a number, matching the `object_action` /
 * non-PII convention every other server-side `track()` call follows.
 */
export async function trackSettingsScopeChanged(
  db: ServiceClient,
  actorUserId: string,
  input: {
    module: string;
    rung: "property" | "workspace" | "account";
    ownerUserId: string;
    workspaceId: string | null;
    /** Override the computed count — e.g. a batch property write that touched more than one house. */
    count?: number;
  },
): Promise<void> {
  // Analytics must never break a request (the same rule `track()` itself
  // follows) — a count query failing, or a test's minimal fake database not
  // implementing it, must not turn a successful settings write into a 500.
  let count = input.count;
  if (count === undefined) {
    try {
      count = await countScopedProperties(db, input.rung, input.ownerUserId, input.workspaceId);
    } catch {
      count = 0;
    }
  }
  track("settings_scope_changed", actorUserId, {
    module: input.module,
    scope: settingsScopeChangeScopeFor(input.rung),
    count,
  });
}

/** Map a resolved GET `source` onto the same write-rung vocabulary, for callers that only have a `SettingsResolutionSource`. */
export function writeRungFromSource(source: SettingsResolutionSource): "property" | "workspace" | "account" {
  return source === "property" ? "property" : source === "workspace" ? "workspace" : "account";
}
