import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, isSharedLineNumber } from "@/lib/one-number/config.server";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";
import { decideFromCandidates } from "@/lib/one-number/router.server";
import { loadSharedLineSession, saveSharedLinePending, saveSharedLineRoute } from "@/lib/one-number/session.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { serviceWorkspaceLabel } from "@/lib/service/service-label";
import { identifyServiceManagerPhone } from "@/lib/service/service-manager.server";
import { isPropLaneServiceLine } from "@/lib/service/service-catalog.server";
import type { ManagerSmsAccess } from "@/lib/sms/manager-sms-access";
import type { ManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { resolveManagerSmsAgentContext, type ManagerSmsIdentity } from "@/lib/tools/manager-sms-context";

/**
 * The SERVICE MANAGER texting the PropLane line (captain, Oct 19): "510-309-8345, when I text from it to the PropLane
 * number, is acting as a manager who has access to ALL properties."
 *
 * Identity is the verified manager phone in `platform_service_settings` (`service-manager.server.ts`), checked BEFORE the
 * generic member / status fork and never through `profiles.phone` (several profiles hold that number, which the generic
 * lookups read as nobody). It only counts when the text arrived on the PropLane line: the service owner's number in
 * per_workspace mode, or the shared number. The same phone texting any other number is not the service manager.
 *
 * What it gets: the FULL manager agent (reads and writes, each write behind the usual YES), over one PropLane Service
 * workspace at a time. The workspace is picked the way the line picks one for anyone with several (the text names it, the
 * last pick is remembered for six hours, else "Is this about Ambika or Vinod?"). Writes are allowed: the actor is the
 * service owner, who is staff; the managed-client view-only lock is the CLIENT's and never applies to the owner of the
 * service (`lockedOwnedServiceWorkspaceIds`).
 */

export type ServiceManagerIdentity = ManagerSmsInboundIdentity & { serviceManager: true };

/** Is this inbound text the service manager's, on the PropLane line? Null for everyone and everything else. */
export async function recognizeServiceManagerInbound(
  db: SupabaseClient,
  args: { managerId: string; fromPhone: string; toPhone: string },
): Promise<ServiceManagerIdentity | null> {
  const settings = await identifyServiceManagerPhone(db, args.fromPhone);
  if (!settings) return null;
  const toPhone = normalizeE164(args.toPhone) ?? args.toPhone;
  const config = await loadSharedLineConfig(db);
  const onLine =
    isSharedLineNumber(config, toPhone) ||
    (await isPropLaneServiceLine(db, { ownerUserId: args.managerId, workNumber: toPhone, sharedNumber: config.sharedNumber }));
  if (!onLine) return null;
  const access: ManagerSmsAccess = {
    mode: "owner",
    workNumberOwnerId: args.managerId,
    actorUserId: settings.ownerUserId,
    dataOwnerIds: [settings.ownerUserId],
    assignedPropertyIds: [],
  };
  return {
    workNumberOwnerId: args.managerId,
    actorUserId: settings.ownerUserId,
    workNumber: toPhone,
    actorPhone: normalizeE164(args.fromPhone) ?? args.fromPhone,
    access,
    serviceManager: true,
  };
}

export type ServiceWorkspaceRef = { id: string; name: string; ownerUserId: string; isDefault: boolean };

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

/**
 * The manager agent's context for the service manager over ONE service workspace: the data owner is the workspace's
 * owner (the client), the actor is the service owner, and the access is `owner`, so the whole manager catalog is
 * in reach exactly as if the owner texted their own work number. The workspace narrows every read and write to its
 * houses. Built only after `recognizeServiceManagerInbound`; never from anything the text carried.
 */
export async function buildServiceManagerAgentContext(
  db: SupabaseClient,
  args: { serviceOwnerId: string; workspace: ServiceWorkspaceRef },
): Promise<ManagerSmsIdentity> {
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
