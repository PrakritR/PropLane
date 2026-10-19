import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import type { CoManagerPermissionLevel } from "@/lib/co-manager-permissions";
import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveAuthenticatedBusinessAccess } from "@/lib/test-workspaces/index.server";
import { resolveActiveWorkspaceFromRequest, type ActiveWorkspace } from "@/lib/workspaces/active.server";

/**
 * Who may read or change a workspace's dispatch rules and runs (vendor-dispatch-1018).
 *
 * The workspace is re-derived from the session and the workspace cookie, never
 * from the body. The owner may do everything in it. A co-manager needs the
 * Services module on the houses involved, at `edit` to change anything
 * (`docs/agents/co-manager-access.md`: assigning a house is not a grant).
 */
export type DispatchActor = {
  userId: string;
  workspace: ActiveWorkspace;
  /** The workspace owner (rows are keyed on this id). */
  ownerUserId: string;
  isOwner: boolean;
  /**
   * Houses of the workspace the viewer holds Services on at the asked level.
   * Null = the owner (every house, and workspace-wide rows).
   */
  grantedPropertyIds: Set<string> | null;
};

export type DispatchActorResult =
  | { ok: true; db: SupabaseClient; actor: DispatchActor }
  | { ok: false; response: NextResponse };

function fail(status: number, error: string): { ok: false; response: NextResponse } {
  return { ok: false, response: NextResponse.json({ error }, { status }) };
}

/** Postgres 42P01 / 42703 and PostgREST PGRST205: the dispatch tables are not there yet (code runs before migrations). */
export function isMissingDispatchRelation(error: { code?: string } | null | undefined): boolean {
  const code = error?.code;
  return code === "42P01" || code === "42703" || code === "PGRST205" || code === "PGRST204";
}

/** Resolve the signed-in manager (or co-manager) for the active workspace. */
export async function authorizeDispatchActor(
  level: CoManagerPermissionLevel,
): Promise<DispatchActorResult> {
  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) return fail(401, "Unauthorized.");

  const db = createSupabaseServiceRoleClient();
  if ((await resolveAuthenticatedBusinessAccess(user.id, db)).kind === "denied") {
    return fail(403, "Vendor access is unavailable for this account.");
  }
  // `profile_roles` is the authority; `profiles.role` is the role the account was created as.
  if (!(await userHoldsManagerRole(db, user.id, user.user_metadata?.role)) && !(await isAdminUser(user.id))) {
    return fail(403, "Forbidden.");
  }
  // Owner-only refusal seam (retired: owners use the Property portal).
  const ownerRefusal = await refuseOwnerOnly(db, user.id);
  if (ownerRefusal) return { ok: false, response: ownerRefusal };

  let workspace: ActiveWorkspace;
  try {
    workspace = await resolveActiveWorkspaceFromRequest(db, user.id);
  } catch {
    return fail(503, "Could not resolve your workspace. Try again.");
  }
  return actorForWorkspace(db, user.id, workspace, level);
}

export async function actorForWorkspace(
  db: SupabaseClient,
  userId: string,
  workspace: ActiveWorkspace,
  level: CoManagerPermissionLevel,
): Promise<DispatchActorResult> {
  const ownerUserId = workspace.ownerUserId;
  if (ownerUserId === userId) {
    return { ok: true, db, actor: { userId, workspace, ownerUserId, isOwner: true, grantedPropertyIds: null } };
  }
  let granted: Set<string>;
  try {
    const scope = await linkedOwnerScopeForModule(db, userId, "services", level, { throwOnError: true });
    const houses = new Set(workspace.propertyIds.map(String));
    granted = new Set([...(scope.propertyIdsByOwner.get(ownerUserId) ?? [])].filter((id) => houses.has(id)));
  } catch {
    return fail(503, "Could not verify your access. Try again.");
  }
  if (granted.size === 0) return fail(403, "You do not have access to Services for this workspace.");
  return { ok: true, db, actor: { userId, workspace, ownerUserId, isOwner: false, grantedPropertyIds: granted } };
}

/**
 * May the actor reach a rule or run that covers these houses?
 * `scope: "all"` (workspace-wide) needs every house of the workspace; a selected
 * list needs every listed house. A run on a house reads as a one-house list; a
 * run with no house is the owner's alone.
 */
export function actorCoversHouses(
  actor: DispatchActor,
  covers: { scope: "all" } | { scope: "selected"; propertyIds: readonly string[] },
): boolean {
  if (actor.grantedPropertyIds === null) return true;
  if (covers.scope === "all") {
    const houses = actor.workspace.propertyIds.map(String);
    return houses.length > 0 && houses.every((id) => actor.grantedPropertyIds!.has(id));
  }
  return covers.propertyIds.length > 0 && covers.propertyIds.every((id) => actor.grantedPropertyIds!.has(id));
}

/** A co-manager may SEE a rule when any house it covers is theirs (a workspace-wide rule: any granted house). */
export function actorSeesAnyHouse(
  actor: DispatchActor,
  covers: { scope: "all" } | { scope: "selected"; propertyIds: readonly string[] },
): boolean {
  if (actor.grantedPropertyIds === null) return true;
  if (covers.scope === "all") return actor.grantedPropertyIds.size > 0;
  return covers.propertyIds.some((id) => actor.grantedPropertyIds!.has(id));
}
