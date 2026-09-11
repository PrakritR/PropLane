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
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { maxAccountLinksForTier, maxPropertiesForManagerTier } from "@/lib/manager-access";
import {
  WORKSPACE_LIMIT,
  WORKSPACE_PLAN_ENTITLEMENTS,
  WORKSPACE_PROPERTY_LIMIT,
  type PortalWorkspace,
  type WorkspaceMember,
  type WorkspacePlan,
} from "./types";

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
  const ownedProperties = await db.from("manager_property_records").select("id,workspace_id,row_data").eq("manager_user_id", userId);
  if (ownedProperties.error) throw new Error("Could not load workspace properties. Please retry.");
  const linkedProperties = assigned.size
    ? await db.from("manager_property_records").select("id,workspace_id,row_data").in("id", [...assigned])
    : { data: [], error: null };
  if (linkedProperties.error) throw new Error("Could not load shared workspace properties. Please retry.");
  const sharedIds = [...new Set((linkedProperties.data ?? []).map((p) => p.workspace_id).filter(Boolean))];
  const shared = sharedIds.length
    ? await db.from("portal_workspaces").select("id,name,owner_user_id,is_default").in("id", sharedIds).order("created_at")
    : { data: [], error: null };
  if (shared.error) throw new Error("Could not load shared workspaces. Please retry.");
  const properties = [...(ownedProperties.data ?? []), ...(linkedProperties.data ?? [])];
  const labelFor = (row: { id: string; row_data?: unknown }) => {
    const data = row.row_data && typeof row.row_data === "object" ? (row.row_data as Record<string, unknown>) : {};
    const name = typeof data.buildingName === "string" ? data.buildingName.trim() : "";
    const address = typeof data.address === "string" ? data.address.trim() : "";
    return name || address || "Untitled property";
  };
  const rows = new Map([...(owned.data ?? []), ...(shared.data ?? [])].map((w) => [w.id, w]));

  // Managers this owner has granted access — grouped per workspace by the
  // houses they were assigned. This is a display roll-up of the existing
  // co-manager grants, never a second authorization source.
  const grantsOut = await db
    .from("account_link_invites")
    .select("invitee_user_id, assigned_property_ids, property_co_manager_permissions, co_manager_permissions")
    .eq("inviter_user_id", userId)
    .eq("status", "accepted");
  const inviteeIds = [...new Set((grantsOut.data ?? []).map((l) => l.invitee_user_id).filter(Boolean))] as string[];
  const inviteeProfiles = inviteeIds.length
    ? await db.from("profiles").select("id, full_name, email").in("id", inviteeIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const inviteeById = new Map((inviteeProfiles.data ?? []).map((p) => [p.id as string, p]));

  return [...rows.values()].map((w) => {
    const propertyIds = [...new Set(properties.filter((p) => p.workspace_id === w.id).map((p) => p.id))];
    const ownedHere = w.owner_user_id === userId;
    const members: WorkspaceMember[] = ownedHere
      ? (grantsOut.data ?? [])
          .map((link): WorkspaceMember | null => {
            const inviteeId = String(link.invitee_user_id ?? "");
            if (!inviteeId) return null;
            const assigned = asStringArray(link.assigned_property_ids).filter((id) => propertyIds.includes(id));
            if (assigned.length === 0) return null;
            const map = readPropertyPermissionsFromRow(link);
            const modules = new Set<string>();
            for (const id of assigned) {
              for (const { id: module, label } of CO_MANAGER_PERMISSION_OPTIONS) {
                if (hasCoManagerPermission(map[id], module)) modules.add(label);
              }
            }
            const profile = inviteeById.get(inviteeId);
            return {
              userId: inviteeId,
              name: String(profile?.full_name ?? "").trim() || String(profile?.email ?? "").trim() || "Team member",
              email: String(profile?.email ?? "").trim(),
              propertyIds: assigned,
              modules: [...modules],
            };
          })
          .filter((member): member is WorkspaceMember => Boolean(member))
      : [];
    return {
      id: w.id, name: w.name, ownerUserId: w.owner_user_id,
      owned: ownedHere, isDefault: w.is_default,
      propertyIds,
      propertyLabels: Object.fromEntries(
        properties.filter((p) => p.workspace_id === w.id).map((p) => [p.id, labelFor(p as { id: string; row_data?: unknown })]),
      ),
      propertyPermissions: Object.fromEntries(propertyIds.filter((id) => permissions[id]).map((id) => [id, permissions[id]])),
      members,
    };
  });
}

/** The plan's workspace / property / team caps beside what the account already uses. */
export async function loadWorkspacePlan(
  db: SupabaseClient,
  userId: string,
  workspaces: PortalWorkspace[],
): Promise<WorkspacePlan> {
  const tierResult = await getEffectiveManagerSkuTier(userId);
  const tier = tierResult.ok ? tierResult.tier : null;
  const unknown = !tierResult.ok;
  const entitlements = tier ? WORKSPACE_PLAN_ENTITLEMENTS[tier] : null;
  const owned = workspaces.filter((w) => w.owned);
  const [links, vendors] = await Promise.all([
    db.from("account_link_invites").select("id", { count: "exact", head: true }).eq("inviter_user_id", userId).eq("status", "accepted"),
    db.from("manager_vendor_records").select("id", { count: "exact", head: true }).eq("manager_user_id", userId),
  ]);
  return {
    tier,
    unknown,
    // A legacy account with no committed plan keeps the database ceiling.
    workspaceLimit: entitlements ? Math.min(entitlements.workspaces, WORKSPACE_LIMIT) : WORKSPACE_LIMIT,
    propertyLimit: unknown ? null : maxPropertiesForManagerTier(tier),
    recordsPerWorkspace: WORKSPACE_PROPERTY_LIMIT,
    teamLimit: unknown ? null : maxAccountLinksForTier(tier),
    usage: {
      workspaces: owned.length,
      properties: owned.reduce((sum, w) => sum + w.propertyIds.length, 0),
      team: links.count ?? 0,
      vendors: vendors.count ?? 0,
    },
  };
}
