import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { asStringArray, readPropertyPermissionsFromRow } from "@/lib/account-link-invite-row";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import {
  CO_MANAGER_PERMISSION_OPTIONS,
  hasCoManagerPermission,
  mergeCoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import type { PortalWorkspace } from "./types";

/** Workspace selection narrows already-authorized data; it never grants access. */
export async function loadWorkspaces(db: SupabaseClient, userId: string): Promise<PortalWorkspace[]> {
  const [owned, links] = await Promise.all([
    db.from("portal_workspaces").select("id,name,owner_user_id,is_default").eq("owner_user_id", userId).order("created_at"),
    db.from("account_link_invites").select("inviter_user_id,assigned_property_ids,property_co_manager_permissions,co_manager_permissions")
      .eq("invitee_user_id", userId).eq("status", "accepted"),
  ]);
  if (owned.error || links.error) throw new Error("Could not load workspace access. Please retry.");
  const participantIds = [...new Set([userId, ...(links.data ?? []).map((link) => link.inviter_user_id)])];
  const profiles = await db.from("profiles").select("id,email").in("id", participantIds);
  if (profiles.error) throw new Error("Could not verify workspace participants. Please retry.");
  const emails = new Map((profiles.data ?? []).map((p) => [p.id, p.email ?? ""]));
  const permissions: PropertyCoManagerPermissions = {};
  const assigned = new Set<string>();
  for (const link of links.data ?? []) {
    if (!emails.has(userId) || !emails.has(link.inviter_user_id)) continue;
    if (isCrossSandboxPortalPair(emails.get(userId)!, emails.get(link.inviter_user_id)!)) continue;
    const ids = asStringArray(link.assigned_property_ids);
    const map = readPropertyPermissionsFromRow(link);
    for (const id of ids) {
      if (CO_MANAGER_PERMISSION_OPTIONS.some(({ id: module }) => hasCoManagerPermission(map[id], module))) {
        assigned.add(id);
        // The complete module checks still run in the existing record endpoints.
        permissions[id] = mergeCoManagerPermissions([{ coManagerPermissions: permissions[id] }, { coManagerPermissions: map[id] }]);
      }
    }
  }
  const ownedProperties = await db.from("manager_property_records").select("id,workspace_id").eq("manager_user_id", userId);
  if (ownedProperties.error) throw new Error("Could not load workspace properties. Please retry.");
  const linkedProperties = assigned.size
    ? await db.from("manager_property_records").select("id,workspace_id").in("id", [...assigned])
    : { data: [], error: null };
  if (linkedProperties.error) throw new Error("Could not load shared workspace properties. Please retry.");
  const sharedIds = [...new Set((linkedProperties.data ?? []).map((p) => p.workspace_id).filter(Boolean))];
  const shared = sharedIds.length
    ? await db.from("portal_workspaces").select("id,name,owner_user_id,is_default").in("id", sharedIds).order("created_at")
    : { data: [], error: null };
  if (shared.error) throw new Error("Could not load shared workspaces. Please retry.");
  const properties = [...(ownedProperties.data ?? []), ...(linkedProperties.data ?? [])];
  const rows = new Map([...(owned.data ?? []), ...(shared.data ?? [])].map((w) => [w.id, w]));
  return [...rows.values()].map((w) => {
    const propertyIds = [...new Set(properties.filter((p) => p.workspace_id === w.id).map((p) => p.id))];
    return {
      id: w.id, name: w.name, ownerUserId: w.owner_user_id,
      owned: w.owner_user_id === userId, isDefault: w.is_default,
      propertyIds,
      propertyPermissions: Object.fromEntries(propertyIds.filter((id) => permissions[id]).map((id) => [id, permissions[id]])),
    };
  });
}
