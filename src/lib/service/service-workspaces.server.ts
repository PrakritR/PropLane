import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAdminUserIds, userHoldsAdminRole } from "@/lib/auth/admin-role";
import { ensureProfileProplaneId } from "@/lib/manager-access-server";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";
import { actorWorkspaceStanding, workspaceAdminCount } from "@/lib/workspaces/membership.server";
import { canActOnMember } from "@/lib/workspaces/membership";
import { cleanServiceCity, cleanServiceName } from "@/lib/service/service-input";
import { loadServiceWorkspace, resolveServiceOwner } from "@/lib/service/service-owner.server";

/**
 * PropLane Service workspaces (admin Service tab). Ordinary `portal_workspaces`
 * owned by the service owner (`service-owner.server.ts`); an admin operator is a
 * MEMBER with the Admin role (an accepted `account_link_invites` row pinned to the
 * workspace), so the manager portal needs no new code path.
 *
 * Every function here re-derives its authority server-side: the caller proves the
 * operator is a platform admin (`requireAdminRoute`) and this layer then re-checks
 * that the workspace is a service workspace of the stored owner and what the
 * operator is INSIDE it. A workspace id from a body is a name, never a grant.
 */

export type ServiceFailure = { ok: false; status: number; error: string };
export type ServiceResult<T> = ({ ok: true } & T) | ServiceFailure;

const fail = (status: number, error: string): ServiceFailure => ({ ok: false, status, error });

export const SERVICE_NOT_CONFIGURED = "The PropLane service owner is not set up yet.";
const NOT_FOUND = "Service workspace not found.";

export type ServiceWorkspaceListRow = {
  id: string;
  name: string;
  city: string | null;
  isDefault: boolean;
  houseCount: number;
  workNumber: string | null;
  numberState: string | null;
  teamCount: number;
  /** What the viewing operator is in this workspace; null = not a member (cannot open it). */
  viewerRole: string | null;
  canManage: boolean;
};

export type ServiceListPayload = {
  configured: boolean;
  ownerUserId: string | null;
  workspaces: ServiceWorkspaceListRow[];
};

export async function listServiceWorkspaces(db: SupabaseClient, operatorUserId: string): Promise<ServiceResult<{ payload: ServiceListPayload }>> {
  const owner = await resolveServiceOwner(db);
  if (!owner.ok) {
    if (owner.reason === "not_configured") return { ok: true, payload: { configured: false, ownerUserId: null, workspaces: [] } };
    return fail(503, "Could not load service workspaces. Please retry.");
  }
  const ws = await db
    .from("portal_workspaces")
    .select("id, name, city, is_default")
    .eq("owner_user_id", owner.ownerUserId)
    .eq("is_service", true)
    .order("created_at");
  if (ws.error) return fail(503, "Could not load service workspaces. Please retry.");
  const rows = (ws.data ?? []) as { id: string; name: string; city: string | null; is_default: boolean }[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { ok: true, payload: { configured: true, ownerUserId: owner.ownerUserId, workspaces: [] } };

  const [houses, numbers, links] = await Promise.all([
    db.from("manager_property_records").select("id, workspace_id").eq("manager_user_id", owner.ownerUserId).in("workspace_id", ids),
    db.from("manager_sms_numbers").select("workspace_id, phone_number, provision_state, released_at").in("workspace_id", ids),
    db
      .from("account_link_invites")
      .select("id, workspace_id, invitee_user_id, team_role, status")
      .eq("inviter_user_id", owner.ownerUserId)
      .in("workspace_id", ids)
      .in("status", ["accepted", "pending"]),
  ]);
  if (houses.error || numbers.error || links.error) return fail(503, "Could not load service workspaces. Please retry.");

  const out: ServiceWorkspaceListRow[] = rows.map((row) => {
    const live = ((numbers.data ?? []) as Record<string, unknown>[]).find((n) => n.workspace_id === row.id && !n.released_at);
    const members = ((links.data ?? []) as Record<string, unknown>[]).filter((l) => l.workspace_id === row.id);
    const mine = members.find((l) => l.invitee_user_id === operatorUserId && l.status === "accepted");
    const isOwner = operatorUserId === owner.ownerUserId;
    const myRole = isOwner ? "owner" : mine ? String(mine.team_role ?? "custom") : null;
    return {
      id: row.id,
      name: row.name,
      city: row.city?.trim() || null,
      isDefault: row.is_default,
      houseCount: ((houses.data ?? []) as Record<string, unknown>[]).filter((h) => h.workspace_id === row.id).length,
      workNumber: (live?.phone_number as string | null | undefined) ?? null,
      numberState: live ? String(live.provision_state ?? "") || null : null,
      teamCount: members.filter((l) => l.status === "accepted").length,
      viewerRole: myRole,
      canManage: myRole === "owner" || myRole === "admin" || myRole === "full",
    };
  });
  return { ok: true, payload: { configured: true, ownerUserId: owner.ownerUserId, workspaces: out } };
}

/** Add an accepted Admin membership of `workspaceId` for `userId`, under the service owner. */
async function insertAdminMembership(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string,
  userId: string,
): Promise<ServiceFailure | { ok: true; linkId: string }> {
  const [inviter, invitee] = await Promise.all([
    ensureProfileProplaneId(db as never, ownerUserId),
    ensureProfileProplaneId(db as never, userId),
  ]);
  if (!inviter.ok || !invitee.ok) return fail(503, "Could not read the accounts. Please retry.");
  const stamp = stampTeamRolePermissions("admin") ?? {};
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("account_link_invites")
    .insert({
      inviter_user_id: ownerUserId,
      invitee_user_id: userId,
      tab_kind: "manager",
      inviter_axis_id: inviter.proplaneId,
      invitee_axis_id: invitee.proplaneId,
      inviter_display_name: inviter.fullName?.trim() || inviter.email || null,
      invitee_display_name: invitee.fullName?.trim() || invitee.email || null,
      assigned_property_ids: [],
      payout_percent_for_manager: 0,
      property_co_manager_permissions: {},
      co_manager_permissions: stamp,
      workspace_id: workspaceId,
      workspace_permissions: {},
      team_role: "admin",
      house_scope: "all",
      invited_via: "code",
      invited_at: now,
      responded_at: now,
      status: "accepted",
    })
    .select("id")
    .maybeSingle();
  if (error || !data) return fail(error?.code === "23505" ? 409 : 503, error?.code === "23505" ? "Already a member of this workspace." : "Could not add the teammate.");
  return { ok: true, linkId: String((data as { id: unknown }).id) };
}

/** + : a new service workspace owned by the service owner; the creating operator joins it as Admin. */
export async function createServiceWorkspace(
  db: SupabaseClient,
  operatorUserId: string,
  input: { name: unknown; city: unknown },
): Promise<ServiceResult<{ id: string }>> {
  const name = cleanServiceName(input.name);
  if (!name) return fail(400, "Use a workspace name of 1 to 80 characters.");
  const city = cleanServiceCity(input.city);
  if (city === undefined) return fail(400, "Use a city of up to 80 characters.");
  const owner = await resolveServiceOwner(db);
  if (!owner.ok) return fail(owner.reason === "not_configured" ? 409 : 503, owner.reason === "not_configured" ? SERVICE_NOT_CONFIGURED : "Could not reach the service settings. Please retry.");
  const created = await db.rpc("create_portal_service_workspace", { p_owner: owner.ownerUserId, p_name: name, p_city: city });
  if (created.error || !created.data) return fail(503, "Could not create the workspace. Please retry.");
  const id = String(created.data);
  if (operatorUserId !== owner.ownerUserId) {
    const member = await insertAdminMembership(db, owner.ownerUserId, id, operatorUserId);
    if (!member.ok) {
      // A workspace its creator cannot open is a dead row: undo it (it holds no houses yet).
      await db.from("portal_workspaces").delete().eq("id", id).eq("owner_user_id", owner.ownerUserId);
      return fail(member.status, member.error);
    }
  }
  return { ok: true, id };
}

/** What the operator is inside one service workspace, or a failure when it is not one / they hold nothing in it. */
async function operatorStanding(db: SupabaseClient, operatorUserId: string, workspaceId: string) {
  const workspace = await loadServiceWorkspace(db, workspaceId);
  if (!workspace) return fail(404, NOT_FOUND);
  const standing = await actorWorkspaceStanding(db, operatorUserId, workspace.id);
  if (!standing || standing.role === null) return fail(403, "Ask a teammate of this workspace to add you to its team first.");
  return { ok: true as const, workspace, standing };
}

export async function renameServiceWorkspace(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string; name: unknown; city: unknown },
): Promise<ServiceResult<Record<string, never>>> {
  const name = cleanServiceName(input.name);
  if (!name) return fail(400, "Use a workspace name of 1 to 80 characters.");
  const city = cleanServiceCity(input.city);
  if (city === undefined) return fail(400, "Use a city of up to 80 characters.");
  const who = await operatorStanding(db, operatorUserId, input.id);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can rename it.");
  const res = await db
    .from("portal_workspaces")
    .update({ name, city })
    .eq("id", who.workspace.id)
    .eq("owner_user_id", who.workspace.ownerUserId)
    .eq("is_service", true);
  if (res.error) return fail(503, "Could not rename the workspace. Please retry.");
  return { ok: true };
}

/** Open: only a member (or the owner) may switch into it; the caller then sets the workspace cookie. */
export async function authorizeOpenServiceWorkspace(
  db: SupabaseClient,
  operatorUserId: string,
  workspaceId: string,
): Promise<ServiceResult<{ id: string }>> {
  const who = await operatorStanding(db, operatorUserId, workspaceId);
  if (!who.ok) return who;
  return { ok: true, id: who.workspace.id };
}

export type ServiceTeamMember = { linkId: string; userId: string; name: string; email: string; role: string };
export type ServiceTeamCandidate = { userId: string; name: string; email: string };

export async function listServiceTeam(
  db: SupabaseClient,
  operatorUserId: string,
  workspaceId: string,
): Promise<ServiceResult<{ members: ServiceTeamMember[]; candidates: ServiceTeamCandidate[]; canManage: boolean }>> {
  const who = await operatorStanding(db, operatorUserId, workspaceId);
  if (!who.ok) return who;
  const links = await db
    .from("account_link_invites")
    .select("id, invitee_user_id, team_role")
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id)
    .eq("status", "accepted");
  if (links.error) return fail(503, "Could not load the team. Please retry.");
  const linkRows = (links.data ?? []) as { id: string; invitee_user_id: string; team_role: string | null }[];
  const adminIds = await listAdminUserIds(db);
  const profileIds = [...new Set([...linkRows.map((l) => l.invitee_user_id), ...adminIds])];
  const profiles = profileIds.length
    ? await db.from("profiles").select("id, full_name, email").in("id", profileIds)
    : { data: [], error: null };
  if (profiles.error) return fail(503, "Could not load the team. Please retry.");
  const byId = new Map(((profiles.data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p]));
  const label = (id: string) => {
    const p = byId.get(id);
    return { name: p?.full_name?.trim() || p?.email?.trim() || "Teammate", email: p?.email?.trim() || "" };
  };
  const memberIds = new Set(linkRows.map((l) => l.invitee_user_id));
  const canManage = who.standing.rights.members;
  return {
    ok: true,
    canManage,
    members: linkRows.map((l) => ({ linkId: l.id, userId: l.invitee_user_id, ...label(l.invitee_user_id), role: l.team_role ?? "custom" })),
    candidates: canManage
      ? adminIds.filter((id) => id !== who.workspace.ownerUserId && !memberIds.has(id)).map((id) => ({ userId: id, ...label(id) }))
      : [],
  };
}

/** Add a teammate: the target must itself be a platform admin; the actor must run the workspace. */
export async function addServiceTeamMember(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string; userId: unknown },
): Promise<ServiceResult<{ linkId: string }>> {
  const target = typeof input.userId === "string" ? input.userId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(target)) return fail(400, "Choose a teammate.");
  const who = await operatorStanding(db, operatorUserId, input.id);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can change its team.");
  if (target === who.workspace.ownerUserId) return fail(409, "That account already owns this workspace.");
  // Re-derived here, never taken from the client: only a platform admin joins the service team this way.
  if (!(await userHoldsAdminRole(db, target))) return fail(400, "Only a PropLane admin can join the service team.");
  const existing = await db
    .from("account_link_invites")
    .select("id")
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("invitee_user_id", target)
    .eq("workspace_id", who.workspace.id)
    .in("status", ["accepted", "pending"])
    .maybeSingle();
  if (existing.error) return fail(503, "Could not add the teammate. Please retry.");
  if (existing.data) return fail(409, "Already a member of this workspace.");
  const added = await insertAdminMembership(db, who.workspace.ownerUserId, who.workspace.id, target);
  if (!added.ok) return added;
  return { ok: true, linkId: added.linkId };
}

export async function removeServiceTeamMember(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string; linkId: unknown },
): Promise<ServiceResult<Record<string, never>>> {
  const linkId = typeof input.linkId === "string" ? input.linkId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return fail(400, "Choose a teammate.");
  const who = await operatorStanding(db, operatorUserId, input.id);
  if (!who.ok) return who;
  const link = await db
    .from("account_link_invites")
    .select("id, team_role")
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id)
    .eq("status", "accepted")
    .maybeSingle();
  if (link.error) return fail(503, "Could not remove the teammate. Please retry.");
  if (!link.data) return fail(404, "Teammate not found.");
  const targetRole = ((link.data as { team_role?: string | null }).team_role ?? "custom") as never;
  const verdict = canActOnMember({
    actorRole: who.standing.role,
    targetRole,
    adminCount: await workspaceAdminCount(db, who.workspace.ownerUserId, who.workspace.id),
  });
  if (!verdict.ok) return fail(403, verdict.reason);
  const res = await db
    .from("account_link_invites")
    .update({ status: "cancelled", responded_at: new Date().toISOString() })
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id);
  if (res.error) return fail(503, "Could not remove the teammate. Please retry.");
  return { ok: true };
}
