import "server-only";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAdminUserIds, userHoldsAdminRole } from "@/lib/auth/admin-role";
import { isPrimaryAdminEmail } from "@/lib/auth/primary-admin";
import { ensureProfileRoleRow } from "@/lib/auth/profile-role-row";
import { primaryRoleWhenAddingManager } from "@/lib/auth/profile-primary-role";
import { withoutOwnerLinks } from "@/lib/co-manager-team-roles";
import { actorWorkspaceStanding } from "@/lib/workspaces/membership.server";
import { loadServiceStaffWorkspaces } from "@/lib/service/service-mode.server";
import { checkAdminTeamSeatGrant, prepareAdminTeamSeatGrant, removeServiceTeamMember, seatAdminTeamMember } from "@/lib/service/service-workspaces.server";
import { auditAdminTeam, type AdminTeamFailure } from "@/lib/admin-team/admin-team-audit.server";
import {
  OVERALL_ADMIN_ROLE,
  adminTeamGrantVerdict,
  lastOverallAdminVerdict,
  parseAdminTeamRole,
  parseStoredAdminGrant,
  type AdminTeamActor,
  type AdminTeamMemberRow,
  type AdminTeamPayload,
  type AdminTeamRole,
  type StoredAdminGrant,
} from "@/lib/admin-team/admin-team-model";

/**
 * Admin team, server side (plan admin-team-1027). Every function re-derives who the caller is and what they may touch;
 * a user id, workspace id or role in a request body is a name, never a grant.
 */

export type AdminTeamResult<T> = ({ ok: true } & T) | AdminTeamFailure;
const fail = (status: number, error: string): AdminTeamFailure => ({ ok: false, status, error });

/**
 * One PropLane-issued seat. A Property owner seat or an owner of record is the CLIENT side of a managed workspace, so
 * every read here drops it (`withoutOwnerLinks` plus the flag): the pane never counts one as the actor's reach, never
 * reads it as a grant still held, and never cancels one.
 */
type AdminTeamSeatRow = { id: string; workspace_id: string; team_role: string | null; is_owner_of_record: boolean | null; status: string; inviter_user_id: string; house_scope: string | null; assigned_property_ids: unknown; property_co_manager_permissions: unknown; co_manager_permissions: unknown; workspace_permissions: unknown };

/** Overall admin = the Overall admin role; manageable = the service workspaces whose team the viewer may change. */
export async function resolveAdminTeamActor(db: SupabaseClient, userId: string): Promise<AdminTeamActor> {
  const overall = await userHoldsAdminRole(db, userId);
  const manageable = new Set<string>();
  if (overall) {
    const all = await db.from("portal_workspaces").select("id").eq("is_service", true);
    if (all.error) throw new Error("Could not read service workspaces.");
    for (const row of (all.data ?? []) as { id: string }[]) manageable.add(String(row.id));
  } else {
    // A seat holder manages a workspace's team only where their own seat carries member rights (Admin / owner).
    const staff = await loadServiceStaffWorkspaces(db, userId);
    for (const workspace of staff) {
      const standing = await actorWorkspaceStanding(db, userId, workspace.id);
      if (standing?.rights.members) manageable.add(workspace.id);
    }
  }
  return { overall, manageableWorkspaceIds: manageable };
}

/**
 * `profile_roles` is the one thing an admin grant writes, so every path that is about to delete that row must first
 * check the protected primary-admin identity. A failed read refuses the operation.
 * Legacy profiles.role does not grant admin authority.
 */
async function holdsAdminOutsideRoleRow(db: SupabaseClient, userId: string): Promise<AdminTeamResult<{ holds: boolean }>> {
  const { data, error } = await db.from("profiles").select("id, email, role").eq("id", userId).maybeSingle();
  if (error) return fail(503, "Could not read that account. Please retry.");
  const profile = data as { email: string | null; role: string | null } | null;
  return { ok: true, holds: isPrimaryAdminEmail(profile?.email) };
}

/**
 * `ensureProfileRoleRow` throws on any Postgres error. Every grant path owes the caller a failure it can undo (the
 * spent invite use handed back, the audit row stamped), so the throw is caught here and answered as one.
 */
async function writeRoleRow(db: SupabaseClient, userId: string, role: "admin" | "manager"): Promise<boolean> {
  try {
    await ensureProfileRoleRow(db, userId, role);
    return true;
  } catch (error) {
    console.error("[admin-team] could not write the role row", error instanceof Error ? error.message : "unknown");
    return false;
  }
}

/** Every account currently holding the `admin` row in `profile_roles` (the only thing an Overall-admin grant writes). */
async function overallRoleHolderIds(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from("profile_roles").select("user_id").eq("role", "admin");
  if (error) throw new Error("Could not read admins.");
  return ((data ?? []) as { user_id: string }[]).map((row) => String(row.user_id));
}

/**
 * The profile row a new admin-team account needs. `profiles.role` is the legacy singular column and is stamped `manager`
 * for a brand-new account on purpose (an existing value is never changed): the admin grant is the `profile_roles` row
 * alone, so removing it removes the access. A legacy `profiles.role = 'admin'` is not a role grant.
 */
async function ensureAdminTeamProfile(db: SupabaseClient, userId: string): Promise<AdminTeamFailure | null> {
  const [existing, auth] = await Promise.all([
    db.from("profiles").select("role, full_name, phone, application_approved").eq("id", userId).maybeSingle(),
    db.auth.admin.getUserById(userId),
  ]);
  const user = auth.data?.user;
  if (!user) return fail(500, "Could not read your account. Try again.");
  const email = (user.email ?? "").trim().toLowerCase();
  const meta = (user.user_metadata ?? {}) as { full_name?: unknown; phone?: unknown };
  const current = existing.data as { role?: string | null; full_name?: string | null; phone?: string | null; application_approved?: boolean | null } | null;
  const row: Record<string, unknown> = {
    id: userId,
    ...(email ? { email } : {}),
    role: String(current?.role ?? "").trim() || primaryRoleWhenAddingManager(null),
    full_name: current?.full_name?.trim() || (typeof meta.full_name === "string" ? meta.full_name.trim() : "") || null,
    application_approved: current?.application_approved ?? true,
  };
  // The mobile the create-account form collected rides on the auth metadata; it lands on the profile only when the
  // account has none (a different number is a different proof), and stays unverified until its own code is confirmed.
  if (!String(current?.phone ?? "").trim() && typeof meta.phone === "string" && meta.phone.trim()) row.phone = meta.phone.trim();
  const up = await db.from("profiles").upsert(row, { onConflict: "id" });
  if (up.error) return fail(500, "Could not set up your account. Try again.");
  return null;
}

export type AdminGrantApplied = { role: AdminTeamRole; workspaceIds: string[] };

/**
 * Make the grant a redeemed admin invite carries. Re-derives, at THIS moment, that the inviter still holds the
 * authority (an Overall admin for an Overall grant; the workspace's own team rights, never above their role, for a
 * workspace grant), writes the audit row first, then the role. `redeemerUserId` is the signed-in session, never a body.
 */
export async function applyAdminInviteGrant(
  db: SupabaseClient,
  input: { inviterUserId: string; redeemerUserId: string; grant: StoredAdminGrant },
): Promise<AdminTeamResult<AdminGrantApplied>> {
  const { inviterUserId, redeemerUserId, grant } = input;
  let actor: AdminTeamActor;
  try {
    actor = await resolveAdminTeamActor(db, inviterUserId);
  } catch {
    return fail(503, "Could not verify this invite. Try again in a moment.");
  }
  const verdict = adminTeamGrantVerdict(actor, { role: grant.role, workspaceIds: grant.workspaceIds });
  if (!verdict.ok) {
    return fail(
      403,
      grant.role === OVERALL_ADMIN_ROLE
        ? "The person who invited you is no longer an Overall admin. Ask for a new invite."
        : "The person who invited you can no longer give this access. Ask for a new invite.",
    );
  }
  const audited = await auditAdminTeam(db, inviterUserId, "admin_team_grant", {
    inviteeUserId: redeemerUserId,
    role: grant.role,
    workspaceIds: grant.workspaceIds,
    via: "invite",
  });
  if (!audited.ok) return audited;

  if (grant.role === OVERALL_ADMIN_ROLE) {
    const profile = await ensureAdminTeamProfile(db, redeemerUserId);
    if (profile) {
      await audited.finish(false, { error: "profile_failed" });
      return profile;
    }
    if (!(await writeRoleRow(db, redeemerUserId, "admin"))) {
      await audited.finish(false, { error: "role_failed" });
      return fail(503, "Could not finish setting up your access. Try again in a moment.");
    }
    await recordGrant(db, { userId: redeemerUserId, grantedBy: inviterUserId, role: OVERALL_ADMIN_ROLE, workspaceIds: [] });
    await audited.finish(true);
    return { ok: true, role: grant.role, workspaceIds: [] };
  }

  // Every refusal a seat can raise is asked up front, with nothing written. Seating workspace A and then failing on B
  // would leave a standing PropLane seat on A while the caller hands the use back and the trail says the grant did not
  // stand - the silent partial grant this flow exists to make impossible.
  for (const workspaceId of grant.workspaceIds) {
    const checked = await checkAdminTeamSeatGrant(db, inviterUserId, { ...grant.access, teamRole: grant.role, id: workspaceId }, { overall: actor.overall });
    if (!checked.ok) {
      await audited.finish(false, { error: "seat_failed" });
      return fail(checked.status, checked.error);
    }
  }

  // A workspace role: the person needs a manager portal for the service shell to open (the same account every other
  // seat holder has), then one PropLane-issued seat per chosen workspace.
  const profile = await ensureAdminTeamProfile(db, redeemerUserId);
  if (profile) {
    await audited.finish(false, { error: "profile_failed" });
    return profile;
  }
  if (!(await writeRoleRow(db, redeemerUserId, "manager"))) {
    await audited.finish(false, { error: "role_failed" });
    return fail(503, "Could not finish setting up your access. Try again in a moment.");
  }
  const seatedWorkspaceIds: string[] = [];
  for (const workspaceId of grant.workspaceIds) {
    const seated = await seatAdminTeamMember(
      db,
      inviterUserId,
      { ...grant.access, teamRole: grant.role, id: workspaceId, userId: redeemerUserId, via: "invite" },
      { overall: actor.overall },
    );
    if (!seated.ok) {
      // The caller hands the spent use back and undoes the redemption; the trail says the grant did not stand, and
      // names any seat that was already written so a partial state is visible rather than silent.
      await audited.finish(false, { error: "seat_failed", seatedWorkspaceIds });
      return fail(seated.status, seated.error);
    }
    seatedWorkspaceIds.push(workspaceId);
  }
  await recordGrant(db, { userId: redeemerUserId, grantedBy: inviterUserId, role: grant.role, workspaceIds: grant.workspaceIds });
  await audited.finish(true);
  return { ok: true, role: grant.role, workspaceIds: grant.workspaceIds };
}

async function recordGrant(
  db: SupabaseClient,
  row: { userId: string; grantedBy: string; role: AdminTeamRole; workspaceIds: string[] },
): Promise<void> {
  const { error } = await db.from("admin_team_grants").insert({
    user_id: row.userId,
    granted_by: row.grantedBy,
    role: row.role,
    workspace_ids: row.workspaceIds,
  });
  // The audit_log row above is the authoritative trail; this list row feeds the Admin team pane. A missing table
  // (migration not applied here yet) must not undo a grant that was already audited and written.
  if (error) console.error("[admin-team] could not record the grant row", error.message);
}

async function revokeGrants(db: SupabaseClient, userId: string, revokedBy: string, role: "all" | AdminTeamRole): Promise<void> {
  const query = db
    .from("admin_team_grants")
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy })
    .eq("user_id", userId)
    .is("revoked_at", null);
  const { error } = await (role === "all" ? query : query.eq("role", role));
  if (error) console.error("[admin-team] could not mark grants revoked", error.message);
}

/**
 * The grant rows an actor who is NOT an Overall admin may mark revoked: a workspace grant whose every workspace is one
 * they manage. An Overall-admin row, or a row that also names a workspace out of their reach, is left live - the trail
 * must never record a revocation its writer had no authority over.
 */
async function revokeGrantsForWorkspaces(db: SupabaseClient, userId: string, revokedBy: string, workspaceIds: string[]): Promise<void> {
  const reach = new Set(workspaceIds);
  if (reach.size === 0) return;
  const { data, error } = await db.from("admin_team_grants").select("id, role, workspace_ids").eq("user_id", userId).is("revoked_at", null);
  if (error) {
    console.error("[admin-team] could not read grants to revoke", error.message);
    return;
  }
  const ids = ((data ?? []) as { id: string; role: string | null; workspace_ids: string[] | null }[])
    .filter((row) => row.role !== OVERALL_ADMIN_ROLE)
    .filter((row) => {
      const named = (row.workspace_ids ?? []).map(String);
      return named.length > 0 && named.every((id) => reach.has(id));
    })
    .map((row) => String(row.id));
  if (ids.length === 0) return;
  const { error: updateError } = await db
    .from("admin_team_grants")
    .update({ revoked_at: new Date().toISOString(), revoked_by: revokedBy })
    .in("id", ids)
    .is("revoked_at", null);
  if (updateError) console.error("[admin-team] could not mark grants revoked", updateError.message);
}

function houseLabel(rowData: unknown): string {
  const data = (rowData ?? {}) as { buildingName?: string; address?: string };
  return data.buildingName?.trim() || data.address?.trim() || "A property";
}

export async function listAdminTeam(db: SupabaseClient, viewerUserId: string, actor: AdminTeamActor): Promise<AdminTeamResult<{ payload: AdminTeamPayload }>> {
  const manageable = [...actor.manageableWorkspaceIds];
  const [workspaceRes, houseRes] = await Promise.all([
    manageable.length
      ? db.from("portal_workspaces").select("id, name, city, owner_user_id, created_at").eq("is_service", true).in("id", manageable)
      : Promise.resolve({ data: [], error: null }),
    manageable.length
      ? db.from("manager_property_records").select("id, row_data, workspace_id").in("workspace_id", manageable)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (workspaceRes.error || houseRes.error) return fail(503, "Could not load the admin team. Please retry.");
  type WsRow = { id: string; name: string; city: string | null; owner_user_id: string; created_at: string | null };
  const workspaceRows = ((workspaceRes.data ?? []) as WsRow[]).sort(
    (a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.name.localeCompare(b.name),
  );
  const ownerByWorkspace = new Map(workspaceRows.map((w) => [w.id, w.owner_user_id]));
  const nameByWorkspace = new Map(workspaceRows.map((w) => [w.id, w.name]));
  const housesByWorkspace = new Map<string, { id: string; label: string }[]>();
  for (const row of (houseRes.data ?? []) as { id: string; row_data: unknown; workspace_id: string }[]) {
    const list = housesByWorkspace.get(row.workspace_id) ?? [];
    list.push({ id: String(row.id), label: houseLabel(row.row_data) });
    housesByWorkspace.set(row.workspace_id, list);
  }

  // Everyone holding Overall admin. An Overall admin lists them all; a workspace admin only learns which of the seat
  // holders they already see are Overall admins (so the row reads right and is out of their reach), never the full list.
  let overallIds: string[] = [];
  try {
    overallIds = actor.overall ? await listAdminUserIds(db) : await overallRoleHolderIds(db);
  } catch {
    return fail(503, "Could not load the admin team. Please retry.");
  }

  const seatRes = manageable.length
    ? await db
        .from("account_link_invites")
        .select("id, invitee_user_id, inviter_user_id, workspace_id, team_role, status, house_scope, assigned_property_ids, is_owner_of_record")
        .in("workspace_id", manageable)
        .eq("is_service_seat", true)
        .in("status", ["accepted", "pending"])
        .not("invitee_user_id", "is", null)
    : { data: [], error: null };
  if (seatRes.error) return fail(503, "Could not load the admin team. Please retry.");
  type SeatRow = {
    id: string; invitee_user_id: string; inviter_user_id: string; workspace_id: string; team_role: string | null;
    status: "accepted" | "pending"; house_scope: string | null; assigned_property_ids: string[] | null; is_owner_of_record: boolean | null;
  };
  const seats = ((seatRes.data ?? []) as SeatRow[]).filter(
    (seat) =>
      seat.is_owner_of_record !== true &&
      seat.team_role !== "property_owner" &&
      // The membership is the workspace owner's own (the same provenance rule the staff decision applies).
      seat.inviter_user_id === ownerByWorkspace.get(seat.workspace_id),
  );

  const inviteRes = await db
    .from("manager_invite_links")
    .select("id, owner_user_id, invitee_email, admin_grant, expires_at, max_uses, used_count")
    .eq("kind", "admin")
    .is("revoked_at", null);
  const invites = inviteRes.error
    ? []
    : ((inviteRes.data ?? []) as { id: string; owner_user_id: string; invitee_email: string | null; admin_grant: unknown; expires_at: string | null; max_uses: number | null; used_count: number | null }[]).filter(
        (row) => (row.max_uses == null || (row.used_count ?? 0) < row.max_uses) && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()),
      );

  const userIds = [...new Set([...overallIds, ...seats.map((s) => s.invitee_user_id)])];
  const profileRes = userIds.length
    ? await db.from("profiles").select("id, full_name, email, phone_verified_at").in("id", userIds)
    : { data: [], error: null };
  if (profileRes.error) return fail(503, "Could not load the admin team. Please retry.");
  const profiles = new Map(
    ((profileRes.data ?? []) as { id: string; full_name: string | null; email: string | null; phone_verified_at?: string | null }[]).map((p) => [p.id, p]),
  );

  const overallSet = new Set(overallIds);
  const rows = new Map<string, AdminTeamMemberRow>();
  const rowFor = (userId: string): AdminTeamMemberRow => {
    const existing = rows.get(userId);
    if (existing) return existing;
    const profile = profiles.get(userId);
    const created: AdminTeamMemberRow = {
      key: userId,
      userId,
      name: profile?.full_name?.trim() || profile?.email?.trim() || "Teammate",
      email: profile?.email?.trim() || "",
      phoneVerified: Boolean(profile?.phone_verified_at),
      role: overallSet.has(userId) ? OVERALL_ADMIN_ROLE : "custom",
      state: "active",
      seats: [],
      inviteId: null,
      isSelf: userId === viewerUserId,
      // Overall admins are the Overall admins' to manage, never a workspace admin's.
      canManage: actor.overall,
    };
    rows.set(userId, created);
    return created;
  };
  if (actor.overall) for (const id of overallIds) rowFor(id);
  for (const seat of seats) {
    const row = rowFor(seat.invitee_user_id);
    const assigned = Array.isArray(seat.assigned_property_ids) ? seat.assigned_property_ids.map(String) : [];
    const houseScope = seat.house_scope === "selected" ? "selected" : "all";
    row.seats.push({
      linkId: seat.id,
      workspaceId: seat.workspace_id,
      workspaceName: nameByWorkspace.get(seat.workspace_id) ?? "Workspace",
      role: seat.team_role ?? "custom",
      status: seat.status,
      houseScope,
      assignedPropertyIds: assigned,
      houseCount: houseScope === "all" ? (housesByWorkspace.get(seat.workspace_id)?.length ?? 0) : assigned.length,
    });
    if (row.role !== OVERALL_ADMIN_ROLE) {
      row.role = (parseAdminTeamRole(seat.team_role) ?? "custom") as AdminTeamRole;
      row.canManage = actor.overall || actor.manageableWorkspaceIds.has(seat.workspace_id);
    }
  }
  for (const invite of invites) {
    const grant = parseStoredAdminGrant(invite.admin_grant);
    if (!grant) continue;
    const mine = invite.owner_user_id === viewerUserId;
    const visible =
      actor.overall || (grant.role !== OVERALL_ADMIN_ROLE && grant.workspaceIds.length > 0 && grant.workspaceIds.every((id) => actor.manageableWorkspaceIds.has(id)));
    if (!visible && !mine) continue;
    const email = (invite.invitee_email ?? "").trim();
    rows.set(`invite:${invite.id}`, {
      key: `invite:${invite.id}`,
      userId: null,
      name: email,
      email,
      phoneVerified: false,
      role: grant.role,
      state: "invited",
      seats: grant.workspaceIds.map((id) => ({
        linkId: "",
        workspaceId: id,
        workspaceName: nameByWorkspace.get(id) ?? "Workspace",
        role: grant.role,
        status: "pending" as const,
        houseScope: "all" as const,
        assignedPropertyIds: [],
        houseCount: housesByWorkspace.get(id)?.length ?? 0,
      })),
      inviteId: invite.id,
      isSelf: false,
      canManage: visible,
    });
  }

  const members = [...rows.values()].sort(
    (a, b) =>
      Number(b.role === OVERALL_ADMIN_ROLE) - Number(a.role === OVERALL_ADMIN_ROLE) ||
      Number(a.state === "invited") - Number(b.state === "invited") ||
      a.name.localeCompare(b.name),
  );
  return {
    ok: true,
    payload: {
      viewer: { userId: viewerUserId, overall: actor.overall },
      workspaces: workspaceRows.map((w) => ({ id: w.id, name: w.name, city: w.city?.trim() || null, houses: housesByWorkspace.get(w.id) ?? [] })),
      members: members.filter((m) => actor.overall || m.seats.length > 0),
    },
  };
}

export type ChangeAdminTeamInput = {
  userId: string;
  role: AdminTeamRole;
  workspaceIds: string[];
  access: Record<string, unknown>;
};

export const NOT_ON_TEAM_ERROR = "That person is not on the admin team. Invite them instead.";
export const CLIENT_SEAT_ERROR =
  "That person already has a seat in this workspace that its owner gave them. PropLane does not convert it; ask the owner to remove it first.";

/**
 * Change one person's role and workspaces. The person must ALREADY be on the team inside the actor's reach (an Overall
 * admin, or a PropLane-issued seat on a workspace the actor manages): a user id in the body names someone, it never seats
 * a brand-new account, which goes through an invite the person accepts. An Overall grant or revoke is Overall-admin only
 * (audited first; the last Overall admin cannot be demoted). A workspace role is written seat by seat through the same
 * validators the manager Team invite uses, only inside workspaces the actor manages, and every seat is validated BEFORE
 * anything is removed, so a refusal changes nothing.
 */
export async function changeAdminTeamMember(
  db: SupabaseClient,
  actorUserId: string,
  actor: AdminTeamActor,
  input: ChangeAdminTeamInput,
): Promise<AdminTeamResult<object>> {
  const userId = input.userId.trim();
  if (!userId) return fail(400, "Choose a teammate.");
  const verdict = adminTeamGrantVerdict(actor, { role: input.role, workspaceIds: input.workspaceIds });
  if (!verdict.ok) return verdict;
  let overallHolders: string[];
  try {
    overallHolders = await overallRoleHolderIds(db);
  } catch {
    return fail(503, "Could not read admins. Please retry.");
  }
  const outside = await holdsAdminOutsideRoleRow(db, userId);
  if (!outside.ok) return outside;
  const targetIsOverall = overallHolders.includes(userId) || outside.holds;
  if (targetIsOverall && !actor.overall) return fail(403, "Only an Overall admin can change an Overall admin.");

  const seatsNow = withoutOwnerLinks(
    await db
      .from("account_link_invites")
      .select("id, workspace_id, team_role, is_owner_of_record, status, inviter_user_id, house_scope, assigned_property_ids, property_co_manager_permissions, co_manager_permissions, workspace_permissions")
      .eq("invitee_user_id", userId)
      .eq("is_service_seat", true)
      .in("status", ["accepted", "pending"]),
  );
  if (seatsNow.error) return fail(503, "Could not change the role. Please retry.");
  const currentSeats = ((seatsNow.data ?? []) as AdminTeamSeatRow[]).filter((seat) => seat.is_owner_of_record !== true);
  if (!targetIsOverall && !currentSeats.some((seat) => actor.manageableWorkspaceIds.has(seat.workspace_id))) {
    return fail(404, NOT_ON_TEAM_ERROR);
  }

  if (input.role === OVERALL_ADMIN_ROLE) {
    if (overallHolders.includes(userId)) return { ok: true };
    const audited = await auditAdminTeam(db, actorUserId, "admin_team_grant", { inviteeUserId: userId, role: OVERALL_ADMIN_ROLE, workspaceIds: [], via: "change" });
    if (!audited.ok) return audited;
    if (!(await writeRoleRow(db, userId, "admin"))) {
      await audited.finish(false, { error: "role_failed" });
      return fail(503, "Could not change the role. Please retry.");
    }
    await recordGrant(db, { userId, grantedBy: actorUserId, role: OVERALL_ADMIN_ROLE, workspaceIds: [] });
    await audited.finish(true);
    return { ok: true };
  }

  const chosen = new Set(input.workspaceIds);
  // Every refusal a seat can raise is asked up front, with nothing written: a demotion that deleted the Overall role and
  // then found a workspace it could not seat would leave the person with neither.
  for (const workspaceId of chosen) {
    const checked = await checkAdminTeamSeatGrant(db, actorUserId, { ...input.access, teamRole: input.role, id: workspaceId }, { overall: actor.overall });
    if (!checked.ok) return fail(checked.status, checked.error);
  }
  if (chosen.size > 0) {
    const held = await db
      .from("account_link_invites")
      .select("workspace_id, is_service_seat")
      .eq("invitee_user_id", userId)
      .in("workspace_id", [...chosen])
      .in("status", ["accepted", "pending"]);
    if (held.error) return fail(503, "Could not change the role. Please retry.");
    // A seat the workspace's own owner issued is theirs to manage; PropLane's pane never quietly rewrites it into a PropLane seat.
    if (((held.data ?? []) as { is_service_seat?: boolean | null }[]).some((row) => row.is_service_seat !== true)) {
      return fail(409, CLIENT_SEAT_ERROR);
    }
  }

  // Check a possible completed retry under the same database lifecycle lock.
  // A different current state remains an ordinary authorized seat edit.
  if (!targetIsOverall && actor.overall) {
    const plan = [];
    for (const workspaceId of chosen) {
      const prepared = await prepareAdminTeamSeatGrant(db, actorUserId, { ...input.access, teamRole: input.role, id: workspaceId, userId });
      if (!prepared.ok) return fail(prepared.status, prepared.error);
      plan.push({ workspaceId, ownerUserId: prepared.ownerUserId, grant: prepared.grant });
    }
    const gate = await requireAdminRoute();
    if (!gate.ok || gate.userId !== actorUserId) return fail(403, "Only an Overall admin can check this change.");
    const retry = await db.rpc("demote_admin_team_role", { p_actor: actorUserId, p_target: userId, p_plan: plan, p_expected_seats: [], p_via: "change", p_check_only: true });
    if (retry.error) return fail(503, "Could not check the role. Please retry.");
    if (retry.data === "already_revoked") return { ok: true };
    if (retry.data !== "stale") return fail(retry.data === "forbidden" ? 403 : 409, "This teammate changed. Refresh and try again.");
  }

  // An Overall demotion is one transaction with its workspace-seat changes.
  if (overallHolders.includes(userId)) {
    const gate = await requireAdminRoute();
    if (!gate.ok || gate.userId !== actorUserId) return fail(403, "Only an Overall admin can change an Overall admin.");
    if (outside.holds) return fail(409, "This account is protected by the primary-admin email.");
    const plan = [];
    for (const workspaceId of chosen) {
      const prepared = await prepareAdminTeamSeatGrant(db, actorUserId, { ...input.access, teamRole: input.role, id: workspaceId, userId });
      if (!prepared.ok) return fail(prepared.status, prepared.error);
      plan.push({ workspaceId, ownerUserId: prepared.ownerUserId, grant: prepared.grant });
    }
    const expectedSeats = currentSeats.filter((seat) => actor.manageableWorkspaceIds.has(seat.workspace_id)).map((seat) => ({ id: seat.id, status: seat.status, workspaceId: seat.workspace_id, role: seat.team_role, inviterUserId: seat.inviter_user_id, houseScope: seat.house_scope, assignedPropertyIds: seat.assigned_property_ids, propertyCoManagerPermissions: seat.property_co_manager_permissions, coManagerPermissions: seat.co_manager_permissions, workspacePermissions: seat.workspace_permissions }));
    const result = await db.rpc("demote_admin_team_role", { p_actor: actorUserId, p_target: userId, p_plan: plan, p_expected_seats: expectedSeats, p_via: "change" });
    if (result.error) return fail(503, "Could not change the role. Please retry.");
    if (result.data === "already_revoked") return { ok: true };
    if (result.data !== "revoked") return fail(result.data === "invalid" ? 400 : result.data === "forbidden" ? 403 : result.data === "stale" || result.data === "last_admin" ? 409 : 503, "Could not change the role. Please refresh and retry.");
    await revokeGrants(db, userId, actorUserId, OVERALL_ADMIN_ROLE);
    await recordGrant(db, { userId, grantedBy: actorUserId, role: input.role, workspaceIds: input.workspaceIds });
    return { ok: true };
  }

  for (const workspaceId of chosen) {
    const seated = await seatAdminTeamMember(
      db,
      actorUserId,
      { ...input.access, teamRole: input.role, id: workspaceId, userId, via: "change" },
      { overall: actor.overall },
    );
    if (!seated.ok) {
      return fail(seated.status, seated.error);
    }
  }
  // Workspaces the person leaves, inside the actor's reach only.
  for (const seat of currentSeats) {
    if (chosen.has(seat.workspace_id) || !actor.manageableWorkspaceIds.has(seat.workspace_id)) continue;
    const removed = await removeServiceTeamMember(db, actorUserId, { id: seat.workspace_id, linkId: seat.id }, { overall: actor.overall });
    if (!removed.ok) {
      return fail(removed.status, removed.error);
    }
  }
  await recordGrant(db, { userId, grantedBy: actorUserId, role: input.role, workspaceIds: input.workspaceIds });
  return { ok: true };
}

async function allOverallAdminIds(db: SupabaseClient): Promise<string[]> {
  return listAdminUserIds(db);
}

/**
 * Remove a person from the admin team: their Overall admin role (Overall admins only, never the last), and every
 * workspace seat inside the actor's reach. Or turn off a pending invite (`inviteId`).
 */
export async function removeAdminTeamMember(
  db: SupabaseClient,
  actorUserId: string,
  actor: AdminTeamActor,
  input: { userId?: string; inviteId?: string },
): Promise<AdminTeamResult<object>> {
  if (input.inviteId) {
    const { data, error } = await db
      .from("manager_invite_links")
      .select("id, owner_user_id, admin_grant")
      .eq("id", input.inviteId)
      .eq("kind", "admin")
      .is("revoked_at", null)
      .maybeSingle();
    if (error || !data) return fail(404, "That invite no longer exists.");
    const row = data as { owner_user_id: string; admin_grant: unknown };
    const grant = parseStoredAdminGrant(row.admin_grant);
    const mine = row.owner_user_id === actorUserId;
    const reach = grant !== null && grant.role !== OVERALL_ADMIN_ROLE && grant.workspaceIds.every((id) => actor.manageableWorkspaceIds.has(id));
    if (!(actor.overall || reach || (mine && grant !== null && grant.role !== OVERALL_ADMIN_ROLE))) return fail(403, "You cannot turn off this invite.");
    const audited = await auditAdminTeam(db, actorUserId, "admin_team_invite_revoke", { inviteId: input.inviteId, role: grant?.role ?? null });
    if (!audited.ok) return audited;
    const res = await db
      .from("manager_invite_links")
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", input.inviteId)
      .eq("kind", "admin");
    if (res.error) {
      await audited.finish(false, { error: "update_failed" });
      return fail(503, "Could not turn off the invite. Please retry.");
    }
    await audited.finish(true);
    return { ok: true };
  }
  const userId = (input.userId ?? "").trim();
  if (!userId) return fail(400, "Choose a teammate.");
  let overallHolders: string[];
  try {
    overallHolders = await overallRoleHolderIds(db);
  } catch {
    return fail(503, "Could not read admins. Please retry.");
  }
  const outside = await holdsAdminOutsideRoleRow(db, userId);
  if (!outside.ok) return outside;
  const targetIsOverall = overallHolders.includes(userId) || outside.holds;

  const seats = withoutOwnerLinks(
    await db
      .from("account_link_invites")
      .select("id, workspace_id, team_role, is_owner_of_record, status, inviter_user_id, house_scope, assigned_property_ids, property_co_manager_permissions, co_manager_permissions, workspace_permissions")
      .eq("invitee_user_id", userId)
      .eq("is_service_seat", true)
      .in("status", ["accepted", "pending"]),
  );
  if (seats.error) return fail(503, "Could not remove the teammate. Please retry.");
  const reachable = ((seats.data ?? []) as AdminTeamSeatRow[]).filter(
    (seat) => seat.is_owner_of_record !== true && actor.manageableWorkspaceIds.has(seat.workspace_id),
  );
  // The same reach `changeAdminTeamMember` asks for, and asked BEFORE anything is written: a user id in the body names
  // someone, it never hands the actor authority over an account they do not manage - including over its grant trail.
  if (!targetIsOverall && reachable.length === 0) {
    if (actor.overall) {
      const gate = await requireAdminRoute();
      if (!gate.ok || gate.userId !== actorUserId) return fail(403, "Only an Overall admin can check this removal.");
      const marker = await db.rpc("demote_admin_team_role", { p_actor: actorUserId, p_target: userId, p_plan: [], p_expected_seats: [], p_via: "remove", p_check_only: true });
      if (marker.error) return fail(503, "Could not check the removal. Please retry.");
      if (marker.data === "already_revoked") return { ok: true };
      if (marker.data !== "stale") return fail(marker.data === "forbidden" ? 403 : 409, "This teammate changed. Refresh and try again.");
    }
    return fail(404, NOT_ON_TEAM_ERROR);
  }

  if (targetIsOverall) {
    if (!actor.overall) return fail(403, "Only an Overall admin can remove an Overall admin.");
    let allOverall: string[];
    try {
      allOverall = await allOverallAdminIds(db);
    } catch {
      return fail(503, "Could not read admins. Please retry.");
    }
    const last = lastOverallAdminVerdict(allOverall, userId);
    if (!last.ok) return last;
    if (!overallHolders.includes(userId)) {
      return fail(409, "This account is protected by the primary-admin email.");
    }
    const gate = await requireAdminRoute();
    if (!gate.ok || gate.userId !== actorUserId) return fail(403, "Only an Overall admin can remove an Overall admin.");
    const expectedSeats = reachable.map((seat) => ({ id: seat.id, status: seat.status, workspaceId: seat.workspace_id, role: seat.team_role, inviterUserId: seat.inviter_user_id, houseScope: seat.house_scope, assignedPropertyIds: seat.assigned_property_ids, propertyCoManagerPermissions: seat.property_co_manager_permissions, coManagerPermissions: seat.co_manager_permissions, workspacePermissions: seat.workspace_permissions }));
    const result = await db.rpc("demote_admin_team_role", { p_actor: actorUserId, p_target: userId, p_plan: [], p_expected_seats: expectedSeats, p_via: "remove" });
    if (result.error) return fail(503, "Could not remove the admin. Please retry.");
    if (result.data === "already_revoked") return { ok: true };
    if (result.data !== "revoked") return fail(result.data === "invalid" ? 400 : result.data === "forbidden" ? 403 : result.data === "stale" || result.data === "last_admin" ? 409 : 503, "Could not remove the admin. Please refresh and retry.");
    await revokeGrants(db, userId, actorUserId, OVERALL_ADMIN_ROLE);
  }
  for (const seat of targetIsOverall ? [] : reachable) {
    const removed = await removeServiceTeamMember(db, actorUserId, { id: seat.workspace_id, linkId: seat.id }, { overall: actor.overall });
    if (!removed.ok) return fail(removed.status, removed.error);
  }
  // An Overall admin reaches every service workspace, so every remaining grant row is theirs to close. A workspace
  // admin closes only the rows that name the workspaces they just emptied.
  if (actor.overall) await revokeGrants(db, userId, actorUserId, "all");
  else await revokeGrantsForWorkspaces(db, userId, actorUserId, reachable.map((seat) => seat.workspace_id));
  return { ok: true };
}

/** Does this account still hold what an admin grant gave it? (The same-account re-open message must not lie.) */
export async function adminGrantStillHeld(db: SupabaseClient, userId: string, grant: StoredAdminGrant): Promise<boolean> {
  if (grant.role === OVERALL_ADMIN_ROLE) return userHoldsAdminRole(db, userId);
  const { data, error } = withoutOwnerLinks(
    await db
      .from("account_link_invites")
      .select("workspace_id, team_role, is_owner_of_record")
      .eq("invitee_user_id", userId)
      .eq("is_service_seat", true)
      .eq("status", "accepted")
      .in("workspace_id", grant.workspaceIds),
  );
  if (error) return false;
  const held = new Set(
    ((data ?? []) as AdminTeamSeatRow[]).filter((row) => row.is_owner_of_record !== true).map((row) => String(row.workspace_id)),
  );
  return grant.workspaceIds.every((id) => held.has(id));
}
