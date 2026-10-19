import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import type { ActiveWorkspace } from "@/lib/workspaces/active.server";

/**
 * What a signed-in teammate may do with Communication in one workspace.
 *
 * House membership is NOT a grant (`docs/agents/co-manager-access.md`): the Communication (`inbox`)
 * module has to be positively granted on the house, at `edit` to change anything. The owner of the
 * workspace keeps every house. `grantedPropertyIds` is null for the owner and otherwise the houses of
 * THIS workspace the viewer holds the module on at the asked level.
 */
export type CommunicationGrant = {
  isOwner: boolean;
  grantedPropertyIds: Set<string> | null;
};

export type CommunicationGrantResult =
  | { ok: true; grant: CommunicationGrant }
  | { ok: false; status: 403 | 503; error: string };

export async function resolveCommunicationGrant(
  db: SupabaseClient,
  userId: string,
  workspace: Pick<ActiveWorkspace, "ownerUserId" | "propertyIds">,
  level: "read" | "edit",
): Promise<CommunicationGrantResult> {
  if (workspace.ownerUserId === userId) return { ok: true, grant: { isOwner: true, grantedPropertyIds: null } };
  let granted: Set<string>;
  try {
    const scope = await linkedOwnerScopeForModule(db, userId, "inbox", level, { throwOnError: true });
    const houses = new Set(workspace.propertyIds.map(String));
    granted = new Set([...(scope.propertyIdsByOwner.get(workspace.ownerUserId) ?? [])].filter((id) => houses.has(String(id))));
  } catch {
    return { ok: false, status: 503, error: "Could not verify your access. Try again." };
  }
  if (granted.size === 0) return { ok: false, status: 403, error: "You do not have access to Communication for this workspace." };
  return { ok: true, grant: { isOwner: false, grantedPropertyIds: granted } };
}

/** May this grant act on `propertyId`? The owner may on any house of the workspace. */
export function grantCoversHouse(grant: CommunicationGrant, propertyId: string): boolean {
  return grant.grantedPropertyIds === null || grant.grantedPropertyIds.has(propertyId);
}
