import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAdminUserIds, userHoldsAdminRole } from "@/lib/auth/admin-role";
import { ensureProfileProplaneId } from "@/lib/manager-access-server";
import { flatTeamRoleGrant, stampTeamRoleOnProperties, stampTeamRolePermissions } from "@/lib/co-manager-team-roles";
import { actorWorkspaceStanding, workspaceAdminCount } from "@/lib/workspaces/membership.server";
import { canActOnMember } from "@/lib/workspaces/membership";
import { cleanOwnerOfRecord, cleanServiceCity, cleanServiceName } from "@/lib/service/service-input";
import { updateAuditResult, writeAuditLog } from "@/lib/tools/audit";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import { proplaneIdLookupVariants } from "@/lib/manager-id";
import { userIsPropertyPortalManager } from "@/lib/auth/co-manager-invite-eligibility.server";
import { loadSharedLineConfig, workspaceHasDedicatedNumber, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { isPlatformServiceOwner, loadServiceWorkspace, resolveServiceOwner } from "@/lib/service/service-owner.server";
import { ensureServiceFeePolicy, setServiceManagementFee, PolicyError, type PolicyRow } from "@/lib/owner-management/policies.server";

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

/**
 * One audit row per admin Service change, under the workspace owner (so "everything ever done to this account" finds it).
 * `required` changes (who sees a client's finances, who is on the team) refuse 503 when the row could not be recorded,
 * so no audit row means no change; the rest log and carry on.
 */
async function auditServiceChange(
  db: SupabaseClient,
  operatorUserId: string,
  workspaceOwnerId: string,
  action: string,
  summary: Record<string, unknown>,
  required: boolean,
): Promise<ServiceFailure | null> {
  const audit = await writeAuditLog(
    { db, landlordId: workspaceOwnerId, userId: operatorUserId },
    { action, toolName: action, inputSummary: summary, resultSummary: { applied: false }, dedupeKey: `${action}:${randomUUID()}` },
  );
  if (audit.recorded) return null;
  if (!required) {
    console.error(`[service-workspaces] audit row for ${action} was not recorded`);
    return null;
  }
  return fail(503, "Could not record the audit entry, so nothing was changed. Please retry.");
}

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
  /** The number this workspace actually texts from: its own number only when dedicated (working number plus paid entitlement), else the shared PropLane line it is on, else none. */
  workNumber: string | null;
  workNumberSource: "own" | "shared" | null;
  teamCount: number;
  /** What the viewing operator is in this workspace; null = not a member (cannot open it). */
  viewerRole: string | null;
  canManage: boolean;
  /** Percent PropLane keeps of this workspace's rent (its active management fee), null until one exists. */
  feePercent: number | null;
};

export type ServiceListPayload = {
  configured: boolean;
  ownerUserId: string | null;
  workspaces: ServiceWorkspaceListRow[];
};

/**
 * No number is provisioned, reserved or exempted for a service workspace. It has a number of its own only when it
 * is DEDICATED (a working number AND a paid personalized-number entitlement: `workspaceHasDedicatedNumber`, the
 * same decision W16's display resolver and the send path use); otherwise it texts from the shared PropLane line
 * while it is on it; otherwise (per_workspace) there is none to show.
 */
function resolveTextingNumber(
  own: Record<string, unknown> | undefined,
  sharedLine: Awaited<ReturnType<typeof loadSharedLineConfig>>,
  workspaceId: string,
): { workNumber: string | null; workNumberSource: "own" | "shared" | null } {
  if (workspaceHasDedicatedNumber(sharedLine, workspaceId)) {
    const ownNumber = typeof own?.phone_number === "string" && own.phone_number.trim() ? own.phone_number.trim() : null;
    return ownNumber ? { workNumber: ownNumber, workNumberSource: "own" } : { workNumber: null, workNumberSource: null };
  }
  if (workspaceOnSharedLine(sharedLine, workspaceId) && sharedLine.sharedNumber) {
    return { workNumber: sharedLine.sharedNumber, workNumberSource: "shared" };
  }
  return { workNumber: null, workNumberSource: null };
}

function ownerOfRecordFor(
  typedName: string | null,
  members: Record<string, unknown>[],
  profileName: Map<string, string>,
  ownersOwn: { userId: string } | null,
): { name: string; linked: boolean } | null {
  // An attached client who still owns the workspace IS its owner of record (flagged on the workspace itself).
  if (ownersOwn) return { name: profileName.get(ownersOwn.userId) || typedName?.trim() || "Owner", linked: true };
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

/**
 * Every workspace carrying the `is_service` flag, whoever owns it: the service owner for one PropLane created, the
 * client for one attached with `attachWorkspaceToService`. What the operator may DO in each is their own membership.
 */
export async function listServiceWorkspaces(db: SupabaseClient, operatorUserId: string): Promise<ServiceResult<{ payload: ServiceListPayload }>> {
  const owner = await resolveServiceOwner(db);
  if (!owner.ok && owner.reason !== "not_configured") return fail(503, "Could not load service workspaces. Please retry.");
  const configured = owner.ok;
  const ownerUserId = owner.ok ? owner.ownerUserId : null;
  const ws = await db
    .from("portal_workspaces")
    .select("id, name, city, owner_user_id, is_default, owner_of_record_name")
    .eq("is_service", true)
    .order("created_at");
  if (ws.error) return fail(503, "Could not load service workspaces. Please retry.");
  const rows = (ws.data ?? []) as {
    id: string;
    name: string;
    city: string | null;
    owner_user_id: string;
    is_default: boolean;
    owner_of_record_name: string | null;
  }[];
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return { ok: true, payload: { configured, ownerUserId, workspaces: [] } };

  const feePercents = await serviceFeePercents(db, ids);
  const [houses, numbers, links, sharedLine] = await Promise.all([
    db.from("manager_property_records").select("id, workspace_id, manager_user_id").in("workspace_id", ids),
    db.from("manager_sms_numbers").select("workspace_id, phone_number, provision_state, released_at").in("workspace_id", ids),
    db
      .from("account_link_invites")
      .select("id, workspace_id, inviter_user_id, invitee_user_id, team_role, status, is_owner_of_record, invitee_display_name")
      .in("workspace_id", ids)
      .in("status", ["accepted", "pending"]),
    loadSharedLineConfig(db),
  ]);
  if (houses.error || numbers.error || links.error) return fail(503, "Could not load service workspaces. Please retry.");
  // The owner of record's name for an ACCEPTED flagged member comes from their profile; a pending one is shown
  // by the name snapshot taken at invite time (never the live profile: they have not consented yet). A workspace
  // whose own owner is the owner of record names that owner.
  const flagged = ((links.data ?? []) as Record<string, unknown>[]).filter((l) => l.is_owner_of_record === true);
  // An attached client still owns their workspace and IS its owner of record (no membership row needed).
  const ownerIsRecord = (r: { owner_user_id: string }) => ownerUserId !== null && r.owner_user_id !== ownerUserId;
  const profileIds = [
    ...new Set([
      ...flagged.filter((l) => l.status === "accepted").map((l) => String(l.invitee_user_id)),
      ...rows.filter(ownerIsRecord).map((r) => r.owner_user_id),
    ]),
  ];
  const flaggedProfiles = profileIds.length
    ? await db.from("profiles").select("id, full_name, email").in("id", profileIds)
    : { data: [], error: null };
  const profileName = new Map(
    ((flaggedProfiles.data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p.full_name?.trim() || p.email?.trim() || ""]),
  );

  const out: ServiceWorkspaceListRow[] = rows.map((row) => {
    const live = ((numbers.data ?? []) as Record<string, unknown>[]).find((n) => n.workspace_id === row.id && !n.released_at);
    // Memberships of THIS workspace, granted by its own owner (a row from anyone else is not a membership of it).
    const members = ((links.data ?? []) as Record<string, unknown>[]).filter((l) => l.workspace_id === row.id && l.inviter_user_id === row.owner_user_id);
    const mine = members.find((l) => l.invitee_user_id === operatorUserId && l.status === "accepted");
    const isOwner = operatorUserId === row.owner_user_id;
    const myRole = isOwner ? "owner" : mine ? String(mine.team_role ?? "custom") : null;
    return {
      id: row.id,
      name: row.name,
      city: row.city?.trim() || null,
      ownerOfRecord: ownerOfRecordFor(row.owner_of_record_name, members, profileName, ownerIsRecord(row) ? { userId: row.owner_user_id } : null),
      isDefault: row.is_default,
      houseCount: ((houses.data ?? []) as Record<string, unknown>[]).filter((h) => h.workspace_id === row.id).length,
      ...resolveTextingNumber(live, sharedLine, row.id),
      teamCount: members.filter((l) => l.status === "accepted").length,
      viewerRole: myRole,
      canManage: myRole === "owner" || myRole === "admin" || myRole === "full",
      feePercent: feePercents.get(row.id) ?? null,
    };
  });
  return { ok: true, payload: { configured, ownerUserId, workspaces: out } };
}

/** Add a membership of `workspaceId` for `userId`, under the service owner: Admin, or Property owner for the owner of record. */
async function insertAdminMembership(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string,
  userId: string,
  opts: { pending?: boolean; ownerOfRecord?: boolean } = {},
): Promise<ServiceFailure | { ok: true; linkId: string }> {
  // The owner of record is the CLIENT, not an operator: they join as a Property owner (the existing owner role),
  // which is what lands them in the owner portal instead of the manager portal when they sign in.
  const asOwner = opts.ownerOfRecord === true;
  let ownerHouseIds: string[] = [];
  if (asOwner) {
    const houses = await db.from("manager_property_records").select("id").eq("manager_user_id", ownerUserId).eq("workspace_id", workspaceId);
    if (houses.error) return fail(503, "Could not read the workspace's houses. Please retry.");
    ownerHouseIds = ((houses.data ?? []) as { id: unknown }[]).map((h) => String(h.id));
  }
  const [inviter, invitee] = await Promise.all([
    ensureProfileProplaneId(db as never, ownerUserId),
    ensureProfileProplaneId(db as never, userId),
  ]);
  if (!inviter.ok || !invitee.ok) return fail(503, "Could not read the accounts. Please retry.");
  const ownerHouseMap = stampTeamRoleOnProperties("property_owner", ownerHouseIds, {});
  const stamp = asOwner ? (flatTeamRoleGrant("property_owner", ownerHouseMap) ?? {}) : (stampTeamRolePermissions("admin") ?? {});
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
      assigned_property_ids: ownerHouseIds,
      payout_percent_for_manager: 0,
      property_co_manager_permissions: ownerHouseMap,
      co_manager_permissions: stamp,
      workspace_id: workspaceId,
      workspace_permissions: {},
      team_role: asOwner ? "property_owner" : "admin",
      house_scope: asOwner ? "selected" : "all",
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
  await auditServiceChange(db, operatorUserId, owner.ownerUserId, "admin_service_create", { workspaceId: id, name, city, ownerOfRecordName: client ?? null }, false);
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
  // The automatic management fee. A new workspace has no owner of record yet, so this usually answers "no_owner" and the fee is
  // created the first time anything needs it; it never blocks creating the workspace.
  await ensureServiceFeePolicy(db, id, { role: "admin", userId: operatorUserId });
  return { ok: true, id };
}

export const ADMIN_SERVICE_ATTACH_AUDIT_ACTION = "admin_service_attach";

/** Seat `userId` as an accepted Admin member of the workspace unless they already are one (any other live row refuses). */
async function ensureAdminMember(db: SupabaseClient, workspaceOwnerId: string, workspaceId: string, userId: string): Promise<ServiceFailure | { ok: true; added: boolean; linkId: string | null }> {
  const existing = await db
    .from("account_link_invites")
    .select("id, team_role, status")
    .eq("inviter_user_id", workspaceOwnerId)
    .eq("invitee_user_id", userId)
    .eq("workspace_id", workspaceId)
    .in("status", ["accepted", "pending"])
    .maybeSingle();
  if (existing.error) return fail(503, "Could not read the workspace's team. Please retry.");
  if (existing.data) {
    const row = existing.data as { id: string; team_role: string | null; status: string };
    if (row.status === "accepted" && (row.team_role === "admin" || row.team_role === "full")) return { ok: true, added: false, linkId: row.id };
    return fail(409, "A PropLane admin is already on this workspace's team with another role. Remove them from its team first.");
  }
  const added = await insertAdminMembership(db, workspaceOwnerId, workspaceId, userId);
  return added.ok ? { ok: true, added: true, linkId: added.linkId } : added;
}

/**
 * Attach an existing workspace to PropLane Service. PropLane Service is a FLAG on a workspace plus memberships,
 * not ownership: this sets `is_service`, the city and the label (the workspace's name), and seats the service owner
 * (and the operator) as accepted Admin members. The workspace's own owner is its owner of record by being its owner.
 * It never changes `owner_user_id` and writes no property, lease or charge row. The caller proves the operator is a platform admin
 * (`requireAdminRoute`); the audit row is written BEFORE anything changes, so no audit row means no change.
 */
export async function attachWorkspaceToService(
  db: SupabaseClient,
  operatorUserId: string,
  input: { workspaceId: unknown; city: unknown; label: unknown; reason?: unknown },
): Promise<ServiceResult<{ id: string }>> {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) return fail(400, "Give a reason of 3 to 500 characters.");
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) return fail(400, "Choose a workspace.");
  const city = cleanServiceCity(input.city);
  if (city === undefined) return fail(400, "Use a city of up to 80 characters.");
  const label = cleanOwnerOfRecord(input.label);
  if (label === undefined) return fail(400, "Use a label of up to 80 characters.");

  // Re-derived here, never taken from the caller: only a platform admin attaches a workspace.
  if (!(await userHoldsAdminRole(db, operatorUserId))) return fail(403, "Only a PropLane admin can attach a workspace.");
  const serviceOwner = await resolveServiceOwner(db);
  if (!serviceOwner.ok) return fail(serviceOwner.reason === "not_configured" ? 409 : 503, serviceOwner.reason === "not_configured" ? SERVICE_NOT_CONFIGURED : "Could not reach the service settings. Please retry.");

  const found = await db.from("portal_workspaces").select("id, name, owner_user_id, is_service").eq("id", workspaceId).maybeSingle();
  if (found.error) return fail(503, "Could not read the workspace. Please retry.");
  if (!found.data) return fail(404, "Workspace not found.");
  const workspace = found.data as { id: string; name: string; owner_user_id: string; is_service: boolean | null };
  if (workspace.is_service === true) return fail(409, "This workspace is already on PropLane Service.");
  const workspaceOwnerId = String(workspace.owner_user_id);
  // The workspace's own owner becomes its owner of record (derived from ownership, nothing stored). A member already
  // flagged as the owner of record would make two, so that is refused.
  const ownedByServiceOwner = workspaceOwnerId === serviceOwner.ownerUserId;
  if (!ownedByServiceOwner) {
    const flagged = await db
      .from("account_link_invites")
      .select("id")
      .eq("workspace_id", workspace.id)
      .eq("is_owner_of_record", true)
      .in("status", ["accepted", "pending"]);
    if (flagged.error) return fail(503, "Could not attach the workspace. Please retry.");
    if ((flagged.data ?? []).length > 0) return fail(409, "This workspace already has an owner of record.");
  }

  // Audit first. The trail is under the workspace owner, so "everything ever done to this account" finds it.
  const auditKey = `${ADMIN_SERVICE_ATTACH_AUDIT_ACTION}:${workspace.id}:${Date.now()}`;
  const actor = { db, landlordId: workspaceOwnerId, userId: operatorUserId };
  const audit = await writeAuditLog(actor, {
    action: ADMIN_SERVICE_ATTACH_AUDIT_ACTION,
    toolName: ADMIN_SERVICE_ATTACH_AUDIT_ACTION,
    inputSummary: { workspaceId: workspace.id, workspaceOwnerUserId: workspaceOwnerId, serviceOwnerUserId: serviceOwner.ownerUserId, city, label, reason, ownerIsOwnerOfRecord: !ownedByServiceOwner },
    resultSummary: { applied: false },
    dedupeKey: auditKey,
  });
  if (!audit.recorded) return fail(503, "Could not record the audit entry, so nothing was changed. Please retry.");

  const flagged = await db
    .from("portal_workspaces")
    .update({ is_service: true, city, ...(label ? { name: label } : {}) })
    .eq("id", workspace.id)
    .eq("owner_user_id", workspaceOwnerId)
    .eq("is_service", false);
  const undo = async (message: string, status = 503): Promise<ServiceFailure> => {
    await db
      .from("portal_workspaces")
      .update({ is_service: false, city: null, name: workspace.name })
      .eq("id", workspace.id)
      .eq("owner_user_id", workspaceOwnerId);
    await updateAuditResult(actor, auditKey, { applied: false, error: "rolled_back" });
    return fail(status, message);
  };
  if (flagged.error) return undo("Could not attach the workspace. Please retry.");

  // The service owner and the attaching operator become Admin members (the workspace's own owner is not a member).
  const seats = [...new Set([serviceOwner.ownerUserId, operatorUserId])].filter((id) => id !== workspaceOwnerId);
  const seated: string[] = [];
  for (const userId of seats) {
    const seat = await ensureAdminMember(db, workspaceOwnerId, workspace.id, userId);
    if (!seat.ok) {
      // Withdraw only the seats this attach added, then the flag.
      for (const linkId of seated) await db.from("account_link_invites").delete().eq("id", linkId).eq("workspace_id", workspace.id);
      return undo(seat.error, seat.status);
    }
    if (seat.added && seat.linkId) seated.push(seat.linkId);
  }
  await updateAuditResult(actor, auditKey, { applied: true });
  // The automatic management fee (no signature): the client who owns the attached workspace is its owner of record.
  await ensureServiceFeePolicy(db, workspace.id, { role: "admin", userId: operatorUserId });
  return { ok: true, id: workspace.id };
}

/**
 * Admin > Service > Management fee: the percent PropLane keeps of a service workspace's rent (0 to 30). A new policy version at
 * that rate replaces the active one atomically (`setServiceManagementFee`). The operator must be a platform admin and the
 * workspace must carry the service flag; the audit row is written before the change, so no audit row means no change.
 */
export async function setServiceWorkspaceFee(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string; percent: unknown },
): Promise<ServiceResult<{ feePercent: number }>> {
  if (!(await userHoldsAdminRole(db, operatorUserId))) return fail(403, "Only a PropLane admin can change the management fee.");
  const workspace = await loadServiceWorkspace(db, input.id);
  if (!workspace) return fail(404, "Service workspace not found.");
  const percent = typeof input.percent === "number" ? input.percent : typeof input.percent === "string" && input.percent.trim() !== "" ? Number(input.percent) : NaN;
  if (!Number.isFinite(percent) || percent < 0 || percent > 30) return fail(400, "Enter a fee between 0 and 30%.");
  const auditKey = `admin_service_fee:${workspace.id}:${Date.now()}`;
  const actor = { db, landlordId: workspace.ownerUserId, userId: operatorUserId };
  const audit = await writeAuditLog(actor, {
    action: "admin_service_fee",
    toolName: "admin_service_fee",
    inputSummary: { workspaceId: workspace.id, feePercent: percent },
    resultSummary: { applied: false },
    dedupeKey: auditKey,
  });
  if (!audit.recorded) return fail(503, "Could not record the audit entry, so nothing was changed. Please retry.");
  let policy: PolicyRow;
  try {
    policy = await setServiceManagementFee(db, { role: "admin", userId: operatorUserId }, workspace.id, percent);
  } catch (e) {
    await updateAuditResult(actor, auditKey, { applied: false, error: "refused" });
    if (e instanceof PolicyError) return fail(e.status, e.message);
    return fail(503, "Could not change the management fee. Please retry.");
  }
  await updateAuditResult(actor, auditKey, { applied: true, policyId: policy.id });
  return { ok: true, feePercent: (10_000 - policy.terms.ownerShareBps) / 100 };
}

/** The percent PropLane keeps for each service workspace right now (null: no active policy yet). Never throws. */
export async function serviceFeePercents(db: SupabaseClient, workspaceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .select("workspace_id, owner_share_bps")
    .in("workspace_id", workspaceIds)
    .eq("status", "active");
  if (error) return out;
  for (const r of (data ?? []) as { workspace_id: string; owner_share_bps: number }[]) out.set(String(r.workspace_id), (10_000 - Number(r.owner_share_bps)) / 100);
  return out;
}

export type ServiceAttachCandidate = { id: string; name: string; ownerName: string; ownerEmail: string };

/** Workspaces not yet on PropLane Service, for the Attach picker. Platform admins only; a search narrows it. */
export async function listServiceAttachCandidates(
  db: SupabaseClient,
  operatorUserId: string,
  query: unknown,
): Promise<ServiceResult<{ candidates: ServiceAttachCandidate[] }>> {
  if (!(await userHoldsAdminRole(db, operatorUserId))) return fail(403, "Only a PropLane admin can attach a workspace.");
  const needle = (typeof query === "string" ? query.trim().toLowerCase() : "").slice(0, 80);
  const ws = await db.from("portal_workspaces").select("id, name, owner_user_id").eq("is_service", false).order("name").limit(1000);
  if (ws.error) return fail(503, "Could not load workspaces. Please retry.");
  const rows = (ws.data ?? []) as { id: string; name: string; owner_user_id: string }[];
  const ownerIds = [...new Set(rows.map((r) => r.owner_user_id))];
  const profiles = ownerIds.length ? await db.from("profiles").select("id, full_name, email").in("id", ownerIds) : { data: [], error: null };
  if (profiles.error) return fail(503, "Could not load workspaces. Please retry.");
  const byId = new Map(((profiles.data ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p]));
  const all = rows.map((r) => ({
    id: r.id,
    name: r.name,
    ownerName: byId.get(r.owner_user_id)?.full_name?.trim() || "",
    ownerEmail: byId.get(r.owner_user_id)?.email?.trim() || "",
  }));
  const hits = needle ? all.filter((c) => `${c.name} ${c.ownerName} ${c.ownerEmail}`.toLowerCase().includes(needle)) : all;
  return { ok: true, candidates: hits.slice(0, 25) };
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
  await auditServiceChange(db, operatorUserId, who.workspace.ownerUserId, "admin_service_rename", { workspaceId: who.workspace.id, name, city, ownerOfRecordName: client ?? undefined }, false);
  const res = await db
    .from("portal_workspaces")
    .update({
      name,
      city,
      ...(client !== undefined ? { owner_of_record_name: client } : {}),
    })
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
  const [members, workspace] = await Promise.all([
    db
      .from("account_link_invites")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("is_owner_of_record", true)
      .in("status", ["accepted", "pending"]),
    db.from("portal_workspaces").select("owner_user_id").eq("id", workspaceId).maybeSingle(),
  ]);
  if (members.error || workspace.error) return null;
  // The owner of an attached client workspace (anyone but the service owner) IS the owner of record: then no member can also be.
  const workspaceOwner = String((workspace.data as { owner_user_id?: unknown } | null)?.owner_user_id ?? "");
  if (workspaceOwner && !(await isPlatformServiceOwner(db, workspaceOwner))) return true;
  return ((members.data ?? []) as { id: string }[]).some((r) => r.id !== exceptLinkId);
}

/**
 * Invite a client person (the property owner, or someone on their side) by PropLane ID. Someone on their side joins
 * as an Admin member of THIS workspace only (full access to it); the OWNER OF RECORD (`ownerOfRecord`, also the
 * payouts and finances flag) joins as a Property owner, the existing owner role, so signing in lands them in the
 * owner portal rather than the manager portal. Either way it takes effect when they accept in their own portal;
 * their own accounts and workspaces are untouched. The invitee must already be a property-portal account, the same
 * rule every co-manager invite has.
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
    // The owner of record is the client. An operator never becomes one (it would turn their seat into an owner seat).
    if (await userHoldsAdminRole(db, target)) return fail(409, "A PropLane admin cannot be the owner of record.");
    const taken = await hasOwnerOfRecord(db, who.workspace.id);
    if (taken === null) return fail(503, "Could not send the invite. Please retry.");
    if (taken) return fail(409, "This workspace already has an owner of record.");
  }
  const audited = await auditServiceChange(db, operatorUserId, who.workspace.ownerUserId, "admin_service_team_invite", { workspaceId: who.workspace.id, inviteeUserId: target, ownerOfRecord: flag }, flag);
  if (audited) return audited;
  const added = await insertAdminMembership(db, who.workspace.ownerUserId, who.workspace.id, target, { pending: true, ownerOfRecord: flag });
  if (!added.ok) return added;
  return { ok: true, linkId: added.linkId };
}

/**
 * Mark (or unmark) the membership that is the property owner of record. At most one per workspace. Marking makes the
 * member a Property owner (owner portal); unmarking only clears the flag and leaves the role as it is.
 */
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
    .select("id, invitee_user_id, team_role, status")
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id)
    .in("status", ["accepted", "pending"])
    .maybeSingle();
  if (link.error) return fail(503, "Could not update. Please retry.");
  if (!link.data) return fail(404, "Teammate not found.");
  const target = link.data as { invitee_user_id: string; team_role: string | null; status: string };
  let patch: Record<string, unknown> = { is_owner_of_record: input.value };
  if (input.value) {
    const taken = await hasOwnerOfRecord(db, who.workspace.id, linkId);
    if (taken === null) return fail(503, "Could not update. Please retry.");
    if (taken) return fail(409, "This workspace already has an owner of record.");
    // The owner of record is a Property owner (the owner portal). An operator's seat is never converted, and a
    // member is only converted when the workspace keeps an Admin without them.
    if (target.team_role !== "property_owner") {
      if (await userHoldsAdminRole(db, target.invitee_user_id)) return fail(409, "A PropLane admin cannot be the owner of record.");
      if (target.status === "accepted") {
        const verdict = canActOnMember({
          actorRole: who.standing.role,
          targetRole: (target.team_role ?? "custom") as never,
          adminCount: await workspaceAdminCount(db, who.workspace.ownerUserId, who.workspace.id),
        });
        if (!verdict.ok) return fail(403, verdict.reason);
      }
      const houses = await db.from("manager_property_records").select("id").eq("manager_user_id", who.workspace.ownerUserId).eq("workspace_id", who.workspace.id);
      if (houses.error) return fail(503, "Could not update. Please retry.");
      const ids = ((houses.data ?? []) as { id: unknown }[]).map((h) => String(h.id));
      const map = stampTeamRoleOnProperties("property_owner", ids, {});
      patch = {
        ...patch,
        team_role: "property_owner",
        house_scope: "selected",
        assigned_property_ids: ids,
        property_co_manager_permissions: map,
        co_manager_permissions: flatTeamRoleGrant("property_owner", map) ?? {},
      };
    }
  }
  const audited = await auditServiceChange(
    db,
    operatorUserId,
    who.workspace.ownerUserId,
    "admin_service_team_owner_of_record",
    { workspaceId: who.workspace.id, linkId, inviteeUserId: target.invitee_user_id, ownerOfRecord: input.value, previousTeamRole: target.team_role },
    true,
  );
  if (audited) return audited;
  const res = await db
    .from("account_link_invites")
    .update(patch)
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
  const audited = await auditServiceChange(db, operatorUserId, who.workspace.ownerUserId, "admin_service_team_add", { workspaceId: who.workspace.id, inviteeUserId: target }, true);
  if (audited) return audited;
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
  const audited = await auditServiceChange(db, operatorUserId, who.workspace.ownerUserId, "admin_service_team_remove", { workspaceId: who.workspace.id, linkId, targetRole: targetRole, wasStatus: (link.data as { status?: string }).status }, true);
  if (audited) return audited;
  const res = await db
    .from("account_link_invites")
    .update({ status: "cancelled", responded_at: new Date().toISOString() })
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id);
  if (res.error) return fail(503, "Could not remove the teammate. Please retry.");
  return { ok: true };
}
