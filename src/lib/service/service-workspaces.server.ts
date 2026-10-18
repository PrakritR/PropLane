import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAdminUserIds, userHoldsAdminRole } from "@/lib/auth/admin-role";
import { ensureProfileProplaneId } from "@/lib/manager-access-server";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";
import { actorWorkspaceStanding, workspaceAdminCount } from "@/lib/workspaces/membership.server";
import { canActOnMember } from "@/lib/workspaces/membership";
import { cleanOwnerOfRecord, cleanServiceCity, cleanServiceName } from "@/lib/service/service-input";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import { proplaneIdLookupVariants } from "@/lib/manager-id";
import { userIsPropertyPortalManager } from "@/lib/auth/co-manager-invite-eligibility.server";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
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
  /** The client this workspace is for: the flagged owner-of-record member when there is one, else the name typed on +. */
  ownerOfRecord: { name: string; linked: boolean } | null;
  isDefault: boolean;
  houseCount: number;
  /** The number this workspace actually texts from: its own paid number if it has one, else the shared PropLane line it is on, else none. */
  workNumber: string | null;
  workNumberSource: "own" | "shared" | null;
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

/**
 * No number is provisioned, reserved or exempted for a service workspace: it texts from the same default PropLane
 * line as everyone else, or from its own number only if that was paid for the normal way (Pro/Business).
 */
function resolveTextingNumber(
  own: Record<string, unknown> | undefined,
  sharedLine: Awaited<ReturnType<typeof loadSharedLineConfig>>,
  workspaceId: string,
): { workNumber: string | null; workNumberSource: "own" | "shared" | null } {
  const ownNumber = typeof own?.phone_number === "string" && own.phone_number.trim() ? own.phone_number.trim() : null;
  if (ownNumber) return { workNumber: ownNumber, workNumberSource: "own" };
  if (workspaceOnSharedLine(sharedLine, workspaceId) && sharedLine.sharedNumber) {
    return { workNumber: sharedLine.sharedNumber, workNumberSource: "shared" };
  }
  return { workNumber: null, workNumberSource: null };
}

function ownerOfRecordFor(
  typedName: string | null,
  members: Record<string, unknown>[],
  profileName: Map<string, string>,
): { name: string; linked: boolean } | null {
  const flagged = members.find((l) => l.is_owner_of_record === true);
  if (flagged) {
    const name =
      (flagged.status === "accepted" ? profileName.get(String(flagged.invitee_user_id)) : "") ||
      String(flagged.invitee_display_name ?? "").trim() ||
      typedName?.trim() ||
      "Owner";
    return { name, linked: true };
  }
  const typed = typedName?.trim();
  return typed ? { name: typed, linked: false } : null;
}

export async function listServiceWorkspaces(db: SupabaseClient, operatorUserId: string): Promise<ServiceResult<{ payload: ServiceListPayload }>> {
  const owner = await resolveServiceOwner(db);
  if (!owner.ok) {
    if (owner.reason === "not_configured") return { ok: true, payload: { configured: false, ownerUserId: null, workspaces: [] } };
    return fail(503, "Could not load service workspaces. Please retry.");
  }
  const ws = await db
    .from("portal_workspaces")
    .select("id, name, city, is_default, owner_of_record_name")
    .eq("owner_user_id", owner.ownerUserId)
    .eq("is_service", true)
    .order("created_at");
  if (ws.error) return fail(503, "Could not load service workspaces. Please retry.");
  const rows = (ws.data ?? []) as { id: string; name: string; city: string | null; is_default: boolean; owner_of_record_name: string | null }[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { ok: true, payload: { configured: true, ownerUserId: owner.ownerUserId, workspaces: [] } };

  const [houses, numbers, links, sharedLine] = await Promise.all([
    db.from("manager_property_records").select("id, workspace_id").eq("manager_user_id", owner.ownerUserId).in("workspace_id", ids),
    db.from("manager_sms_numbers").select("workspace_id, phone_number, provision_state, released_at").in("workspace_id", ids),
    db
      .from("account_link_invites")
      .select("id, workspace_id, invitee_user_id, team_role, status, is_owner_of_record, invitee_display_name")
      .eq("inviter_user_id", owner.ownerUserId)
      .in("workspace_id", ids)
      .in("status", ["accepted", "pending"]),
    loadSharedLineConfig(db),
  ]);
  if (houses.error || numbers.error || links.error) return fail(503, "Could not load service workspaces. Please retry.");
  // The owner of record's name for an ACCEPTED flagged member comes from their profile; a pending one is shown
  // by the name snapshot taken at invite time (never the live profile: they have not consented yet).
  const flagged = ((links.data ?? []) as Record<string, unknown>[]).filter((l) => l.is_owner_of_record === true);
  const flaggedAccepted = flagged.filter((l) => l.status === "accepted").map((l) => String(l.invitee_user_id));
  const flaggedProfiles = flaggedAccepted.length
    ? await db.from("profiles").select("id, full_name, email").in("id", flaggedAccepted)
    : { data: [], error: null };
  const profileName = new Map(
    ((flaggedProfiles.data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p.full_name?.trim() || p.email?.trim() || ""]),
  );

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
      ownerOfRecord: ownerOfRecordFor(row.owner_of_record_name, members, profileName),
      isDefault: row.is_default,
      houseCount: ((houses.data ?? []) as Record<string, unknown>[]).filter((h) => h.workspace_id === row.id).length,
      ...resolveTextingNumber(live, sharedLine, row.id),
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
  opts: { pending?: boolean; ownerOfRecord?: boolean } = {},
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
      responded_at: opts.pending ? null : now,
      status: opts.pending ? "pending" : "accepted",
      is_owner_of_record: opts.ownerOfRecord === true,
    })
    .select("id")
    .maybeSingle();
  if (error || !data) {
    if (error?.code === "23505") {
      const flag = (error.message ?? "").includes("one_owner_of_record");
      return fail(409, flag ? "This workspace already has an owner of record." : "Already a member of this workspace.");
    }
    return fail(503, "Could not add the teammate.");
  }
  return { ok: true, linkId: String((data as { id: unknown }).id) };
}

/** + : a new service workspace owned by the service owner; the creating operator joins it as Admin. */
export async function createServiceWorkspace(
  db: SupabaseClient,
  operatorUserId: string,
  input: { name: unknown; city: unknown; ownerOfRecord?: unknown },
): Promise<ServiceResult<{ id: string }>> {
  const name = cleanServiceName(input.name);
  if (!name) return fail(400, "Use a workspace name of 1 to 80 characters.");
  const city = cleanServiceCity(input.city);
  if (city === undefined) return fail(400, "Use a city of up to 80 characters.");
  const client = cleanOwnerOfRecord(input.ownerOfRecord);
  if (client === undefined) return fail(400, "Use an owner name of up to 80 characters.");
  const owner = await resolveServiceOwner(db);
  if (!owner.ok) return fail(owner.reason === "not_configured" ? 409 : 503, owner.reason === "not_configured" ? SERVICE_NOT_CONFIGURED : "Could not reach the service settings. Please retry.");
  const created = await db.rpc("create_portal_service_workspace", { p_owner: owner.ownerUserId, p_name: name, p_city: city });
  if (created.error || !created.data) return fail(503, "Could not create the workspace. Please retry.");
  const id = String(created.data);
  if (client) {
    const named = await db.from("portal_workspaces").update({ owner_of_record_name: client }).eq("id", id).eq("owner_user_id", owner.ownerUserId);
    if (named.error) {
      await db.from("portal_workspaces").delete().eq("id", id).eq("owner_user_id", owner.ownerUserId);
      return fail(503, "Could not create the workspace. Please retry.");
    }
  }
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
  input: { id: string; name: unknown; city: unknown; ownerOfRecord?: unknown },
): Promise<ServiceResult<object>> {
  const name = cleanServiceName(input.name);
  if (!name) return fail(400, "Use a workspace name of 1 to 80 characters.");
  const city = cleanServiceCity(input.city);
  if (city === undefined) return fail(400, "Use a city of up to 80 characters.");
  const client = input.ownerOfRecord === undefined ? undefined : cleanOwnerOfRecord(input.ownerOfRecord);
  if (input.ownerOfRecord !== undefined && client === undefined) return fail(400, "Use an owner name of up to 80 characters.");
  const who = await operatorStanding(db, operatorUserId, input.id);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can rename it.");
  const res = await db
    .from("portal_workspaces")
    .update({ name, city, ...(client !== undefined ? { owner_of_record_name: client } : {}) })
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

export type ServiceTeamMember = {
  linkId: string;
  userId: string;
  name: string;
  /** Empty for a pending invite: the invitee has not consented to disclose it yet. */
  email: string;
  role: string;
  status: "accepted" | "pending";
  ownerOfRecord: boolean;
};
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
    .select("id, invitee_user_id, team_role, status, is_owner_of_record, invitee_display_name")
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id)
    .in("status", ["accepted", "pending"]);
  if (links.error) return fail(503, "Could not load the team. Please retry.");
  const linkRows = (links.data ?? []) as {
    id: string;
    invitee_user_id: string;
    team_role: string | null;
    status: "accepted" | "pending";
    is_owner_of_record: boolean | null;
    invitee_display_name: string | null;
  }[];
  const adminIds = await listAdminUserIds(db);
  const profileIds = [...new Set([...linkRows.filter((l) => l.status === "accepted").map((l) => l.invitee_user_id), ...adminIds])];
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
    members: linkRows.map((l) => ({
      linkId: l.id,
      userId: l.invitee_user_id,
      // A pending invitee is shown by the name snapshot taken when the invite was written, never their live profile.
      ...(l.status === "pending" ? { name: l.invitee_display_name?.trim() || "Invited", email: "" } : label(l.invitee_user_id)),
      role: l.team_role ?? "custom",
      status: l.status,
      ownerOfRecord: l.is_owner_of_record === true,
    })),
    candidates: canManage
      ? adminIds.filter((id) => id !== who.workspace.ownerUserId && !memberIds.has(id)).map((id) => ({ userId: id, ...label(id) }))
      : [],
  };
}

/** True when another live (pending or accepted) membership of this workspace is already the owner of record. */
async function hasOwnerOfRecord(db: SupabaseClient, workspaceId: string, exceptLinkId?: string): Promise<boolean | null> {
  const res = await db
    .from("account_link_invites")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("is_owner_of_record", true)
    .in("status", ["accepted", "pending"]);
  if (res.error) return null;
  return ((res.data ?? []) as { id: string }[]).some((r) => r.id !== exceptLinkId);
}

/**
 * Invite a client person (the property owner, or someone on their side) by PropLane ID. They join as an Admin
 * member of THIS workspace only (full access to it) once they accept in their own portal; their own accounts and
 * workspaces are untouched. `ownerOfRecord` flags the owner of record for payouts and finances; it grants nothing
 * by itself. The invitee must already be a property-portal account, the same rule every co-manager invite has.
 */
export async function inviteServiceClient(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string; proplaneId: unknown; ownerOfRecord?: unknown },
): Promise<ServiceResult<{ linkId: string }>> {
  const raw = typeof input.proplaneId === "string" ? input.proplaneId.trim() : "";
  if (!raw || raw.length > 40) return fail(400, "Enter the PropLane ID of the person to invite.");
  const who = await operatorStanding(db, operatorUserId, input.id);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can invite people.");

  const variants = proplaneIdLookupVariants(raw);
  const profile = await db
    .from("profiles")
    .select("id, email")
    .in("manager_id", variants.length ? variants : [raw])
    .limit(1)
    .maybeSingle();
  if (profile.error) return fail(503, "Could not look up that PropLane ID. Please retry.");
  const target = String((profile.data as { id?: unknown } | null)?.id ?? "");
  if (!target) return fail(404, "No account found with this PropLane ID.");
  if (target === who.workspace.ownerUserId) return fail(409, "That account already owns this workspace.");
  if (!(await userIsPropertyPortalManager(db, target))) {
    return fail(400, "That account needs a property portal to join this workspace.");
  }
  const ownerProfile = await db.from("profiles").select("email").eq("id", who.workspace.ownerUserId).maybeSingle();
  if (isCrossSandboxPortalPair(String((ownerProfile.data as { email?: string } | null)?.email ?? ""), String((profile.data as { email?: string }).email ?? ""))) {
    return fail(400, "That account cannot join this workspace.");
  }
  const existing = await db
    .from("account_link_invites")
    .select("id")
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("invitee_user_id", target)
    .eq("workspace_id", who.workspace.id)
    .in("status", ["accepted", "pending"])
    .maybeSingle();
  if (existing.error) return fail(503, "Could not send the invite. Please retry.");
  if (existing.data) return fail(409, "Already on this workspace's team, or invited.");
  const flag = input.ownerOfRecord === true;
  if (flag) {
    const taken = await hasOwnerOfRecord(db, who.workspace.id);
    if (taken === null) return fail(503, "Could not send the invite. Please retry.");
    if (taken) return fail(409, "This workspace already has an owner of record.");
  }
  const added = await insertAdminMembership(db, who.workspace.ownerUserId, who.workspace.id, target, { pending: true, ownerOfRecord: flag });
  if (!added.ok) return added;
  return { ok: true, linkId: added.linkId };
}

/** Mark (or unmark) the membership that is the property owner of record. At most one per workspace. */
export async function setServiceOwnerOfRecord(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string; linkId: unknown; value: unknown },
): Promise<ServiceResult<object>> {
  const linkId = typeof input.linkId === "string" ? input.linkId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(linkId) || typeof input.value !== "boolean") return fail(400, "Choose a person.");
  const who = await operatorStanding(db, operatorUserId, input.id);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can change this.");
  const link = await db
    .from("account_link_invites")
    .select("id")
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id)
    .in("status", ["accepted", "pending"])
    .maybeSingle();
  if (link.error) return fail(503, "Could not update. Please retry.");
  if (!link.data) return fail(404, "Teammate not found.");
  if (input.value) {
    const taken = await hasOwnerOfRecord(db, who.workspace.id, linkId);
    if (taken === null) return fail(503, "Could not update. Please retry.");
    if (taken) return fail(409, "This workspace already has an owner of record.");
  }
  const res = await db
    .from("account_link_invites")
    .update({ is_owner_of_record: input.value })
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id);
  if (res.error) return fail(res.error.code === "23505" ? 409 : 503, res.error.code === "23505" ? "This workspace already has an owner of record." : "Could not update. Please retry.");
  return { ok: true };
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
): Promise<ServiceResult<object>> {
  const linkId = typeof input.linkId === "string" ? input.linkId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return fail(400, "Choose a teammate.");
  const who = await operatorStanding(db, operatorUserId, input.id);
  if (!who.ok) return who;
  const link = await db
    .from("account_link_invites")
    .select("id, team_role, status")
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id)
    .in("status", ["accepted", "pending"])
    .maybeSingle();
  if (link.error) return fail(503, "Could not remove the teammate. Please retry.");
  if (!link.data) return fail(404, "Teammate not found.");
  const targetRole = ((link.data as { team_role?: string | null }).team_role ?? "custom") as never;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can change its team.");
  // A pending invite can always be withdrawn; removing an accepted member follows the workspace's own rule.
  if ((link.data as { status?: string }).status === "accepted") {
    const verdict = canActOnMember({
      actorRole: who.standing.role,
      targetRole,
      adminCount: await workspaceAdminCount(db, who.workspace.ownerUserId, who.workspace.id),
    });
    if (!verdict.ok) return fail(403, verdict.reason);
  }
  const res = await db
    .from("account_link_invites")
    .update({ status: "cancelled", responded_at: new Date().toISOString() })
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id);
  if (res.error) return fail(503, "Could not remove the teammate. Please retry.");
  return { ok: true };
}
