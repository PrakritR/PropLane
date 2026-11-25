import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadServiceStaffScope } from "@/lib/service/service-mode.server";
import { serviceStaffSettingsAccess } from "@/lib/scope/settings-scope";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";

/** A managed application belongs to the active workspace, including when its staff actor is an admin. */
export async function resolveManagedApplicationOwner(
  db: SupabaseClient,
  actorId: string,
  propertyIds: ReadonlySet<string>,
  storedOwner: string | null,
): Promise<{ ok: boolean; owner: string | null } | null> {
  const scope = await loadServiceStaffScope(db, actorId);
  if (!scope) return null;
  const refused = { ok: false, owner: null };
  if (!propertyIds.size || [...propertyIds].some((id) => !scope.propertyIds.includes(id))) return refused;
  const access = await serviceStaffSettingsAccess(db, actorId, scope.workspaceId, "read");
  if (access.kind !== "ok") return refused;
  // A legacy staff-authored application may be corrected; another owner's existing row may not be adopted.
  if (storedOwner && storedOwner !== actorId && storedOwner !== access.ownerUserId) return refused;
  const { data, error } = await db.from("manager_property_records")
    .select("id,manager_user_id,workspace_id").in("id", [...propertyIds]);
  if (error || data?.length !== propertyIds.size || data.some((row) =>
    row.manager_user_id !== access.ownerUserId || row.workspace_id !== scope.workspaceId)) return refused;
  if (!access.fullGrant) {
    for (const id of propertyIds) {
      const allowed = await managerHasCoManagerPermissionForProperty(db, actorId, id, "applications", "edit", { strict: true }) ||
        await managerHasCoManagerPermissionForProperty(db, actorId, id, "residents", "edit", { strict: true });
      if (!allowed) return refused;
    }
  }
  return { ok: true, owner: access.ownerUserId };
}
