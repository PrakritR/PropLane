import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readPropertyPermissionsFromRow, resolveInviteTeamRole, type InviteRow } from "@/lib/account-link-invite-row";
import { normalizeWorkspacePermissions } from "@/lib/workspace-co-manager-permissions";
import {
  describeHouseMove,
  workspaceRightsForMembership,
  type HouseScope,
  type WorkspaceRights,
  type WorkspaceRole,
} from "@/lib/workspaces/membership";
import { parseHouseScope } from "@/lib/workspaces/membership";

export type WorkspaceStanding = {
  workspaceId: string;
  workspaceName: string;
  ownerUserId: string;
  /** Null when the actor has no membership here at all. */
  role: WorkspaceRole | null;
  rights: WorkspaceRights;
  /** The actor's own membership row, when they are not the owner. */
  linkId: string | null;
};

/**
 * What `actorUserId` is in `workspaceId`: the owner, a member with a role, or
 * nobody. Read from the workspace row and the actor's own membership row of
 * THAT workspace — a membership of another workspace of the same owner grants
 * nothing here, which is the boundary the plan exists to draw.
 */
export async function actorWorkspaceStanding(
  db: SupabaseClient,
  actorUserId: string,
  workspaceId: string,
): Promise<WorkspaceStanding | null> {
  const actor = actorUserId.trim();
  const id = workspaceId.trim();
  if (!actor || !id) return null;
  const { data: workspace, error } = await db
    .from("portal_workspaces")
    .select("id, name, owner_user_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !workspace) return null;
  const ownerUserId = String(workspace.owner_user_id ?? "").trim();
  const base = { workspaceId: String(workspace.id), workspaceName: String(workspace.name ?? "").trim(), ownerUserId };
  if (ownerUserId === actor) {
    return { ...base, role: "owner", rights: { members: true, houses: true }, linkId: null };
  }
  const { data: link } = await db
    .from("account_link_invites")
    .select("id, team_role, workspace_permissions, assigned_property_ids, property_co_manager_permissions, co_manager_permissions, house_scope")
    .eq("invitee_user_id", actor)
    .eq("inviter_user_id", ownerUserId)
    .eq("workspace_id", id)
    .eq("status", "accepted")
    .maybeSingle();
  if (!link) return { ...base, role: null, rights: { members: false, houses: false }, linkId: null };
  const role = resolveInviteTeamRole(link.team_role, readPropertyPermissionsFromRow(link as InviteRow));
  const rights = workspaceRightsForMembership({
    teamRole: role,
    workspacePermissions: normalizeWorkspacePermissions(link.workspace_permissions),
  });
  return { ...base, role, rights, linkId: String(link.id) };
}

/**
 * The houses the ACTOR's own accepted membership reaches in a workspace —
 * never the owner's full set. A delegate (an Admin or other role acting on
 * the owner's behalf, not the owner) minting a link must never reach further
 * than this, even though `workspaceHouseIds` below returns every house the
 * OWNER holds. Empty when the actor has no accepted membership here (fail
 * closed, not the owner's full reach).
 */
export async function actorOwnWorkspaceHouseIds(
  db: SupabaseClient,
  actorUserId: string,
  ownerUserId: string,
  workspaceId: string,
): Promise<string[]> {
  const { data: link } = await db
    .from("account_link_invites")
    .select("assigned_property_ids, house_scope")
    .eq("invitee_user_id", actorUserId.trim())
    .eq("inviter_user_id", ownerUserId.trim())
    .eq("workspace_id", workspaceId.trim())
    .eq("status", "accepted")
    .maybeSingle();
  if (!link) return [];
  if (parseHouseScope(link.house_scope) === "all") {
    return workspaceHouseIds(db, ownerUserId, workspaceId);
  }
  return Array.isArray(link.assigned_property_ids)
    ? link.assigned_property_ids.map((id) => String(id ?? "").trim()).filter(Boolean)
    : [];
}

/** Accepted Admin rows in a workspace — the last one cannot be removed by another admin. */
export async function workspaceAdminCount(db: SupabaseClient, ownerUserId: string, workspaceId: string): Promise<number> {
  const { count } = await db
    .from("account_link_invites")
    .select("id", { count: "exact", head: true })
    .eq("inviter_user_id", ownerUserId)
    .eq("workspace_id", workspaceId)
    .eq("status", "accepted")
    .in("team_role", ["admin", "full"]);
  return count ?? 0;
}

/** The houses a workspace holds right now, owner-scoped. */
export async function workspaceHouseIds(db: SupabaseClient, ownerUserId: string, workspaceId: string): Promise<string[]> {
  const { data } = await db
    .from("manager_property_records")
    .select("id")
    .eq("manager_user_id", ownerUserId)
    .eq("workspace_id", workspaceId)
    .order("created_at");
  return (data ?? []).map((row) => String(row.id ?? "").trim()).filter(Boolean);
}

/**
 * The workspace a set of houses sits in, for a request that named houses but
 * no workspace (an older client). One workspace, or null when the houses span
 * several or there are none — the caller then falls back to the owner's default.
 */
export async function workspaceForHouses(db: SupabaseClient, ownerUserId: string, propertyIds: string[]): Promise<string | null> {
  const ids = [...new Set(propertyIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return null;
  const { data } = await db
    .from("manager_property_records")
    .select("workspace_id")
    .eq("manager_user_id", ownerUserId)
    .in("id", ids);
  const workspaces = new Set((data ?? []).map((row) => String(row.workspace_id ?? "").trim()).filter(Boolean));
  return workspaces.size === 1 ? [...workspaces][0]! : null;
}

export async function ownerDefaultWorkspaceId(db: SupabaseClient, ownerUserId: string): Promise<string | null> {
  const { data } = await db.rpc("ensure_default_portal_workspace", { p_owner: ownerUserId });
  const id = String(data ?? "").trim();
  return id || null;
}

type MemberForMove = { userId: string; name: string; houseScope: HouseScope; propertyIds: string[] };

async function membersForMove(db: SupabaseClient, ownerUserId: string, workspaceId: string): Promise<MemberForMove[]> {
  const { data } = await db
    .from("account_link_invites")
    .select("invitee_user_id, invitee_display_name, assigned_property_ids, house_scope")
    .eq("inviter_user_id", ownerUserId)
    .eq("workspace_id", workspaceId)
    .eq("status", "accepted");
  const rows = (data ?? []).filter((row) => String(row.invitee_user_id ?? "").trim());
  const ids = rows.map((row) => String(row.invitee_user_id));
  const { data: profiles } = ids.length
    ? await db.from("profiles").select("id, full_name, email").in("id", ids)
    : { data: [] as { id: string; full_name: string | null; email: string | null }[] };
  const nameById = new Map((profiles ?? []).map((p) => [String(p.id), String(p.full_name ?? "").trim() || String(p.email ?? "").trim()]));
  return rows.map((row) => ({
    userId: String(row.invitee_user_id),
    name: nameById.get(String(row.invitee_user_id)) || String(row.invitee_display_name ?? "").trim() || "Team member",
    houseScope: parseHouseScope(row.house_scope),
    propertyIds: Array.isArray(row.assigned_property_ids) ? row.assigned_property_ids.map(String) : [],
  }));
}

/** Who loses, keeps and gains a house if it moves from one workspace to another. */
export async function previewHouseMove(
  db: SupabaseClient,
  input: { ownerUserId: string; propertyId: string; fromWorkspaceId: string; toWorkspaceId: string },
): Promise<{ loses: string[]; keeps: string[]; gains: string[] }> {
  const [source, destination] = await Promise.all([
    membersForMove(db, input.ownerUserId, input.fromWorkspaceId),
    membersForMove(db, input.ownerUserId, input.toWorkspaceId),
  ]);
  return describeHouseMove({ propertyId: input.propertyId, source: { members: source }, destination: { members: destination } });
}
