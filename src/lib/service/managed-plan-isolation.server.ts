import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Plan isolation (design R4): a PropLane-managed (`is_service`) workspace is PropLane's own operation, owned by the
 * platform service owner (the admin). Its houses, residents and seats are never counted against, limited by, or billed
 * to the admin's OWN plan: the plan quota, the Free door cap, the door count that bills, the workspace/property/team
 * usage a plan card shows and the communication gate all read through this module. One definition of "managed" - the
 * `portal_workspaces.is_service` flag - and one rule: a read that fails is an error, never "no managed houses".
 */

const MISSING_SCHEMA_CODES = new Set(["42703", "42P01", "PGRST204", "PGRST205"]);

/** The managed workspaces `ownerUserId` owns (empty before the `is_service` column exists). Throws on any other read failure. */
export async function managedWorkspaceIdsOwnedBy(db: SupabaseClient, ownerUserId: string): Promise<string[]> {
  const owner = ownerUserId.trim();
  if (!owner) return [];
  const { data, error } = await db.from("portal_workspaces").select("id").eq("owner_user_id", owner).eq("is_service", true);
  if (error) {
    if (MISSING_SCHEMA_CODES.has(String(error.code ?? ""))) return [];
    throw new Error("Could not read managed workspaces.");
  }
  return (data ?? []).map((row) => String((row as { id?: unknown }).id ?? "").trim()).filter(Boolean);
}

/** Is this one workspace managed? Throws on a failed read (callers fail closed). */
export async function isManagedWorkspace(db: SupabaseClient, workspaceId: string | null | undefined): Promise<boolean> {
  const id = (workspaceId ?? "").trim();
  if (!id) return false;
  const { data, error } = await db.from("portal_workspaces").select("is_service").eq("id", id).maybeSingle();
  if (error) {
    if (MISSING_SCHEMA_CODES.has(String(error.code ?? ""))) return false;
    throw new Error("Could not read the workspace.");
  }
  return (data as { is_service?: unknown } | null)?.is_service === true;
}

/**
 * PostgREST `or` filter that keeps a house OUT of the managed workspaces: no workspace at all, or one that is not in the
 * list. (A bare `not.in` would drop the NULL rows too.) Null when there is nothing to exclude.
 */
export function notInManagedWorkspacesFilter(managedIds: readonly string[]): string | null {
  const ids = managedIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  return ids.length === 0 ? null : `workspace_id.is.null,workspace_id.not.in.(${ids.join(",")})`;
}
