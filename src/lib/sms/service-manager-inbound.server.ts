import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { CO_MANAGER_PERMISSION_OPTIONS, coManagerModuleAllowed } from "@/lib/co-manager-permissions";
import { loadSharedLineConfig, isSharedLineNumber } from "@/lib/one-number/config.server";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";
import { listLineMemberships } from "@/lib/one-number/line-member-status.server";
import { findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { decideFromCandidates } from "@/lib/one-number/router.server";
import { loadSharedLineSession, saveSharedLinePending, saveSharedLineRoute } from "@/lib/one-number/session.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { serviceWorkspaceLabel } from "@/lib/service/service-label";
import { identifyServiceManagerPhone } from "@/lib/service/service-manager.server";
import { isPropLaneServiceLine } from "@/lib/service/service-catalog.server";
import type { ManagerSmsAccess } from "@/lib/sms/manager-sms-access";
import { resolveManagerSmsAccess, type ManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { resolveManagerSmsAgentContext, type ManagerSmsIdentity } from "@/lib/tools/manager-sms-context";

/**
 * Who runs PropLane-managed (`is_service`) workspaces by text on the PropLane line. One rule set:
 *
 *   ADMIN   a platform admin (an `admin` row in `profile_roles`) whose `profiles.phone` is VERIFIED and is the only
 *           verified holder of that number, or the verified phone in `platform_service_settings` (the older "service
 *           manager" setting, which stays as an alias because several profiles may hold that number): the FULL manager
 *           agent over EVERY service workspace, reads and writes, each write behind the coded YES.
 *   SEAT    anyone with an accepted team seat on a service workspace, attached client workspaces included: the
 *           delegated manager agent over every managed workspace they hold a seat on, limited to the houses assigned to
 *           that seat and the modules granted on each. A Viewer seat (or a seat with no edit grant on the workspace's
 *           houses) is read-only: it is given no write tool at all.
 *
 * Everything fails closed. A phone claimed by two verified accounts, an unverified phone, an unreadable role or
 * membership table, a seat with no houses: that is a stranger (or less), never more access. It only counts when the text
 * arrived on the PropLane line (the service owner's number in per_workspace mode, or the shared number); the same phone
 * texting any other number is not recognized here.
 *
 * The workspace is picked the way the line picks one for anyone with several (the text names it, the last pick is
 * remembered for six hours, else "Is this about Ambika or Vinod?"). The managed-client view-only lock is the CLIENT's
 * and never applies to staff (`lockedOwnedServiceWorkspaceIds`); it never lifts for a client's own seat.
 */

export type ServiceWorkspaceRef = { id: string; name: string; ownerUserId: string; isDefault: boolean };

/** One seat on a service workspace. `viewerRole`: the seat's team role is Viewer (the access is re-derived at context build). */
export type ServiceSeat = { workspace: ServiceWorkspaceRef; viewerRole: boolean };

export type ServiceManagerIdentity = ManagerSmsInboundIdentity & {
  serviceManager: true;
  /** `admin`: every service workspace. `seat`: only `seats`. */
  basis: "admin" | "seat";
  seats?: ServiceSeat[];
};

type Candidate = { basis: "admin"; actorUserId: string } | { basis: "seat"; actorUserId: string; seats: ServiceSeat[] };

/** An `admin` row in `profile_roles` ONLY (the legacy `profiles.role` and the ops email are not evidence here). Unreadable = no. */
export async function holdsAdminRole(db: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await db.from("profile_roles").select("role").eq("user_id", userId).eq("role", "admin").limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}

/** The admin or seat holder whose VERIFIED, unique profile phone this is. Null for everyone else. */
async function recognizeByVerifiedProfile(db: SupabaseClient, fromPhone: string): Promise<Candidate | null> {
  const profile = await findVerifiedProfileByPhone(db, fromPhone).catch(() => null);
  if (!profile) return null;
  if (await holdsAdminRole(db, profile.id).catch(() => false)) return { basis: "admin", actorUserId: profile.id };
  const memberships = await listLineMemberships(db, profile.id, { kinds: ["teammate"] }).catch(() => null);
  if (!memberships) return null;
  const seats: ServiceSeat[] = memberships
    .filter((m) => m.kind === "teammate" && m.isService)
    .map((m) => ({
      workspace: { id: m.workspaceId, name: m.workspaceName, ownerUserId: m.ownerUserId, isDefault: m.isDefault },
      viewerRole: m.teamRole === "viewer",
    }));
  return seats.length > 0 ? { basis: "seat", actorUserId: profile.id, seats } : null;
}

/** Is this inbound text a platform admin's or a service seat holder's, on the PropLane line? Null for everyone and everything else. */
export async function recognizeServiceManagerInbound(
  db: SupabaseClient,
  args: { managerId: string; fromPhone: string; toPhone: string },
): Promise<ServiceManagerIdentity | null> {
  const toPhone = normalizeE164(args.toPhone) ?? args.toPhone;
  let config: Awaited<ReturnType<typeof loadSharedLineConfig>> | null = null;
  const onLine = async (): Promise<boolean> => {
    config ??= await loadSharedLineConfig(db);
    return (
      isSharedLineNumber(config, toPhone) ||
      (await isPropLaneServiceLine(db, { ownerUserId: args.managerId, workNumber: toPhone, sharedNumber: config.sharedNumber }))
    );
  };

  let candidate: Candidate | null = null;
  const settings = await identifyServiceManagerPhone(db, args.fromPhone);
  if (settings) {
    candidate = { basis: "admin", actorUserId: settings.ownerUserId };
    if (!(await onLine())) return null;
  } else {
    // Cheapest test first: not the PropLane line = nobody here, and no profile read is spent on a manager's own number.
    if (!(await onLine())) return null;
    candidate = await recognizeByVerifiedProfile(db, args.fromPhone);
  }
  if (!candidate) return null;

  const access: ManagerSmsAccess =
    candidate.basis === "admin"
      ? { mode: "owner", workNumberOwnerId: args.managerId, actorUserId: candidate.actorUserId, dataOwnerIds: [candidate.actorUserId], assignedPropertyIds: [] }
      : // A placeholder that grants nothing: a seat's real access is built per workspace (`buildServiceManagerAgentContext`).
        { mode: "delegated", workNumberOwnerId: args.managerId, actorUserId: candidate.actorUserId, dataOwnerIds: [], assignedPropertyIds: [] };
  return {
    workNumberOwnerId: args.managerId,
    actorUserId: candidate.actorUserId,
    workNumber: toPhone,
    actorPhone: normalizeE164(args.fromPhone) ?? args.fromPhone,
    access,
    serviceManager: true,
    basis: candidate.basis,
    ...(candidate.basis === "seat" ? { seats: candidate.seats } : {}),
  };
}

/** Every PropLane Service workspace (the flag, whoever owns it). Null when the read fails: the caller says nothing rather than guess. */
export async function listServiceWorkspaceRefs(db: SupabaseClient): Promise<ServiceWorkspaceRef[] | null> {
  const { data, error } = await db
    .from("portal_workspaces")
    .select("id, name, owner_user_id, is_default")
    .eq("is_service", true)
    .limit(500);
  if (error) return null;
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      id: String(row.id ?? ""),
      name: String(row.name ?? "").trim(),
      ownerUserId: String(row.owner_user_id ?? ""),
      isDefault: row.is_default === true,
    }))
    .filter((ws) => ws.id && ws.ownerUserId)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * The workspaces this identity may text about: every service workspace for an admin, and only the workspaces they hold a
 * seat on for a seat holder. A seat is checked against the LIVE service list (a workspace that stopped being managed drops
 * out). Null when the list cannot be read.
 */
export async function listServiceWorkspacesFor(db: SupabaseClient, identity: Pick<ServiceManagerIdentity, "basis" | "seats">): Promise<ServiceWorkspaceRef[] | null> {
  const live = await listServiceWorkspaceRefs(db);
  if (!live) return null;
  if (identity.basis === "admin") return live;
  const seatIds = new Set((identity.seats ?? []).map((seat) => seat.workspace.id));
  return live.filter((ws) => seatIds.has(ws.id));
}

const candidateOf = (ws: ServiceWorkspaceRef): SharedLineCandidate => ({
  workspaceId: ws.id,
  ownerUserId: ws.ownerUserId,
  role: "manager",
  reason: "team_member",
  propertyId: null,
  label: serviceWorkspaceLabel(ws.name),
});

export type ServiceWorkspacePick =
  | { kind: "chosen"; workspace: ServiceWorkspaceRef }
  | { kind: "ask"; question: string }
  | { kind: "none" };

/**
 * Which service workspace is this text about? One workspace is not a question. Several: a reply to our earlier question,
 * a name in the text, or the workspace the manager was last talking about; otherwise ask once. The remembered pick is
 * re-checked against the live list every time, never trusted.
 */
export async function pickServiceWorkspace(
  db: SupabaseClient,
  args: { fromPhone: string; body: string; workspaces: ServiceWorkspaceRef[] },
): Promise<ServiceWorkspacePick> {
  if (args.workspaces.length === 0) return { kind: "none" };
  if (args.workspaces.length === 1) return { kind: "chosen", workspace: args.workspaces[0]! };
  const key = `sm:${normalizeConsentPhone(args.fromPhone)}`;
  const candidates = args.workspaces.map(candidateOf);
  const session = await loadSharedLineSession(db, key);
  const decided = decideFromCandidates({ body: args.body, candidates, session });
  if (decided.kind === "ambiguous") {
    await saveSharedLinePending(db, key, decided.candidates);
    return { kind: "ask", question: decided.question };
  }
  if (decided.kind === "none") return { kind: "none" };
  const workspace = args.workspaces.find((ws) => ws.id === decided.candidate.workspaceId);
  if (!workspace) return { kind: "none" };
  await saveSharedLineRoute(db, key, { workspaceId: workspace.id, role: "manager" });
  return { kind: "chosen", workspace };
}

/** Is any module editable on any of these houses under these grants? */
function canEditAnywhere(permissions: Parameters<typeof coManagerModuleAllowed>[0], propertyIds: readonly string[]): boolean {
  return propertyIds.some((propertyId) => CO_MANAGER_PERMISSION_OPTIONS.some(({ id }) => coManagerModuleAllowed(permissions, propertyId, id, "edit")));
}

export type ServiceManagerContextResult = ManagerSmsIdentity | { ok: false; reason: "no_houses" };

/**
 * The manager agent's context over ONE service workspace. Built only after `recognizeServiceManagerInbound`; never from
 * anything the text carried.
 *
 *   admin (no `seat`)  the data owner is the workspace's owner (the client), the actor is `serviceOwnerId` (the admin),
 *                      and the access is `owner`: the whole manager catalog is in reach exactly as if the owner texted
 *                      their own work number, narrowed to the workspace's houses.
 *   seat               the ordinary DELEGATED access of that team seat: only the houses assigned to it and the modules
 *                      granted on each. A Viewer seat, or one with no edit grant on this workspace's houses, is marked
 *                      `readOnly`, which takes every write tool out of the registry. A seat with no houses here is
 *                      `no_houses` (nothing is read).
 */
export async function buildServiceManagerAgentContext(
  db: SupabaseClient,
  args: { serviceOwnerId: string; workspace: ServiceWorkspaceRef; seat?: ServiceSeat | null },
): Promise<ServiceManagerContextResult> {
  if (args.seat) {
    if (args.seat.workspace.id !== args.workspace.id) return { ok: false, reason: "no_houses" };
    const access = await resolveManagerSmsAccess(db, { actorUserId: args.serviceOwnerId, workNumberOwnerId: args.workspace.ownerUserId }).catch(() => null);
    if (!access || access.mode !== "delegated") return { ok: false, reason: "no_houses" };
    const seatBase = await resolveManagerSmsAgentContext(db, {
      managerUserId: args.workspace.ownerUserId,
      actorUserId: args.serviceOwnerId,
      access,
      workspaceId: args.workspace.id,
    });
    if (!seatBase.ok) return seatBase;
    const houses = [...(seatBase.ctx.workspace?.propertyIds ?? [])];
    if (houses.length === 0 || !seatBase.ctx.managerSmsAccess) return { ok: false, reason: "no_houses" };
    const readOnly = args.seat.viewerRole || !canEditAnywhere(access.permissionsByOwner?.[args.workspace.ownerUserId], houses);
    return {
      ok: true,
      ctx: { ...seatBase.ctx, managerSmsAccess: { ...seatBase.ctx.managerSmsAccess, ...(readOnly ? { readOnly: true as const } : {}) } },
    };
  }
  // With no access the resolver proves the workspace belongs to `managerUserId` (the client) and lists ALL its houses
  // (a delegated access would narrow them to an assignment). Landlord and access are then restated below.
  const base = await resolveManagerSmsAgentContext(db, {
    managerUserId: args.workspace.ownerUserId,
    actorUserId: args.serviceOwnerId,
    workspaceId: args.workspace.id,
  });
  if (!base.ok) return base;
  const workspacePropertyIds = [...(base.ctx.workspace?.propertyIds ?? [])];
  const access: ManagerSmsAccess = {
    mode: "owner",
    workNumberOwnerId: args.workspace.ownerUserId,
    actorUserId: args.serviceOwnerId,
    dataOwnerIds: [args.workspace.ownerUserId],
    assignedPropertyIds: [],
    workspacePropertyIds,
    workspaceIsDefault: args.workspace.isDefault,
  };
  return { ok: true, ctx: { ...base.ctx, landlordId: args.workspace.ownerUserId, managerSmsAccess: access } };
}
