import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { listManagedWorkspacesForOwner } from "@/lib/owner-management/policies.server";
import { ownerWorkspaceKey, type OwnerGrant } from "@/lib/property-owner/access.server";
import type { OwnerWorkspaceTile } from "@/lib/property-owner/projection";

/**
 * The workspaces an owner is a member of, for the rail's tiles. Built from the membership (`grants`), never a request. A
 * workspace is `managed` when the owner is the owner of record of an accepted PropLane fee policy in it; a read that fails
 * only means "not managed", never a missing tile.
 */
export async function loadOwnerWorkspaces(db: SupabaseClient, userId: string, grants: OwnerGrant[]): Promise<OwnerWorkspaceTile[]> {
  const live = grants.filter((grant) => grant.houses.length > 0);
  const ids = [...new Set(live.map((g) => g.workspaceId).filter(Boolean))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data } = await db.from("portal_workspaces").select("id, name").in("id", ids);
    for (const row of (data ?? []) as { id: unknown; name: unknown }[]) names.set(String(row.id), String(row.name ?? "").trim());
  }
  let managed = new Set<string>();
  try {
    managed = new Set((await listManagedWorkspacesForOwner(db, userId)).map((w) => w.workspaceId));
  } catch {
    managed = new Set();
  }
  return live.map((grant, index) => ({
    id: ownerWorkspaceKey(grant),
    label: names.get(grant.workspaceId) || `Workspace ${index + 1}`,
    houses: grant.houses.length,
    managed: managed.has(grant.workspaceId),
  }));
}
