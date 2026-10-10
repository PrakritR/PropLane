import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { ActiveWorkspace } from "@/lib/workspaces/active.server";

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * The workspace listings whose LEADS this viewer may read.
 *
 * A lead carries an applicant's or tour requester's name and email, so
 * `workspace.propertyIds` is not enough on its own: a property joins that set
 * when the co-manager holds ANY module on it (that is workspace membership, not
 * a grant). The identities are gated exactly as the Applications list gates
 * them — the owner's own houses, plus the linked houses carrying `applications`
 * or `residents`.
 */
export async function leadReadablePropertyIds(
  db: SupabaseClient,
  userId: string,
  workspace: ActiveWorkspace,
): Promise<string[]> {
  if (workspace.propertyIds.length === 0) return [];
  if (workspace.owned) return [...workspace.propertyIds];
  const [appIds, residentIds] = await Promise.all([
    linkedPropertyIdsForModule(db as ServiceClient, userId, "applications"),
    linkedPropertyIdsForModule(db as ServiceClient, userId, "residents"),
  ]);
  return workspace.propertyIds.filter((id) => appIds.has(id) || residentIds.has(id));
}
