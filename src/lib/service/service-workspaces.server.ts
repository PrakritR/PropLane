import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listAdminUserIds, userHoldsAdminRole } from "@/lib/auth/admin-role";
import { ensureProfileProplaneId } from "@/lib/manager-access-server";
import {
  TEAM_ROLE_LABELS,
  flatTeamRoleGrant,
  parseTeamRole,
  stampTeamRoleOnProperties,
  stampTeamRolePermissions,
  type TeamRoleId,
} from "@/lib/co-manager-team-roles";
import { actorWorkspaceStanding, workspaceAdminCount, workspaceHouseIds } from "@/lib/workspaces/membership.server";
import { canActOnMember, roleAssignableBy, type HouseScope } from "@/lib/workspaces/membership";
import { finalizeInviteGrant, parseInviteAccess, restampInviteHouses, type InviteAccessInput } from "@/lib/co-manager-invite-grant";
import { capTeamInvitePermissionsForDelegate } from "@/lib/auth/co-manager-team-invite.server";
import type { CoManagerPermissions, PropertyCoManagerPermissions } from "@/lib/co-manager-permissions";
import type { WorkspaceCoManagerGrant } from "@/lib/workspace-co-manager-permissions";
import { mintInviteLink } from "@/lib/invite-links/invite-links.server";
import {
  SERVICE_INVITE_LABEL_PREFIX,
  sendServiceInviteLinkEmail,
  serviceInviteEmailFromLabel,
  serviceInviteLabel,
} from "@/lib/service/service-invite-delivery.server";
import { cleanOwnerOfRecord, cleanServiceCity, cleanServiceName } from "@/lib/service/service-input";
import { updateAuditResult, writeAuditLog } from "@/lib/tools/audit";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import { proplaneIdLookupVariants } from "@/lib/manager-id";
import { userIsPropertyPortalManager } from "@/lib/auth/co-manager-invite-eligibility.server";
import { resolveServiceLine, type ServiceLine } from "@/lib/one-number/service-line.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { releaseManagerNumber } from "@/lib/sms/manager-number-provisioning.server";
import { isPlatformServiceOwner, loadServiceWorkspace, resolveServiceOwner } from "@/lib/service/service-owner.server";
import { ensureServiceFeePolicy, setServiceManagementFee, PolicyError, type ServiceManagementFee } from "@/lib/owner-management/policies.server";
import { MANAGEMENT_FEE_RANGE_MESSAGE, feePercentForOwnerShareBps, ownerShareBpsForFeePercent } from "@/lib/owner-management/fee-percent";

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

export type ServiceFailure = {
  ok: false;
  status: number;
  error: string;
  /** A refusal the caller can act on rather than just show (the owner of record is taken: ask to replace). */
  code?: "owner_exists";
  /** For `owner_exists`: who holds it now, so the sheet can say who a replace would remove. */
  ownerName?: string;
};
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
  /**
   * The number this workspace texts from. Every row here is PropLane-managed, so it is ALWAYS the PropLane line
   * (`resolveServiceLine`, source "shared"), never a number the workspace once held; null when that line cannot be
   * resolved. "own" is kept in the type for older callers and is never produced.
   */
  workNumber: string | null;
  workNumberSource: "own" | "shared" | null;
  /**
   * The number the workspace held before it went on the PropLane line, while it is still kept (receive-only: a text to it
   * still lands in the workspace, the reply leaves from the PropLane line). `since` is when the workspace was attached, null
   * when that cannot be read. Released by the "Release old number" action; no automatic release.
   */
  oldNumber: { phoneNumber: string; since: string | null } | null;
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
 * No number is provisioned, reserved or exempted for a service workspace, and it never has a personalized one: a
 * PropLane-MANAGED workspace texts on the PropLane line in both modes (W29), so the number shown is `resolveServiceLine`'s
 * answer and nothing else. A line that cannot be resolved or read shows no number (never the workspace's old one).
 */
function resolveTextingNumber(line: ServiceLine): { workNumber: string | null; workNumberSource: "own" | "shared" | null } {
  return line.ok ? { workNumber: line.phoneNumber, workNumberSource: "shared" } : { workNumber: null, workNumberSource: null };
}

/**
 * The old number a managed workspace still holds: its live own row whose number is not the PropLane line. Without a
 * resolved line nothing can be told apart from the line, so nothing is reported (and nothing can be released).
 */
function oldNumberRow(rows: Record<string, unknown>[], workspaceId: string, line: ServiceLine): Record<string, unknown> | null {
  if (!line.ok) return null;
  return (
    rows.find(
      (n) =>
        n.workspace_id === workspaceId &&
        !n.released_at &&
        normalizeE164(String(n.phone_number ?? "")) &&
        normalizeE164(String(n.phone_number ?? "")) !== line.phoneNumber,
    ) ?? null
  );
}

/** When each workspace was attached (the attach audit row), best effort: an unreadable trail just leaves `since` null. */
async function attachedAtByWorkspace(db: SupabaseClient, workspaceIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    if (workspaceIds.length === 0) return out;
    // Narrowed to the workspaces being listed: every attach ever made is otherwise read and thrown away on
    // each Admin > Service render, to put one date on each row.
    const { data, error } = await db
      .from("audit_log")
      .select("created_at, input_summary")
      .eq("action", ADMIN_SERVICE_ATTACH_AUDIT_ACTION)
      .in("input_summary->>workspaceId", workspaceIds);
    if (error) return out;
    for (const row of (data ?? []) as { created_at?: unknown; input_summary?: { workspaceId?: unknown } | null }[]) {
      const id = String(row.input_summary?.workspaceId ?? "");
      const at = typeof row.created_at === "string" ? row.created_at : "";
      if (!at || !workspaceIds.includes(id)) continue;
      const prev = out.get(id);
      if (!prev || at < prev) out.set(id, at);
    }
  } catch {
    /* best effort */
  }
  return out;
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

  const [houses, numbers, links, serviceLine, feePercents, attachedAt] = await Promise.all([
    db.from("manager_property_records").select("id, workspace_id, manager_user_id").in("workspace_id", ids),
    db.from("manager_sms_numbers").select("workspace_id, phone_number, provision_state, released_at, requested_at").in("workspace_id", ids),
    db
      .from("account_link_invites")
      .select("id, workspace_id, inviter_user_id, invitee_user_id, team_role, status, is_owner_of_record, invitee_display_name")
      .in("workspace_id", ids)
      .in("status", ["accepted", "pending"]),
    resolveServiceLine(db),
    serviceFeePercents(db, ids),
    attachedAtByWorkspace(db, ids),
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
    const old = oldNumberRow((numbers.data ?? []) as Record<string, unknown>[], row.id, serviceLine);
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
      ...resolveTextingNumber(serviceLine),
      oldNumber: old
        ? { phoneNumber: String(old.phone_number), since: attachedAt.get(row.id) ?? (typeof old.requested_at === "string" ? old.requested_at : null) }
        : null,
      teamCount: members.filter((l) => l.status === "accepted").length,
      viewerRole: myRole,
      canManage: myRole === "owner" || myRole === "admin" || myRole === "full",
      feePercent: feePercents.get(row.id) ?? null,
    };
  });
  return { ok: true, payload: { configured, ownerUserId, workspaces: out } };
}

/**
 * Add a membership of `workspaceId` for `userId`, under the workspace's owner: Admin, or Property owner for
 * the owner of record. Every seat written here is stamped `is_service_seat` (bar the owner-of-record one):
 * it is the one path PropLane seats service staff through.
 */
/** What a service seat carries beyond "Admin on every house": the role, the reach and the module grants. */
export type ServiceSeatGrant = {
  teamRole: TeamRoleId;
  houseScope: HouseScope;
  assignedPropertyIds: string[];
  propertyCoManagerPermissions: PropertyCoManagerPermissions;
  coManagerPermissions: CoManagerPermissions;
  workspacePermissions: WorkspaceCoManagerGrant;
};

async function insertAdminMembership(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string,
  userId: string,
  opts: { pending?: boolean; ownerOfRecord?: boolean; grant?: ServiceSeatGrant } = {},
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
  // An explicit grant (the Invite sheet's role, houses and module levels) replaces the Admin default for a teammate.
  // The owner of record keeps the owner shape above whatever was asked: the role is not a choice there.
  const grant = asOwner ? undefined : opts.grant;
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
      assigned_property_ids: grant ? grant.assignedPropertyIds : ownerHouseIds,
      payout_percent_for_manager: 0,
      property_co_manager_permissions: grant ? grant.propertyCoManagerPermissions : ownerHouseMap,
      co_manager_permissions: grant ? grant.coManagerPermissions : stamp,
      workspace_id: workspaceId,
      workspace_permissions: grant ? grant.workspacePermissions : {},
      team_role: grant ? grant.teamRole : asOwner ? "property_owner" : "admin",
      house_scope: grant ? grant.houseScope : asOwner ? "selected" : "all",
      invited_via: "code",
      invited_at: now,
      responded_at: opts.pending ? null : now,
      status: opts.pending ? "pending" : "accepted",
      is_owner_of_record: opts.ownerOfRecord === true,
      // Provenance: PropLane issued this seat (create / attach / team-invite), which is what makes its
      // holder service STAFF even on an attached workspace the client still owns. The client's own
      // co-manager invites never come through here, so they are never marked.
      is_service_seat: !asOwner,
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
  input: { name: unknown; city: unknown; ownerOfRecord?: unknown; ownerContact?: unknown },
): Promise<ServiceResult<{ id: string; ownerInvite: { sent: boolean; delivery?: "account" | "link"; error?: string } | null }>> {
  const name = cleanServiceName(input.name);
  if (!name) return fail(400, "Use a workspace name of 1 to 80 characters.");
  const city = cleanServiceCity(input.city);
  if (city === undefined) return fail(400, "Use a city of up to 80 characters.");
  const client = cleanOwnerOfRecord(input.ownerOfRecord);
  if (client === undefined) return fail(400, "Use an owner name of up to 80 characters.");
  // The owner's email or PropLane ID is optional: blank sends nothing (invite the owner later from Team). It is
  // validated BEFORE anything is created, so a typo does not leave a workspace behind.
  const contactRaw = typeof input.ownerContact === "string" ? input.ownerContact.trim() : input.ownerContact === undefined || input.ownerContact === null ? "" : null;
  if (contactRaw === null || contactRaw.length > 120) return fail(400, "Enter the owner's email or PropLane ID.");
  if (contactRaw.includes("@") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactRaw)) return fail(400, "Enter a valid email address.");
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
  // The owner invite: the same server function the Team sheet's Owner role uses. A workspace that was created stays
  // created whatever happens to the invite; the result says whether it went so the pop-up can say so.
  let ownerInvite: { sent: boolean; delivery?: "account" | "link"; error?: string } | null = null;
  if (contactRaw) {
    const invited = await inviteServiceClient(db, operatorUserId, {
      id,
      ownerOfRecord: true,
      inviteeName: client ?? undefined,
      ...(contactRaw.includes("@") ? { email: contactRaw } : { proplaneId: contactRaw }),
    });
    ownerInvite = invited.ok ? { sent: true, delivery: invited.delivery } : { sent: false, error: invited.error };
  }
  return { ok: true, id, ownerInvite };
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
 * Admin > Service > Management fee: the percent PropLane keeps of a service workspace's rent. The range and the parse are
 * `ownerShareBpsForFeePercent`'s single answer, surfaced by `setServiceManagementFee`, which activates the new rate at once
 * so it applies to every payment settled from that moment on. The operator must be a platform admin and the workspace must
 * carry the service flag; the audit row is written before the change, so no audit row means no change.
 */
export async function setServiceWorkspaceFee(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string; percent: unknown },
): Promise<ServiceResult<ServiceManagementFee>> {
  if (!(await userHoldsAdminRole(db, operatorUserId))) return fail(403, "Only a PropLane admin can change the management fee.");
  const workspace = await loadServiceWorkspace(db, input.id);
  if (!workspace) return fail(404, "Service workspace not found.");
  const ownerShareBps = ownerShareBpsForFeePercent(input.percent);
  if (ownerShareBps === null) return fail(400, MANAGEMENT_FEE_RANGE_MESSAGE);
  const percent = feePercentForOwnerShareBps(ownerShareBps);
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
  let fee: ServiceManagementFee;
  try {
    fee = await setServiceManagementFee(db, { role: "admin", userId: operatorUserId }, workspace.id, percent);
  } catch (e) {
    await updateAuditResult(actor, auditKey, { applied: false, error: "refused" });
    if (e instanceof PolicyError) return fail(e.status, e.message);
    return fail(503, "Could not change the management fee. Please retry.");
  }
  await updateAuditResult(actor, auditKey, { applied: fee.changed, policyId: fee.policyId });
  return { ok: true, ...fee };
}

/** The percent PropLane keeps for each service workspace right now (absent: no policy in force yet). Never throws. */
export async function serviceFeePercents(db: SupabaseClient, workspaceIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (workspaceIds.length === 0) return out;
  const { data, error } = await db
    .from("managed_workspace_fee_policies")
    .select("workspace_id, owner_share_bps")
    .in("workspace_id", workspaceIds)
    .eq("status", "active");
  if (error) return out;
  for (const r of (data ?? []) as { workspace_id: string; owner_share_bps: number }[]) {
    out.set(String(r.workspace_id), feePercentForOwnerShareBps(Number(r.owner_share_bps)));
  }
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
/**
 * `opts.overall` is the Admin team's verdict, derived by its routes from the Overall admin role (never from a body): an
 * Overall admin stands as the owner of every PropLane Service workspace for team changes, member or not. Left out, the
 * operator must hold a seat in the workspace, exactly as before.
 */
export type OperatorOpts = { overall?: boolean };

async function operatorStanding(db: SupabaseClient, operatorUserId: string, workspaceId: string, opts: OperatorOpts = {}) {
  const workspace = await loadServiceWorkspace(db, workspaceId);
  if (!workspace) return fail(404, NOT_FOUND);
  if (opts.overall === true) {
    const standing = {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      ownerUserId: workspace.ownerUserId,
      role: "owner" as const,
      rights: { members: true, houses: true },
      linkId: null,
    };
    return { ok: true as const, workspace, standing };
  }
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

export const ADMIN_SERVICE_RELEASE_OLD_NUMBER_AUDIT_ACTION = "admin_service_release_old_number";

/**
 * Admin > Service > Release old number. A managed workspace keeps the number it held before it went on the PropLane line
 * receive-only (inbound still lands in the workspace, replies leave from the PropLane line); this releases it, on the
 * operator's say-so only (no timer). Platform admin only, re-derived here; the audit row is written BEFORE the release and
 * a missing row means nothing changes; the PropLane line itself is never released (a workspace that holds the line, as the
 * service owner's default does, refuses). The state flips in our database; handing the number back to the carrier stays
 * an operator step. Verified after: a release that did not take reports 503.
 */
export async function releaseServiceWorkspaceOldNumber(
  db: SupabaseClient,
  operatorUserId: string,
  input: { id: string },
): Promise<ServiceResult<{ released: string }>> {
  if (!(await userHoldsAdminRole(db, operatorUserId))) return fail(403, "Only a PropLane admin can release a workspace's old number.");
  const workspace = await loadServiceWorkspace(db, input.id);
  if (!workspace) return fail(404, NOT_FOUND);
  const line = await resolveServiceLine(db);
  if (!line.ok) return fail(503, "Could not resolve the PropLane line, so nothing was released. Please retry.");
  const held = await db
    .from("manager_sms_numbers")
    .select("manager_user_id, workspace_id, phone_number, released_at")
    .eq("workspace_id", workspace.id)
    .is("released_at", null);
  if (held.error) return fail(503, "Could not read the workspace's numbers. Please retry.");
  const live = ((held.data ?? []) as Record<string, unknown>[]).filter((r) => normalizeE164(String(r.phone_number ?? "")));
  if (live.some((r) => normalizeE164(String(r.phone_number)) === line.phoneNumber)) {
    return fail(409, "This workspace holds the PropLane line itself, so there is no old number to release.");
  }
  const old = live[0];
  if (!old) return fail(409, "This workspace has no old number to release.");
  const managerIds = [...new Set(live.map((r) => String(r.manager_user_id ?? "").trim()).filter(Boolean))];
  if (managerIds.length === 0) return fail(409, "This workspace has no old number to release.");

  const audited = await auditServiceChange(
    db,
    operatorUserId,
    workspace.ownerUserId,
    ADMIN_SERVICE_RELEASE_OLD_NUMBER_AUDIT_ACTION,
    { workspaceId: workspace.id, phoneNumbers: live.map((r) => String(r.phone_number)) },
    true,
  );
  if (audited) return audited;

  for (const managerId of managerIds) await releaseManagerNumber(db, managerId, workspace.id);
  const after = await db.from("manager_sms_numbers").select("phone_number").eq("workspace_id", workspace.id).is("released_at", null);
  if (after.error || ((after.data ?? []) as Record<string, unknown>[]).some((r) => normalizeE164(String(r.phone_number ?? "")) !== line.phoneNumber && normalizeE164(String(r.phone_number ?? "")))) {
    return fail(503, "Could not release the old number. Please retry.");
  }
  return { ok: true, released: String(old.phone_number) };
}

export type { ServiceTeamMember } from "@/lib/service/service-team-types";
import type { ServiceTeamMember } from "@/lib/service/service-team-types";
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
    .select(
      "id, invitee_user_id, team_role, status, is_owner_of_record, invitee_display_name, house_scope, assigned_property_ids, property_co_manager_permissions, co_manager_permissions, workspace_permissions",
    )
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id)
    .not("invitee_user_id", "is", null)
    .in("status", ["accepted", "pending"]);
  if (links.error) return fail(503, "Could not load the team. Please retry.");
  const linkRows = (links.data ?? []) as {
    id: string;
    invitee_user_id: string;
    team_role: string | null;
    status: "accepted" | "pending";
    is_owner_of_record: boolean | null;
    invitee_display_name: string | null;
    house_scope?: string | null;
    assigned_property_ids?: string[] | null;
    property_co_manager_permissions?: PropertyCoManagerPermissions | null;
    co_manager_permissions?: CoManagerPermissions | null;
    workspace_permissions?: WorkspaceCoManagerGrant | null;
  }[];
  const pendingLinks = await liveServiceInviteLinks(db, who.workspace);
  if (!pendingLinks.ok) return pendingLinks;
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
  const accountMembers: ServiceTeamMember[] = linkRows.map((l) => ({
    linkId: l.id,
    userId: l.invitee_user_id,
    // A pending invitee is shown by the name snapshot taken when the invite was written, never their live profile.
    ...(l.status === "pending" ? { name: l.invitee_display_name?.trim() || "Invited", email: "" } : label(l.invitee_user_id)),
    role: l.team_role ?? "custom",
    status: l.status,
    ownerOfRecord: l.is_owner_of_record === true,
    delivery: "account",
    houseScope: l.house_scope === "selected" ? "selected" : "all",
    assignedPropertyIds: Array.isArray(l.assigned_property_ids) ? l.assigned_property_ids.map(String) : [],
    propertyCoManagerPermissions: l.property_co_manager_permissions ?? {},
    coManagerPermissions: l.co_manager_permissions ?? {},
    workspacePermissions: l.workspace_permissions ?? {},
  }));
  const linkMembers: ServiceTeamMember[] = pendingLinks.links.map((l) => ({
    linkId: l.id,
    userId: "",
    name: l.email,
    email: l.email,
    role: l.teamRole ?? "custom",
    status: "pending",
    // An unspent owner link is the pending owner of record: the Team list shows "Invited · Owner".
    ownerOfRecord: l.teamRole === "property_owner",
    delivery: "link",
  }));
  return {
    ok: true,
    canManage,
    members: [...accountMembers, ...linkMembers],
    candidates: canManage
      ? adminIds.filter((id) => id !== who.workspace.ownerUserId && !memberIds.has(id)).map((id) => ({ userId: id, ...label(id) }))
      : [],
  };
}

/** The current owner of record of a workspace: the attached client who owns it, a flagged member, or an unspent owner link. */
type OwnerOfRecordHolder =
  | { kind: "none" }
  | { kind: "account"; name: string }
  | { kind: "member"; linkId: string; name: string; status: string }
  | { kind: "link"; linkId: string; name: string };

/** The holder a replace withdraws: never "none", never the attached client who owns the workspace. */
type OutgoingOwner = Exclude<OwnerOfRecordHolder, { kind: "none" } | { kind: "account" }>;

async function currentOwnerOfRecord(db: SupabaseClient, workspace: { id: string; ownerUserId: string }): Promise<OwnerOfRecordHolder | null> {
  const [members, links, serviceOwned] = await Promise.all([
    db
      .from("account_link_invites")
      .select("id, invitee_user_id, invitee_display_name, status")
      .eq("workspace_id", workspace.id)
      .eq("is_owner_of_record", true)
      .in("status", ["accepted", "pending"]),
    // Only a live Admin › Service invite holds the slot. An ordinary owner share link cannot create an owner of record
    // (`redeemInviteLink` refuses an unbound one), so it must not stand in the real owner's way either — and the one
    // query that decides what "a live service invite" is stays `liveServiceInviteLinks`.
    liveServiceInviteLinks(db, workspace),
    isPlatformServiceOwner(db, workspace.ownerUserId),
  ]);
  if (members.error || !links.ok) return null;
  // The owner of an attached CLIENT workspace IS its owner of record; nobody else can be, and nobody can replace them.
  if (!serviceOwned) {
    const owner = await db.from("profiles").select("full_name, email").eq("id", workspace.ownerUserId).maybeSingle();
    const profile = owner.data as { full_name?: string | null; email?: string | null } | null;
    return { kind: "account", name: profile?.full_name?.trim() || profile?.email?.trim() || "The workspace owner" };
  }
  const flagged = ((members.data ?? []) as { id: string; invitee_user_id: string | null; invitee_display_name: string | null; status: string }[])[0];
  if (flagged) {
    let name = flagged.invitee_display_name?.trim() || "";
    if (flagged.status === "accepted" && flagged.invitee_user_id) {
      const profile = await db.from("profiles").select("full_name, email").eq("id", flagged.invitee_user_id).maybeSingle();
      const p = profile.data as { full_name?: string | null; email?: string | null } | null;
      name = p?.full_name?.trim() || p?.email?.trim() || name;
    }
    return { kind: "member", linkId: flagged.id, name: name || "The owner", status: flagged.status };
  }
  const live = links.links.find((l) => l.teamRole === "property_owner");
  if (live) return { kind: "link", linkId: live.id, name: live.email || "The owner" };
  return { kind: "none" };
}

/** The email/PropLane ID a service invite names, normalised; or the refusal to return. */
function parseServiceInviteTarget(input: { proplaneId?: unknown; email?: unknown }): { ok: true; rawEmail: string; raw: string } | ServiceFailure {
  const rawId = typeof input.proplaneId === "string" ? input.proplaneId.trim() : "";
  const rawEmail = typeof input.email === "string" ? input.email.trim() : "";
  // A helper is named by email or by PropLane ID; the Team pane's one box sends whichever was typed.
  if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) return fail(400, "Enter a valid email address.");
  const raw = rawEmail || rawId;
  if (!raw || raw.length > 120) return fail(400, "Enter the email or PropLane ID of the person to invite.");
  return { ok: true, rawEmail, raw };
}

/**
 * Turn a request's role, reach and module levels into the grant a service seat stores, re-deriving every part of it
 * server-side with the SAME validators `POST /api/pro/account-links` uses (`co-manager-invite-grant.ts`): the role is
 * parsed from the allow-list, "all houses" resolves to THIS workspace's houses, an explicit house must belong to this
 * workspace, a role above the operator's own is refused, and the operator can hand out no more module access than
 * they hold. Nothing here trusts a body id or a body role beyond that parse.
 */
async function resolveServiceSeatGrant(
  db: SupabaseClient,
  who: { workspace: { id: string; ownerUserId: string }; standing: { role: Parameters<typeof roleAssignableBy>[0] } },
  operatorUserId: string,
  body: InviteAccessInput,
): Promise<ServiceFailure | { ok: true; grant: ServiceSeatGrant }> {
  // A bare "email or PropLane ID" invite (no role, no houses) is the original service invite: Admin, every house.
  const parsed = parseInviteAccess({ ...body, teamRole: body.teamRole ?? "admin", houseScope: body.houseScope ?? "all" });
  if (!parsed.ok) return fail(400, parsed.error);
  const { teamRole, houseScope } = parsed.access;
  if (teamRole === "property_owner") return fail(400, "Invite the owner as Owner, not as a team role.");
  if (!roleAssignableBy(who.standing.role, teamRole)) return fail(403, "You cannot hand out a role above your own.");
  const houses = await workspaceHouseIds(db, who.workspace.ownerUserId, who.workspace.id);
  let assignedPropertyIds = parsed.access.assignedPropertyIds;
  if (houseScope === "all") {
    assignedPropertyIds = houses;
  } else {
    const inWorkspace = new Set(houses);
    assignedPropertyIds = [...new Set(assignedPropertyIds)];
    if (assignedPropertyIds.some((id) => !inWorkspace.has(id))) return fail(400, "Choose houses from this workspace only.");
    if (assignedPropertyIds.length === 0) return fail(400, "Choose at least one house, or all houses.");
  }
  let propertyMap = restampInviteHouses(body, teamRole, assignedPropertyIds, parsed.access.propertyCoManagerPermissions);
  if (operatorUserId.trim() !== who.workspace.ownerUserId.trim() && who.standing.role !== "owner") {
    const capped = await capTeamInvitePermissionsForDelegate(db, operatorUserId, who.workspace.ownerUserId, assignedPropertyIds, propertyMap);
    if (!capped.ok) return fail(capped.status, capped.error);
    propertyMap = capped.permissions;
  }
  const final = finalizeInviteGrant(body, {
    teamRole,
    propertyCoManagerPermissions: propertyMap,
    workspaceHasHouses: houses.length > 0,
  });
  return {
    ok: true,
    grant: {
      teamRole: final.teamRole,
      houseScope,
      assignedPropertyIds,
      propertyCoManagerPermissions: final.propertyCoManagerPermissions,
      coManagerPermissions: final.coManagerPermissions,
      workspacePermissions: final.workspacePermissions,
    },
  };
}

export type ServiceInviteInput = InviteAccessInput & {
  id: string;
  proplaneId?: unknown;
  email?: unknown;
  /** True invites the OWNER of record (role Owner). A body flag is a request, never a grant: the route is admin-only. */
  ownerOfRecord?: unknown;
  /** The owner of record is taken and the operator confirmed replacing them. */
  replaceOwner?: unknown;
  /** The name typed beside the email, for the greeting of an email to someone with no account yet. Never a grant. */
  inviteeName?: unknown;
};

/**
 * Invite a person to a PropLane Service workspace by email or PropLane ID, with the role, houses and module levels the
 * Invite sheet chose. A teammate joins THIS workspace only, as a PropLane-issued seat (`is_service_seat`); the OWNER
 * of record (`ownerOfRecord`, role Owner) joins as a Property owner, read-only, and there is one per workspace (a
 * second asks to replace: `owner_exists`, then `replaceOwner: true`).
 *
 * Someone who already has a property-portal account gets a pending membership (email, inbox, and a text to a verified
 * phone, the same notice a co-manager invite sends) they accept in their own portal. Someone with NO account yet gets
 * a one-use invite link by email: they create their account on the invite page and the redeem writes the seat. The
 * caller proved the operator is a platform admin; this re-derives what the operator is inside the workspace.
 */
export async function inviteServiceClient(
  db: SupabaseClient,
  operatorUserId: string,
  input: ServiceInviteInput,
): Promise<ServiceResult<{ linkId: string; delivery: "account" | "link"; ownerReplaced: boolean }>> {
  const target = parseServiceInviteTarget(input);
  if (!target.ok) return target;
  const { rawEmail, raw } = target;
  const who = await operatorStanding(db, operatorUserId, input.id);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can invite people.");
  const flag = input.ownerOfRecord === true;

  // The seat the invite will carry. An owner is fixed (Property owner, every house); a teammate is validated.
  let grant: ServiceSeatGrant | undefined;
  if (!flag) {
    const resolved = await resolveServiceSeatGrant(db, who, operatorUserId, input);
    if (!resolved.ok) return resolved;
    grant = resolved.grant;
  }

  const lookup = rawEmail
    ? db.from("profiles").select("id, email, full_name").in("email", [...new Set([rawEmail, rawEmail.toLowerCase()])]).limit(1).maybeSingle()
    : db
        .from("profiles")
        .select("id, email, full_name")
        .in("manager_id", (() => {
          const variants = proplaneIdLookupVariants(raw);
          return variants.length ? variants : [raw];
        })())
        .limit(1)
        .maybeSingle();
  const profile = await lookup;
  if (profile.error) return fail(503, "Could not look up that person. Please retry.");
  const targetUserId = String((profile.data as { id?: unknown } | null)?.id ?? "");
  const targetName = String((profile.data as { full_name?: unknown } | null)?.full_name ?? "").trim();
  if (!targetUserId && !rawEmail) return fail(404, "No account found with this PropLane ID.");
  if (targetUserId) {
    if (targetUserId === who.workspace.ownerUserId) return fail(409, "That account already owns this workspace.");
    if (flag && (await userHoldsAdminRole(db, targetUserId))) return fail(409, "A PropLane admin cannot be the owner of record.");
  }
  // An account that exists but has no property portal cannot hold a teammate seat; an owner can still be invited,
  // because the invite page gives an owner a property-portal account when they accept.
  const addressed = Boolean(targetUserId) && (await userIsPropertyPortalManager(db, targetUserId));
  if (targetUserId && !addressed && !flag) return fail(400, "That account needs a property portal to join this workspace.");
  if (addressed) {
    const ownerProfile = await db.from("profiles").select("email").eq("id", who.workspace.ownerUserId).maybeSingle();
    if (isCrossSandboxPortalPair(String((ownerProfile.data as { email?: string } | null)?.email ?? ""), String((profile.data as { email?: string }).email ?? ""))) {
      return fail(400, "That account cannot join this workspace.");
    }
    const existing = await db
      .from("account_link_invites")
      .select("id")
      .eq("inviter_user_id", who.workspace.ownerUserId)
      .eq("invitee_user_id", targetUserId)
      .eq("workspace_id", who.workspace.id)
      .in("status", ["accepted", "pending"])
      .maybeSingle();
    if (existing.error) return fail(503, "Could not send the invite. Please retry.");
    if (existing.data) return fail(409, "Already on this workspace's team, or invited.");
  }

  // One owner of record per workspace. Taken: ask (owner_exists) unless the operator already confirmed the replace.
  // The withdrawal is sequenced so a failed invite never leaves the workspace with NO owner of record: an emailed
  // link is minted and sent first and the old holder withdrawn after, and a membership (which the database allows
  // only one live row of) withdraws first and is put back when the insert fails.
  let outgoingOwner: OutgoingOwner | null = null;
  if (flag) {
    const holder = await currentOwnerOfRecord(db, who.workspace);
    if (holder === null) return fail(503, "Could not send the invite. Please retry.");
    if (holder.kind === "account") return fail(409, "The workspace's own owner is its owner of record.");
    if (holder.kind !== "none") {
      if (input.replaceOwner !== true) {
        return { ok: false, status: 409, error: `${holder.name} is the owner now. Replace them?`, code: "owner_exists", ownerName: holder.name };
      }
      outgoingOwner = holder;
    }
  }

  const audited = await auditServiceChange(
    db,
    operatorUserId,
    who.workspace.ownerUserId,
    "admin_service_team_invite",
    {
      workspaceId: who.workspace.id,
      inviteeUserId: targetUserId || null,
      inviteeEmail: targetUserId ? undefined : rawEmail.toLowerCase(),
      ownerOfRecord: flag,
      teamRole: flag ? "property_owner" : grant?.teamRole,
      houseScope: flag ? "selected" : grant?.houseScope,
      houseCount: flag ? undefined : grant?.assignedPropertyIds.length,
      delivery: addressed ? "account" : "link",
    },
    true,
  );
  if (audited) return audited;

  if (addressed) {
    // `account_link_invites_one_owner_of_record` allows one live owner row per workspace, so the seat has to be
    // free before the replacement is inserted. A failed insert puts the previous holder back.
    const withdrawn = await withdrawOutgoingOwner(db, operatorUserId, who.workspace, outgoingOwner);
    if (!withdrawn.ok) return withdrawn;
    const added = await insertAdminMembership(db, who.workspace.ownerUserId, who.workspace.id, targetUserId, {
      pending: true,
      ownerOfRecord: flag,
      grant,
    });
    if (!added.ok) {
      await restoreOutgoingOwner(db, who.workspace, outgoingOwner);
      return added;
    }
    void notifyServiceInviteSent(db, { operatorUserId, inviteeUserId: targetUserId, inviteId: added.linkId, workspace: who.workspace, ownerInvite: flag });
    return { ok: true, linkId: added.linkId, delivery: "account", ownerReplaced: withdrawn.ownerReplaced };
  }

  // No account yet: a one-use link, emailed. The email is the only way to know who it is for, so it is required.
  if (!rawEmail) return fail(400, "Enter an email address for someone without an account.");
  const hintedName = cleanOwnerOfRecord(input.inviteeName);
  const sent = await inviteByLink(db, operatorUserId, who.workspace, {
    email: rawEmail,
    name: targetName || (hintedName ?? ""),
    ownerInvite: flag,
    grant,
  });
  if (!sent.ok) return sent;
  const withdrawn = await withdrawOutgoingOwner(db, operatorUserId, who.workspace, outgoingOwner);
  if (!withdrawn.ok) {
    // The invite is out and the old holder is still on: two owners, not none. Say which half happened.
    return fail(withdrawn.status, `The invite was sent, but ${outgoingOwner!.name} is still the owner. Remove them from the team list.`);
  }
  return { ...sent, ownerReplaced: withdrawn.ownerReplaced };
}

/** Withdraw the owner of record the new invite replaces, if there is one. */
async function withdrawOutgoingOwner(
  db: SupabaseClient,
  operatorUserId: string,
  workspace: { id: string; ownerUserId: string },
  outgoing: OutgoingOwner | null,
): Promise<ServiceFailure | { ok: true; ownerReplaced: boolean }> {
  if (!outgoing) return { ok: true, ownerReplaced: false };
  const replaced = await replaceOwnerOfRecord(db, operatorUserId, workspace, outgoing);
  if (replaced) return replaced;
  return { ok: true, ownerReplaced: true };
}

/**
 * Put the withdrawn holder back when the replacement could not be written, so the workspace is never left without an
 * owner of record. Best effort: the caller is already returning the original failure, and a restore that itself fails
 * leaves the seat free rather than hiding the first error.
 */
async function restoreOutgoingOwner(
  db: SupabaseClient,
  workspace: { id: string; ownerUserId: string },
  outgoing: OutgoingOwner | null,
): Promise<void> {
  if (!outgoing) return;
  try {
    if (outgoing.kind === "member") {
      await db
        .from("account_link_invites")
        .update({ status: outgoing.status, responded_at: outgoing.status === "accepted" ? new Date().toISOString() : null })
        .eq("id", outgoing.linkId)
        .eq("inviter_user_id", workspace.ownerUserId)
        .eq("workspace_id", workspace.id);
      return;
    }
    await db
      .from("manager_invite_links")
      .update({ revoked_at: null, updated_at: new Date().toISOString() })
      .eq("id", outgoing.linkId)
      .eq("owner_user_id", workspace.ownerUserId)
      .eq("workspace_id", workspace.id);
  } catch (error) {
    console.error("[service-workspaces] owner of record could not be restored", error instanceof Error ? error.name : "unknown");
  }
}

/** Withdraw whoever holds the owner of record seat now: their membership (cancelled, audited) or their unspent link. */
async function replaceOwnerOfRecord(
  db: SupabaseClient,
  operatorUserId: string,
  workspace: { id: string; ownerUserId: string },
  holder: Exclude<OwnerOfRecordHolder, { kind: "none" } | { kind: "account" }>,
): Promise<ServiceFailure | null> {
  const audited = await auditServiceChange(
    db,
    operatorUserId,
    workspace.ownerUserId,
    "admin_service_owner_replaced",
    { workspaceId: workspace.id, replaced: holder.kind, replacedLinkId: holder.linkId },
    true,
  );
  if (audited) return audited;
  if (holder.kind === "member") {
    const res = await db
      .from("account_link_invites")
      .update({ status: "cancelled", responded_at: new Date().toISOString() })
      .eq("id", holder.linkId)
      .eq("inviter_user_id", workspace.ownerUserId)
      .eq("workspace_id", workspace.id);
    if (res.error) return fail(503, "Could not replace the owner. Please retry.");
    return null;
  }
  const res = await db
    .from("manager_invite_links")
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", holder.linkId)
    .eq("owner_user_id", workspace.ownerUserId)
    .eq("workspace_id", workspace.id);
  if (res.error) return fail(503, "Could not replace the owner. Please retry.");
  return null;
}

/** The invite notice for an account that exists: email + inbox, and a text when their phone is verified. Never throws. */
async function notifyServiceInviteSent(
  db: SupabaseClient,
  input: { operatorUserId: string; inviteeUserId: string; inviteId: string; workspace: { id: string; ownerUserId: string }; ownerInvite: boolean },
): Promise<void> {
  try {
    const [workspaceRow, inviter] = await Promise.all([
      db.from("portal_workspaces").select("name").eq("id", input.workspace.id).maybeSingle(),
      db.from("profiles").select("full_name, email").eq("id", input.operatorUserId).maybeSingle(),
    ]);
    const inviterProfile = inviter.data as { full_name?: string | null; email?: string | null } | null;
    const { notifyCoManagerInviteSent } = await import("@/lib/co-manager-notification.server");
    await notifyCoManagerInviteSent({
      // The notice (and any text) leaves under the workspace's owner, like every other member notice of the workspace.
      inviterUserId: input.workspace.ownerUserId,
      inviteeUserId: input.inviteeUserId,
      inviterName: inviterProfile?.full_name?.trim() || inviterProfile?.email?.trim() || "PropLane",
      propertyLabels: [],
      inviteId: input.inviteId,
      workspaceName: String((workspaceRow.data as { name?: unknown } | null)?.name ?? "").trim() || undefined,
      ownerInvite: input.ownerInvite,
    });
  } catch (error) {
    console.error("[service-workspaces] invite notification failed", error instanceof Error ? error.name : "unknown");
  }
}

async function inviteByLink(
  db: SupabaseClient,
  operatorUserId: string,
  workspace: { id: string; ownerUserId: string },
  input: { email: string; name: string; ownerInvite: boolean; grant: ServiceSeatGrant | undefined },
): Promise<ServiceResult<{ linkId: string; delivery: "account" | "link" }>> {
  const email = input.email.trim().toLowerCase();
  // One live service invite per email per workspace.
  const live = await liveServiceInviteLinks(db, workspace);
  if (!live.ok) return live;
  if (live.links.some((l) => l.email === email)) return fail(409, "Already on this workspace's team, or invited.");
  const workspaceRow = await db.from("portal_workspaces").select("name").eq("id", workspace.id).maybeSingle();
  const workspaceName = String((workspaceRow.data as { name?: unknown } | null)?.name ?? "").trim();
  const houseIds = input.ownerInvite ? await workspaceHouseIds(db, workspace.ownerUserId, workspace.id) : input.grant!.assignedPropertyIds;
  const role: TeamRoleId = input.ownerInvite ? "property_owner" : input.grant!.teamRole;
  const minted = await mintInviteLink(db, {
    actorUserId: operatorUserId,
    kind: "manager",
    label: serviceInviteLabel(email),
    workspaceId: workspace.id,
    assignedPropertyIds: houseIds,
    propertyPermissions: input.ownerInvite ? stampTeamRoleOnProperties("property_owner", houseIds, {}) : input.grant!.propertyCoManagerPermissions,
    teamRole: role,
    houseScope: input.ownerInvite ? "selected" : input.grant!.houseScope,
    workspacePermissions: input.ownerInvite ? {} : input.grant!.workspacePermissions,
    usesOption: "1",
    expiryOption: "30d",
    serviceInvite: true,
    inviteeEmail: email,
  });
  if (!minted.ok) return fail(minted.status >= 500 ? 503 : minted.status, minted.error);
  const sent = await sendServiceInviteLinkEmail({
    operatorUserId,
    to: email,
    token: minted.token,
    workspaceName,
    ownerInvite: input.ownerInvite,
    ownerName: input.name || null,
    roleLabel: input.ownerInvite ? "Owner" : (TEAM_ROLE_LABELS[role === "full" ? "admin" : role] ?? "Teammate"),
  });
  if (!sent.ok) {
    // An invite nobody was told about must not sit live: turn the link off and say so.
    await db
      .from("manager_invite_links")
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", minted.link.id)
      .eq("owner_user_id", workspace.ownerUserId);
    return fail(502, `The invite could not be emailed: ${sent.error}`);
  }
  return { ok: true, linkId: minted.link.id, delivery: "link" };
}

type LiveServiceInviteLink = { id: string; email: string; teamRole: string | null; expiresAt: string | null };

/** Service invite links nobody has used yet (the people invited by email who have no account), newest first. */
async function liveServiceInviteLinks(
  db: SupabaseClient,
  workspace: { id: string; ownerUserId: string },
): Promise<ServiceFailure | { ok: true; links: LiveServiceInviteLink[] }> {
  const res = await db
    .from("manager_invite_links")
    .select("id, label, team_role, max_uses, used_count, expires_at")
    .eq("owner_user_id", workspace.ownerUserId)
    .eq("workspace_id", workspace.id)
    .eq("kind", "manager")
    .is("revoked_at", null)
    .like("label", `${SERVICE_INVITE_LABEL_PREFIX}%`)
    .order("created_at", { ascending: false })
    .limit(50);
  if (res.error) return fail(503, "Could not load the team. Please retry.");
  const now = new Date();
  const links: LiveServiceInviteLink[] = [];
  for (const row of (res.data ?? []) as { id: string; label: string | null; team_role: string | null; max_uses: number | null; used_count: number | null; expires_at: string | null }[]) {
    const email = serviceInviteEmailFromLabel(row.label);
    if (!email) continue;
    if (row.max_uses != null && (row.used_count ?? 0) >= row.max_uses) continue;
    if (row.expires_at && new Date(row.expires_at) <= now) continue;
    links.push({ id: row.id, email, teamRole: row.team_role, expiresAt: row.expires_at });
  }
  return { ok: true, links };
}

/**
 * Edit a seat's access: role, houses and module levels, validated exactly like the invite. The owner of record's
 * access is fixed (read-only by role) and is changed by replacing them, never by editing. Audited before it changes.
 */
export async function updateServiceTeamAccess(
  db: SupabaseClient,
  operatorUserId: string,
  input: InviteAccessInput & { id: string; linkId: unknown },
  opts: OperatorOpts = {},
): Promise<ServiceResult<object>> {
  const linkId = typeof input.linkId === "string" ? input.linkId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return fail(400, "Choose a teammate.");
  const who = await operatorStanding(db, operatorUserId, input.id, opts);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can change access.");
  const link = await db
    .from("account_link_invites")
    .select("id, invitee_user_id, team_role, status, is_owner_of_record")
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id)
    .in("status", ["accepted", "pending"])
    .not("invitee_user_id", "is", null)
    .maybeSingle();
  if (link.error) return fail(503, "Could not update. Please retry.");
  if (!link.data) return fail(404, "Teammate not found.");
  const target = link.data as { invitee_user_id: string; team_role: string | null; status: string; is_owner_of_record: boolean | null };
  if (target.is_owner_of_record === true || target.team_role === "property_owner") {
    return fail(409, "The owner's access is read-only by role. Replace the owner to change who it is.");
  }
  const resolved = await resolveServiceSeatGrant(db, who, operatorUserId, input);
  if (!resolved.ok) return resolved;
  const { grant } = resolved;
  const oldRole = (parseTeamRole(target.team_role).ok ? (parseTeamRole(target.team_role) as { role: TeamRoleId | null }).role : null) ?? "custom";
  // Changing the last admin to anything else would leave the workspace without one (the same rule Remove follows).
  const losesAdmin = (oldRole === "admin" || oldRole === "full") && grant.teamRole !== "admin" && grant.teamRole !== "full";
  if (target.status === "accepted" && losesAdmin) {
    const verdict = canActOnMember({
      actorRole: who.standing.role,
      targetRole: oldRole,
      adminCount: await workspaceAdminCount(db, who.workspace.ownerUserId, who.workspace.id),
    });
    if (!verdict.ok) return fail(403, verdict.reason);
  }
  const audited = await auditServiceChange(
    db,
    operatorUserId,
    who.workspace.ownerUserId,
    "admin_service_team_access",
    {
      workspaceId: who.workspace.id,
      linkId,
      inviteeUserId: target.invitee_user_id,
      previousTeamRole: target.team_role,
      teamRole: grant.teamRole,
      houseScope: grant.houseScope,
      houseCount: grant.assignedPropertyIds.length,
    },
    true,
  );
  if (audited) return audited;
  const res = await db
    .from("account_link_invites")
    .update({
      team_role: grant.teamRole,
      house_scope: grant.houseScope,
      assigned_property_ids: grant.assignedPropertyIds,
      property_co_manager_permissions: grant.propertyCoManagerPermissions,
      co_manager_permissions: grant.coManagerPermissions,
      workspace_permissions: grant.workspacePermissions,
    })
    .eq("id", linkId)
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("workspace_id", who.workspace.id);
  if (res.error) return fail(503, "Could not update. Please retry.");
  return { ok: true };
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
    // The SAME answer the owner-invite verb guards with, so an unspent owner invite LINK counts too: otherwise this
    // flag is written behind the invited owner's back and their redeem then hits the one-owner constraint.
    const holder = await currentOwnerOfRecord(db, who.workspace);
    if (holder === null) return fail(503, "Could not update. Please retry.");
    if (holder.kind === "account") return fail(409, "The workspace's own owner is its owner of record.");
    if (holder.kind !== "none" && !(holder.kind === "member" && holder.linkId === linkId)) {
      return fail(409, "This workspace already has an owner of record.");
    }
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
  input: { id: string; linkId?: unknown; inviteLinkId?: unknown },
  opts: OperatorOpts = {},
): Promise<ServiceResult<object>> {
  // A person invited by email who has no account yet has no membership row, only an unspent invite link: withdrawing
  // them turns that link off.
  if (input.inviteLinkId !== undefined) {
    const inviteLinkId = typeof input.inviteLinkId === "string" ? input.inviteLinkId.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(inviteLinkId)) return fail(400, "Choose a teammate.");
    const who = await operatorStanding(db, operatorUserId, input.id, opts);
    if (!who.ok) return who;
    if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can change its team.");
    const live = await liveServiceInviteLinks(db, who.workspace);
    if (!live.ok) return live;
    const link = live.links.find((l) => l.id === inviteLinkId);
    if (!link) return fail(404, "Teammate not found.");
    const audited = await auditServiceChange(
      db,
      operatorUserId,
      who.workspace.ownerUserId,
      "admin_service_team_remove",
      { workspaceId: who.workspace.id, inviteLinkId, targetRole: link.teamRole, wasStatus: "pending", delivery: "link" },
      true,
    );
    if (audited) return audited;
    const res = await db
      .from("manager_invite_links")
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", inviteLinkId)
      .eq("owner_user_id", who.workspace.ownerUserId)
      .eq("workspace_id", who.workspace.id);
    if (res.error) return fail(503, "Could not remove the teammate. Please retry.");
    return { ok: true };
  }
  const linkId = typeof input.linkId === "string" ? input.linkId.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(linkId)) return fail(400, "Choose a teammate.");
  const who = await operatorStanding(db, operatorUserId, input.id, opts);
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

/**
 * Seat an EXISTING account on a PropLane Service workspace as an accepted, PropLane-issued team seat, with the role,
 * houses and module levels the Admin team asked for. Used when an admin-team invite is redeemed (the inviter is the
 * operator, re-derived at that moment), never from a request body naming the grantee. The same validators as
 * `inviteServiceClient` decide the grant (role from the allow-list, houses of THIS workspace, no role above the
 * operator's own); the audit row is written first and the seat refused without it.
 */
export async function seatAdminTeamMember(
  db: SupabaseClient,
  operatorUserId: string,
  input: InviteAccessInput & { id: string; userId: string; via: "invite" | "change" },
  opts: OperatorOpts = {},
): Promise<ServiceResult<{ linkId: string }>> {
  const userId = input.userId.trim();
  if (!userId) return fail(400, "Choose a teammate.");
  const who = await operatorStanding(db, operatorUserId, input.id, opts);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can invite people.");
  if (userId === who.workspace.ownerUserId) return fail(409, "That account already owns this workspace.");
  const resolved = await resolveServiceSeatGrant(db, who, operatorUserId, input);
  if (!resolved.ok) return resolved;
  const { grant } = resolved;
  const existing = await db
    .from("account_link_invites")
    .select("id, status, team_role, is_owner_of_record")
    .eq("inviter_user_id", who.workspace.ownerUserId)
    .eq("invitee_user_id", userId)
    .eq("workspace_id", who.workspace.id)
    .in("status", ["accepted", "pending"])
    .maybeSingle();
  if (existing.error) return fail(503, "Could not add the teammate. Please retry.");
  const current = existing.data as { id: string; status: string; is_owner_of_record: boolean | null } | null;
  if (current?.is_owner_of_record === true) return fail(409, "That account is this workspace's owner of record.");
  const audited = await auditServiceChange(
    db,
    operatorUserId,
    who.workspace.ownerUserId,
    "admin_team_seat",
    {
      workspaceId: who.workspace.id,
      inviteeUserId: userId,
      teamRole: grant.teamRole,
      houseScope: grant.houseScope,
      houseCount: grant.assignedPropertyIds.length,
      via: input.via,
      replacesLinkId: current?.id ?? null,
    },
    true,
  );
  if (audited) return audited;
  // A seat the person already holds (accepted, or pending from the older invite) is accepted with the new grant
  // rather than duplicated: one membership per workspace.
  if (current) {
    const res = await db
      .from("account_link_invites")
      .update({
        status: "accepted",
        responded_at: new Date().toISOString(),
        team_role: grant.teamRole,
        house_scope: grant.houseScope,
        assigned_property_ids: grant.assignedPropertyIds,
        property_co_manager_permissions: grant.propertyCoManagerPermissions,
        co_manager_permissions: grant.coManagerPermissions,
        workspace_permissions: grant.workspacePermissions,
        is_service_seat: true,
      })
      .eq("id", current.id)
      .eq("inviter_user_id", who.workspace.ownerUserId);
    if (res.error) return fail(503, "Could not add the teammate. Please retry.");
    return { ok: true, linkId: current.id };
  }
  const added = await insertAdminMembership(db, who.workspace.ownerUserId, who.workspace.id, userId, { grant });
  if (!added.ok) return added;
  return { ok: true, linkId: added.linkId };
}

/**
 * The same validation `seatAdminTeamMember` runs, without writing anything: may this operator hand out this role, to these
 * houses, in this workspace? The Admin team invite asks it when the invite is written, so a role above the inviter's own
 * or a house of another workspace is refused at the sheet instead of at the moment the invitee accepts.
 */
export async function checkAdminTeamSeatGrant(
  db: SupabaseClient,
  operatorUserId: string,
  input: InviteAccessInput & { id: string },
  opts: OperatorOpts = {},
): Promise<ServiceResult<object>> {
  const who = await operatorStanding(db, operatorUserId, input.id, opts);
  if (!who.ok) return who;
  if (!who.standing.rights.members) return fail(403, "Only the owner or an admin of this workspace can invite people.");
  const resolved = await resolveServiceSeatGrant(db, who, operatorUserId, input);
  return resolved.ok ? { ok: true } : resolved;
}
