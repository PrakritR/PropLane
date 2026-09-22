import "server-only";

import { cookies } from "next/headers";
import { INVITE_PERMISSION_COLUMNS, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { collectLinkedPropertyPermissionsForUser } from "@/lib/auth/manager-lease-scope";
import {
  coManagerModuleAllowed,
  normalizePropertyCoManagerPermissions,
  type CoManagerPermissionId,
  type CoManagerPermissionLevel,
} from "@/lib/co-manager-permissions";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import { intersectPropertyScopes } from "@/lib/reports/workspace-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { loadWorkspaces } from "@/lib/workspaces/server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * Module-access rule for co-manager links. Assigning a property is NOT itself
 * the grant: the module must be positively granted on that property. See
 * `coManagerModuleAllowed`, which every scope check on both sides of the wire
 * shares, for why an empty map is now no access rather than all access.
 */
function moduleAllowed(
  propertyPerms: ReturnType<typeof normalizePropertyCoManagerPermissions> | undefined,
  propertyId: string,
  module: CoManagerPermissionId,
  level: CoManagerPermissionLevel = "read",
): boolean {
  return coManagerModuleAllowed(propertyPerms, propertyId, module, level);
}

/**
 * The OWNER (inviter) who granted this user co-manager access to `propertyId`,
 * resolved from the authoritative `account_link_invites` table — NOT the
 * client-writable relationship mirror. Returns null when no accepted link
 * assigns that property to the user (i.e. it is the user's own property or
 * unrelated). Used to attribute a co-manager's NEW row to the correct owner
 * without trusting a client-supplied owner id.
 */
export async function linkedOwnerForProperty(
  db: ServiceClient,
  userId: string,
  propertyId: string | null | undefined,
): Promise<string | null> {
  const pid = (propertyId ?? "").trim();
  if (!pid || !userId) return null;
  const { data } = await db
    .from("account_link_invites")
    .select("inviter_user_id, assigned_property_ids")
    .eq("invitee_user_id", userId)
    .eq("status", "accepted");
  for (const row of data ?? []) {
    const ids = Array.isArray(row.assigned_property_ids) ? row.assigned_property_ids.map(String) : [];
    if (ids.includes(pid) && row.inviter_user_id) return String(row.inviter_user_id);
  }
  return null;
}

/** Linked property ids on which this user (as an accepted co-manager) may use `module`. */
export async function linkedPropertyIdsForModule(
  db: ServiceClient,
  userId: string,
  module: CoManagerPermissionId,
): Promise<Set<string>> {
  const byProperty = await collectLinkedPropertyPermissionsForUser(db, userId);
  const out = new Set<string>();
  for (const [propertyId] of byProperty) {
    if (moduleAllowed(byProperty.get(propertyId), propertyId, module)) out.add(propertyId);
  }
  return out;
}

export type LinkedOwnerScope = {
  /** Owner (inviter) manager user ids where this user has `module` access on ≥1 assigned property. */
  ownerIds: Set<string>;
  propertyIdsByOwner: Map<string, Set<string>>;
  /** Property ids (across all owners) where `module` is allowed. */
  propertyIds: Set<string>;
};

/**
 * Owner-level scope for owner-keyed tables (e.g. the vendor directory, which
 * has no property column): a co-manager with `module` access on at least one
 * of an owner's assigned properties may read that owner's rows for the module.
 * Sandbox↔real account pairs are excluded, mirroring collectLinkedPropertyIdsForUser.
 */
export async function linkedOwnerScopeForModule(
  db: ServiceClient,
  userId: string,
  module: CoManagerPermissionId,
  level: CoManagerPermissionLevel = "read",
  options: { throwOnError?: boolean } = {},
): Promise<LinkedOwnerScope> {
  const ownerIds = new Set<string>();
  const propertyIds = new Set<string>();
  const propertyIdsByOwner = new Map<string, Set<string>>();
  try {
    const { data: viewerProfile, error: viewerError } = await db.from("profiles").select("email").eq("id", userId).maybeSingle();
    if (viewerError && options.throwOnError) throw viewerError;
    const viewerEmail = String(viewerProfile?.email ?? "").trim();

    const { data: linkRows, error } = await db
      .from("account_link_invites")
      .select(`inviter_user_id, ${INVITE_PERMISSION_COLUMNS}`)
      .eq("status", "accepted")
      .eq("invitee_user_id", userId);
    if (error) {
      if (options.throwOnError) throw error;
      return { ownerIds, propertyIds, propertyIdsByOwner };
    }

    const inviterIds = [
      ...new Set(
        (linkRows ?? [])
          .map((row) => String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const inviterEmailById = new Map<string, string>();
    if (inviterIds.length > 0) {
      const { data: profiles, error: profilesError } = await db.from("profiles").select("id, email").in("id", inviterIds);
      if (profilesError && options.throwOnError) throw profilesError;
      for (const profile of profiles ?? []) {
        const id = String(profile.id ?? "").trim();
        const email = String(profile.email ?? "").trim();
        if (id && email) inviterEmailById.set(id, email);
      }
    }

    for (const row of linkRows ?? []) {
      const inviterId = String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim();
      if (!inviterId) continue;
      if (isCrossSandboxPortalPair(viewerEmail, inviterEmailById.get(inviterId) ?? "")) continue;

      const assignedRaw = (row as { assigned_property_ids?: unknown }).assigned_property_ids;
      const assigned = Array.isArray(assignedRaw)
        ? assignedRaw.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim())
        : [];
      if (assigned.length === 0) continue;

      const perms = readPropertyPermissionsFromRow(row as Parameters<typeof readPropertyPermissionsFromRow>[0]);

      let ownerQualifies = false;
      for (const propertyId of assigned) {
        if (moduleAllowed(perms, propertyId, module, level)) {
          propertyIds.add(propertyId);
          const ownerProperties = propertyIdsByOwner.get(inviterId) ?? new Set<string>();
          ownerProperties.add(propertyId);
          propertyIdsByOwner.set(inviterId, ownerProperties);
          ownerQualifies = true;
        }
      }
      if (ownerQualifies) ownerIds.add(inviterId);
    }
  } catch (error) {
    if (options.throwOnError) throw error;
    /* table may not exist */
  }
  return { ownerIds, propertyIds, propertyIdsByOwner };
}

/**
 * The viewer plus every owner who granted them `module` at `level` on at least
 * one assigned property. Used by Communication (SMS and email) so a co-manager
 * sees the same owner-keyed threads the permission already covers.
 */
export async function viewerAndLinkedOwnerIdsForModule(
  db: ServiceClient,
  userId: string,
  module: CoManagerPermissionId,
  level: CoManagerPermissionLevel = "read",
): Promise<string[]> {
  const viewer = userId.trim();
  const ids = new Set<string>(viewer ? [viewer] : []);
  const { ownerIds } = await linkedOwnerScopeForModule(db, userId, module, level);
  for (const id of ownerIds) {
    if (id.trim()) ids.add(id.trim());
  }
  return [...ids];
}

/**
 * Active-workspace scope for a manager's OWN rows in a `row_data`-shaped
 * table. Mirrors `activeWorkspacePropertyScope`
 * (`@/lib/workspaces/scope.server`) for `propertyIds` — `null` = not
 * narrowing (workspace load failed, or the account has none); an array
 * (possibly empty) is the active workspace's property ids and DOES apply
 * even when empty.
 *
 * `untaggedOwnedVisible` mirrors `resolveCommunicationScope`'s field of the
 * same name (`@/lib/communication/conversation-visibility.server`): a row
 * tied to no house (an account-level or one-off row) is visible only when
 * the active workspace is the viewer's OWN DEFAULT workspace. Resolved here
 * directly (rather than composed from `activeWorkspacePropertyScope`)
 * because that helper does not expose which workspace it selected, only its
 * property ids — the same reason `resolveCommunicationScope` resolves its
 * own copy instead of calling it.
 */
export type ManagerWorkspaceRowScope = {
  propertyIds: string[] | null;
  untaggedOwnedVisible: boolean;
};

export async function resolveManagerWorkspaceRowScope(
  db: ServiceClient,
  viewerUserId: string,
): Promise<ManagerWorkspaceRowScope> {
  let workspaces;
  try {
    workspaces = await loadWorkspaces(db, viewerUserId);
  } catch {
    // A scope we cannot resolve must not silently narrow the read — same
    // fail-open-to-"don't narrow" contract as activeWorkspacePropertyScope.
    return { propertyIds: null, untaggedOwnedVisible: true };
  }
  if (workspaces.length === 0) return { propertyIds: null, untaggedOwnedVisible: true };
  const selected = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const active = workspaces.find((w) => w.id === selected) ?? workspaces[0];
  if (!active) return { propertyIds: null, untaggedOwnedVisible: true };
  return {
    propertyIds: [...new Set(active.propertyIds.map((id) => id.trim()).filter(Boolean))],
    untaggedOwnedVisible: active.owned && active.isDefault,
  };
}

/** Whether one row (by its property id, or none) is visible/writable under `scope`. Narrowing only. */
export function rowInWorkspaceScope(
  propertyId: string | null | undefined,
  scope: ManagerWorkspaceRowScope,
): boolean {
  if (scope.propertyIds === null) return true;
  const pid = (propertyId ?? "").trim();
  if (!pid) return scope.untaggedOwnedVisible;
  return scope.propertyIds.includes(pid);
}

/**
 * A PostgREST filter clause — usable standalone in `.or()`, or as one member
 * of a nested `and(...)` — that keeps only rows in the active workspace: any
 * of `propertyColumns` in `workspacePropertyIds`, or (when the workspace is
 * the viewer's own default) every one of `propertyColumns` null. Returns
 * `null` when nothing can match (e.g. an empty workspace with no-property
 * rows also not visible), meaning the caller should skip the branch/query.
 *
 * Callers pass an already-resolved non-null `workspacePropertyIds` (check
 * `scope.propertyIds !== null` first); a `null` scope means "don't narrow"
 * and should skip calling this at all.
 */
export function workspaceRowFilterClause(
  propertyColumns: string[],
  workspacePropertyIds: string[],
  untaggedOwnedVisible: boolean,
): string | null {
  const clauses: string[] = [];
  if (workspacePropertyIds.length > 0) {
    const idList = workspacePropertyIds.map((id) => `"${id}"`).join(",");
    for (const column of propertyColumns) clauses.push(`${column}.in.(${idList})`);
  }
  if (untaggedOwnedVisible) {
    clauses.push(
      propertyColumns.length === 1
        ? `${propertyColumns[0]}.is.null`
        : `and(${propertyColumns.map((column) => `${column}.is.null`).join(",")})`,
    );
  }
  if (clauses.length === 0) return null;
  return clauses.length === 1 ? clauses[0] : `or(${clauses.join(",")})`;
}

/**
 * Merge owned rows with linked-property rows for a `row_data`-shaped table.
 * `propertyColumns` are checked in order via `.in(column, ids)` queries; rows
 * are deduped by id with owned rows winning.
 *
 * `opts.workspaceScope` is OPT-IN per call and narrows both branches: the
 * owned-rows query gains the SQL predicate from `workspaceRowFilterClause`,
 * and the linked (co-manager) property ids are intersected with the active
 * workspace's property ids before the `.in()` fetch — a co-manager's granted
 * houses stay reachable, but only in the workspace that holds them (the same
 * workspace `loadWorkspaces` attributes them to). Omitting it preserves the
 * exact prior behavior for callers that have not opted in (e.g. the
 * attention digest) — this is never a default.
 */
export async function fetchRowsForManagerWithLinked<T extends { id: string }>(
  db: ServiceClient,
  table: string,
  userId: string,
  linkedPropertyIds: Set<string>,
  opts?: { select?: string; propertyColumns?: string[]; limit?: number; workspaceScope?: ManagerWorkspaceRowScope },
): Promise<T[]> {
  const select = opts?.select ?? "id, row_data, updated_at";
  const propertyColumns = opts?.propertyColumns ?? ["property_id"];
  const limit = opts?.limit ?? 500;
  const workspaceScope = opts?.workspaceScope;
  const narrowingWorkspaceIds =
    workspaceScope && workspaceScope.propertyIds !== null ? workspaceScope.propertyIds : null;

  const byId = new Map<string, T>();
  if (!narrowingWorkspaceIds) {
    const { data: ownedRows, error: ownedError } = await db
      .from(table)
      .select(select)
      .eq("manager_user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (ownedError) throw ownedError;
    for (const row of (ownedRows ?? []) as unknown as T[]) {
      if (row.id) byId.set(row.id, row);
    }
  } else {
    const filter = workspaceRowFilterClause(propertyColumns, narrowingWorkspaceIds, workspaceScope!.untaggedOwnedVisible);
    if (filter) {
      const { data: ownedRows, error: ownedError } = await db
        .from(table)
        .select(select)
        .eq("manager_user_id", userId)
        .or(filter)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (ownedError) throw ownedError;
      for (const row of (ownedRows ?? []) as unknown as T[]) {
        if (row.id) byId.set(row.id, row);
      }
    }
    // else: the active workspace can hold none of this manager's own rows — skip.
  }

  const scopedLinkedIds = narrowingWorkspaceIds
    ? (intersectPropertyScopes([...linkedPropertyIds], narrowingWorkspaceIds) ?? [])
    : [...linkedPropertyIds];

  if (scopedLinkedIds.length > 0) {
    for (const column of propertyColumns) {
      const { data: linkedRows, error: linkedError } = await db
        .from(table)
        .select(select)
        .in(column, scopedLinkedIds)
        .order("updated_at", { ascending: false })
        .limit(limit);
      if (linkedError) {
        // Column may not exist on this table — skip rather than fail the request.
        continue;
      }
      for (const row of (linkedRows ?? []) as unknown as T[]) {
        if (row.id && !byId.has(row.id)) byId.set(row.id, row);
      }
    }
  }

  return [...byId.values()];
}
