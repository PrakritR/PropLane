import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { linkedOwnerScopeForModule } from "@/lib/auth/co-manager-module-scope";
import { loadWorkspaceHouseLabels } from "@/lib/manager-sms-messages.server";

/** Owner scope is not a grant on every house owned by that person. */
export async function loadAssignableConversationHouses(db: SupabaseClient, viewerId: string) {
  const scope = await linkedOwnerScopeForModule(db, viewerId, "inbox", "edit", { throwOnError: true });
  const workspaceHouses = await loadWorkspaceHouseLabels(db, [viewerId, ...scope.ownerIds], { throwOnError: true });
  const assignable = new Map(
    [...workspaceHouses].filter(([id, house]) => house.ownerUserId === viewerId || scope.propertyIdsByOwner.get(house.ownerUserId)?.has(id)),
  );
  return { assignable, workspaceHouses };
}

export function canReplaceConversationHouses({
  viewerId, ownerId, currentIds, nextIds, assignable, workspaceHouses,
}: {
  viewerId: string;
  ownerId: string;
  currentIds: string[];
  nextIds: string[];
  assignable: Map<string, { ownerUserId: string }>;
  workspaceHouses: Map<string, { ownerUserId: string }>;
}): boolean {
  if (!ownerId) return false;
  const eligible = (id: string) => assignable.get(id)?.ownerUserId === ownerId;
  if (!nextIds.every(eligible)) return false;
  if (viewerId === ownerId) return true;
  if (!currentIds.every(eligible)) return false;
  // Untagged threads are workspace-wide. Creating/clearing that state needs
  // edit access to every house, not an edit grant on just one of them.
  if (currentIds.length === 0 || nextIds.length === 0) {
    const all = [...workspaceHouses].filter(([, house]) => house.ownerUserId === ownerId);
    return all.length > 0 && all.every(([id]) => eligible(id));
  }
  return true;
}
