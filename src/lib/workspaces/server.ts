import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  asStringArray,
  readHouseScopeFromRow,
  readPropertyPermissionsFromRow,
  resolveInviteTeamRole,
  type InviteRow,
} from "@/lib/account-link-invite-row";
import type { TeamRoleId } from "@/lib/co-manager-team-roles";
import { effectiveHouseIds, workspaceRightsForMembership, type HouseScope, type WorkspaceRights } from "@/lib/workspaces/membership";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import {
  CO_MANAGER_PERMISSION_OPTIONS,
  hasCoManagerPermission,
  mergeCoManagerPermissions,
  type PropertyCoManagerPermissions,
} from "@/lib/co-manager-permissions";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import { maxAccountLinksForTier, maxPropertiesForManagerTier } from "@/lib/manager-access";
import { EMPTY_PLAN_ADDON_QUANTITIES } from "@/lib/plan-addons";
import { addonUnitsForCap, loadManagerPlanAddonQuantities } from "@/lib/plan-addons.server";
import { normalizeWorkspacePermissions } from "@/lib/workspace-co-manager-permissions";
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
    db.from("account_link_invites")
      .select("id,inviter_user_id,assigned_property_ids,property_co_manager_permissions,co_manager_permissions,workspace_id,workspace_permissions,team_role,house_scope")
      .eq("invitee_user_id", userId).eq("status", "accepted"),
  ]);
  if (owned.error || links.error) throw new Error("Could not load workspace access. Please retry.");
  const participantIds = [...new Set([userId, ...(links.data ?? []).map((link) => link.inviter_user_id)])];
  const profiles = await db.from("profiles").select("id,email").in("id", participantIds);
  if (profiles.error) throw new Error("Could not verify workspace participants. Please retry.");
  const emails = new Map((profiles.data ?? []).map((p) => [p.id, p.email ?? ""]));
  const permissions: PropertyCoManagerPermissions = {};
  const assigned = new Set<string>();
  // The viewer's standing in every workspace they were invited into: the role
  // on THAT workspace's membership row, and the rights the role carries.
  const standingByWorkspace = new Map<string, { role: TeamRoleId; houseScope: HouseScope; rights: WorkspaceRights }>();
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
    const pinnedWorkspace = String((link as { workspace_id?: string | null }).workspace_id ?? "").trim();
    if (!pinnedWorkspace) continue;
    const role = resolveInviteTeamRole((link as { team_role?: unknown }).team_role, map);
    standingByWorkspace.set(pinnedWorkspace, {
      role,
      houseScope: readHouseScopeFromRow(link as { house_scope?: string | null }),
      rights: workspaceRightsForMembership({
        teamRole: role,
        workspacePermissions: normalizeWorkspacePermissions((link as { workspace_permissions?: unknown }).workspace_permissions),
      }),
    });
  }
  const ownedProperties = await db.from("manager_property_records").select("id,workspace_id,row_data,status").eq("manager_user_id", userId);
  if (ownedProperties.error) throw new Error("Could not load workspace properties. Please retry.");
  const linkedProperties = assigned.size
    ? await db.from("manager_property_records").select("id,workspace_id,row_data,status").in("id", [...assigned])
    : { data: [], error: null };
  if (linkedProperties.error) throw new Error("Could not load shared workspace properties. Please retry.");
  const sharedIds = [...new Set([
    ...(linkedProperties.data ?? []).map((p) => p.workspace_id).filter(Boolean),
    ...standingByWorkspace.keys(),
  ])];
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

  // Memberships of every workspace the viewer runs: their own, and any shared
  // one where their role carries the members right. One row per (person,
  // workspace) since the memberships migration; a row with no workspace yet is
  // a legacy row and is placed by its houses.
  const manageableIds = [...rows.values()]
    .filter((w) => w.owner_user_id === userId || standingByWorkspace.get(w.id)?.rights.members)
    .map((w) => w.id);
  const membershipRows = manageableIds.length
    ? await db
        .from("account_link_invites")
        .select("id, inviter_user_id, invitee_user_id, invitee_display_name, assigned_property_ids, property_co_manager_permissions, co_manager_permissions, workspace_id, workspace_permissions, legacy_workspace_permissions, team_role, house_scope, status, responded_at")
        .in("status", ["accepted", "pending"])
        .not("invitee_user_id", "is", null)
        .or(`workspace_id.in.(${manageableIds.join(",")}),and(inviter_user_id.eq.${userId},workspace_id.is.null)`)
    : { data: [] as Record<string, unknown>[], error: null };
  const memberships = (membershipRows.data ?? []) as (InviteRow & { status: string })[];
  const inviteeIds = [...new Set(memberships.map((l) => String(l.invitee_user_id ?? "")).filter(Boolean))];
  const inviteeProfiles = inviteeIds.length
    ? await db.from("profiles").select("id, full_name, email").in("id", inviteeIds)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const inviteeById = new Map((inviteeProfiles.data ?? []).map((p) => [p.id as string, p]));

  return [...rows.values()].map((w) => {
    const propertyIds = [...new Set(properties.filter((p) => p.workspace_id === w.id).map((p) => p.id))];
    // Same predicate Properties → Listed uses (`statusForBucket(2)` and
    // `getPublicListings()`): status "live" only. `propertyIds` above keeps
    // drafts/unlisted because it drives scoping (`workspaceContainsProperty`);
    // this is a display count only.
    const livePropertyCount = properties.filter(
      (p) => p.workspace_id === w.id && (p as { status?: string }).status === "live",
    ).length;
    const ownedHere = w.owner_user_id === userId;
    const standing = standingByWorkspace.get(w.id) ?? null;
    const canManageMembers = ownedHere || Boolean(standing?.rights.members);
    const members: WorkspaceMember[] = canManageMembers
      ? memberships
          .filter((link) => {
            if (String(link.inviter_user_id) !== w.owner_user_id) return false;
            const pinned = String(link.workspace_id ?? "").trim();
            if (pinned) return pinned === w.id;
            // Legacy row: place it by its houses, once, under the default card.
            const here = asStringArray(link.assigned_property_ids).filter((id) => propertyIds.includes(id));
            return here.length > 0 || (asStringArray(link.assigned_property_ids).length === 0 && w.is_default);
          })
          .map((link): WorkspaceMember | null => {
            const inviteeId = String(link.invitee_user_id ?? "");
            if (!inviteeId) return null;
            const houseScope = readHouseScopeFromRow(link);
            const reach = effectiveHouseIds({ houseScope, assignedPropertyIds: asStringArray(link.assigned_property_ids), workspacePropertyIds: propertyIds });
            const map = readPropertyPermissionsFromRow(link);
            const modules = new Set<string>();
            for (const id of reach) {
              for (const { id: module, label } of CO_MANAGER_PERMISSION_OPTIONS) {
                if (hasCoManagerPermission(map[id], module)) modules.add(label);
              }
            }
            const profile = inviteeById.get(inviteeId);
            const pending = link.status === "pending";
            // Mirror `GET /api/pro/account-links`'s disclosure rule exactly
            // (route.ts ~207-215): creating an invite needs only the target's
            // PropLane ID, the invitee never consented, and this list is the
            // viewer's OWN outgoing invite (the workspace's manager, looking
            // at a row where they are the inviter) — so an undisclosed pending
            // row must never leak the live profile's email or name. Only the
            // row's own invite-time snapshot (`invitee_display_name`) is
            // shown, exactly like `linkedDisplayName` for an outgoing pending
            // invite there. Accepted rows disclose in full, same as that route.
            const name = pending
              ? String(link.invitee_display_name ?? "").trim() || "Team member"
              : String(profile?.full_name ?? "").trim() ||
                String(link.invitee_display_name ?? "").trim() ||
                String(profile?.email ?? "").trim() ||
                "Team member";
            return {
              linkId: String(link.id),
              userId: inviteeId,
              name,
              email: pending ? "" : String(profile?.email ?? "").trim(),
              role: resolveInviteTeamRole(link.team_role, map),
              houseScope,
              propertyIds: reach,
              modules: [...modules],
              status: pending ? "pending" : "accepted",
              joinedAt: link.responded_at ?? null,
              legacyRights: Object.keys(normalizeWorkspacePermissions(link.legacy_workspace_permissions)).length > 0,
            };
          })
          .filter((member): member is WorkspaceMember => Boolean(member))
      : [];
    return {
      id: w.id, name: w.name, ownerUserId: w.owner_user_id,
      owned: ownedHere, isDefault: w.is_default,
      propertyIds,
      livePropertyCount,
      propertyLabels: Object.fromEntries(
        properties.filter((p) => p.workspace_id === w.id).map((p) => [p.id, labelFor(p as { id: string; row_data?: unknown })]),
      ),
      propertyPermissions: Object.fromEntries(propertyIds.filter((id) => permissions[id]).map((id) => [id, permissions[id]])),
      members,
      viewerRole: ownedHere ? "owner" : (standing?.role ?? null),
      viewerHouseScope: ownedHere ? "all" : (standing?.houseScope ?? "selected"),
      canAddProperties: ownedHere || Boolean(standing?.rights.houses),
      canManageMembers,
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
  const entitlements = tier ? WORKSPACE_PLAN_ENTITLEMENTS[tier] : null;
  const owned = workspaces.filter((w) => w.owned);
  const [links, vendors, addons] = await Promise.all([
    db.from("account_link_invites").select("id", { count: "exact", head: true }).eq("inviter_user_id", userId).eq("status", "accepted"),
    db.from("manager_vendor_records").select("id", { count: "exact", head: true }).eq("manager_user_id", userId),
    loadManagerPlanAddonQuantities(db, userId),
  ]);
  // A failed add-on read is an unknown plan. Treating it as zero would reject
  // a manager who already pays for capacity, so callers must fail closed.
  const unknown = !tierResult.ok || !addons.ok;
  const extra = addons.ok ? addons.quantities : EMPTY_PLAN_ADDON_QUANTITIES;
  const planPropertyLimit = unknown ? null : maxPropertiesForManagerTier(tier);
  const planTeamLimit = unknown ? null : maxAccountLinksForTier(tier);
  // A legacy account with no committed plan keeps the database ceiling.
  const computedWorkspaceLimit = entitlements
    ? Math.min(entitlements.workspaces + addonUnitsForCap(extra, "extra_workspace", tier), WORKSPACE_LIMIT)
    : WORKSPACE_LIMIT;
  return {
    tier,
    unknown,
    // Grandfathered: a plan cap (e.g. Business 3 -> 2, PLAN-0920) never
    // strands a workspace the account already owns.
    workspaceLimit: Math.max(computedWorkspaceLimit, owned.length),
    propertyLimit: planPropertyLimit === null ? null : planPropertyLimit + addonUnitsForCap(extra, "extra_listing", tier),
    recordsPerWorkspace: WORKSPACE_PROPERTY_LIMIT,
    teamLimit: planTeamLimit === null ? null : planTeamLimit + addonUnitsForCap(extra, "extra_seat", tier),
    usage: {
      workspaces: owned.length,
      properties: owned.reduce((sum, w) => sum + w.propertyIds.length, 0),
      team: links.count ?? 0,
      vendors: vendors.count ?? 0,
    },
  };
}
