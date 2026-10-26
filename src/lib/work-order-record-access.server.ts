import "server-only";

import {
  linkedPropertyIdsForModule,
  resolveManagerWorkspaceRowScope,
  rowInWorkspaceScope,
} from "@/lib/auth/co-manager-module-scope";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Property ids this manager may act on: the ones they own outright plus those
 * shared with them through an accepted co-manager link carrying Services
 * access. */
export async function managerScopedPropertyIds(db: Db, userId: string): Promise<Set<string>> {
  const ids = await linkedPropertyIdsForModule(db, userId, "services");
  const { data: ownedProps } = await db
    .from("manager_property_records")
    .select("id")
    .eq("manager_user_id", userId)
    .limit(500);
  for (const prop of ownedProps ?? []) {
    const id = String((prop as { id?: unknown }).id ?? "").trim();
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Who may read one service record: its owning manager, the vendor doing the work, or a manager
 * holding the record's house — owned or shared through an accepted co-manager link with Services
 * access — in the active workspace. The same admission the record list grants, so a section of a
 * record a co-manager can open never comes back empty for them.
 */
export async function mayReadWorkOrderRecord(
  db: Db,
  userId: string,
  record: {
    managerUserId: string | null | undefined;
    vendorUserId: string | null | undefined;
    rowData: DemoManagerWorkOrderRow | null | undefined;
  },
): Promise<boolean> {
  if (!userId) return false;
  if (record.managerUserId === userId || record.vendorUserId === userId) return true;
  const propertyId = String(record.rowData?.assignedPropertyId ?? record.rowData?.propertyId ?? "").trim();
  if (!propertyId) return false;
  const [scopedPropertyIds, workspaceScope] = await Promise.all([
    managerScopedPropertyIds(db, userId),
    resolveManagerWorkspaceRowScope(db, userId),
  ]);
  return scopedPropertyIds.has(propertyId) && rowInWorkspaceScope(propertyId, workspaceScope);
}
