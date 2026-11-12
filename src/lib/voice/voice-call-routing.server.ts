import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";
import { resolveResidentSmsAgentContext } from "@/lib/tools/resident-sms-context";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import type { ManagerSmsInboundIdentity } from "@/lib/sms/manager-sms-access.server";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import type { SharedLineCandidate } from "@/lib/one-number/contracts";
import { isSharedLineNumber, loadSharedLineConfig } from "@/lib/one-number/config.server";
import { decideSharedLineCall } from "@/lib/one-number/inbound-seam.server";
import { dedicatedRedirectReplyFor } from "@/lib/one-number/dedicated-redirect.server";
import { pickCandidateFromText, spokenLabelFor } from "@/lib/one-number/router.server";
import { saveSharedLineRoute } from "@/lib/one-number/session.server";
import { isServiceWorkspace } from "@/lib/one-number/service-line.server";
import { userDefaultWorkspaceId } from "@/lib/communication/manager-assistant-workspace.server";
import { isPropLaneServiceLine, readPlatformServiceOwnerId } from "@/lib/service/service-catalog.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { normalizeE164 } from "@/lib/twilio";
import type { VoiceBilling } from "@/lib/comms-billing/voice-credit.server";
import { resolveOwnedWorkNumber } from "@/lib/voice/manager-voice-inbound.server";

export const MANAGER_VOICE_UNCONFIGURED_PROMPT = "This number is not configured.";
export const VOICE_VENDOR_PROMPT = "For vendor work, please text this number. Goodbye.";

export type VoiceCallRoute =
  | { kind: "manager"; identity: ManagerSmsInboundIdentity }
  | { kind: "resident"; ctx: ResidentAgentContext; residentUserId: string }
  /** `serviceCatalog`: a stranger on the PropLane line, answered from PropLane-managed homes only. */
  | { kind: "prospect"; serviceCatalog?: boolean }
  /** Several workspaces fit this caller and nothing they have said settles it: ask once. */
  | { kind: "ambiguous"; candidates: SharedLineCandidate[]; question: string }
  /** Nothing to run: say `reply` and hang up (a workspace with its own number, a vendor). */
  | { kind: "redirect"; reply: string };

export type ResolvedVoiceCall =
  | { ok: false; reason: "unconfigured" }
  | {
      ok: true;
      /** The workspace owner the agent runs as. */
      managerId: string;
      /** Workspace that owns the call: its wallet pays first. */
      workspaceId: string | null;
      /** The number that was dialed; every text after the call leaves from it. */
      workNumber: string;
      route: VoiceCallRoute;
      /** `shared`: the PropLane line (routed by the shared-line seam). `dedicated`: a workspace's own work number. */
      line: "shared" | "dedicated";
      billing: VoiceBilling;
    };

type Owned = { managerId: string; workspaceId: string | null };

/** The platform service owner and its default workspace: who PropLane's own calls are billed to. */
async function platformTarget(db: SupabaseClient): Promise<{ ownerId: string; workspaceId: string | null } | null> {
  const ownerId = await readPlatformServiceOwnerId(db).catch(() => null);
  if (!ownerId) return null;
  const workspaceId = (await userDefaultWorkspaceId(db, ownerId)) || null;
  return { ownerId, workspaceId };
}

/** Same fork order as `/api/twilio/inbound` SMS: manager, then resident, then prospect. */
async function forkByRole(
  db: SupabaseClient,
  args: { owned: Owned; fromPhone: string; toPhone: string; candidate: SharedLineCandidate | null },
): Promise<VoiceCallRoute> {
  const managerInbound = await resolveManagerSmsInboundIdentity(db, {
    workNumberOwnerId: args.owned.managerId,
    fromPhone: args.fromPhone,
    toPhone: args.toPhone,
  });
  if (managerInbound) return { kind: "manager", identity: managerInbound };
  if (args.candidate?.role === "vendor") return { kind: "redirect", reply: VOICE_VENDOR_PROMPT };
  const residentIdentity = await resolveResidentSmsAgentContext(db, {
    fromPhone: args.fromPhone,
    ownerManagerUserId: args.owned.managerId,
  });
  if (residentIdentity.ok) return { kind: "resident", ctx: residentIdentity.ctx, residentUserId: residentIdentity.ctx.userId };
  return { kind: "prospect" };
}

/**
 * Who pays. A workspace's own wallet first; on a PropLane-run line (the shared 206, a PropLane-managed workspace, the
 * service owner's own number) PropLane's wallet is the backstop, so an empty client wallet never turns a caller away.
 */
async function billingFor(
  db: SupabaseClient,
  args: { owned: Owned; propLaneRun: boolean },
): Promise<VoiceBilling> {
  const primary = { ownerId: args.owned.managerId, workspaceId: args.owned.workspaceId };
  if (!args.propLaneRun) return { primary, platform: null };
  return { primary, platform: await platformTarget(db) };
}

/**
 * Route one call: the same decision an inbound text gets. A dedicated work number belongs to its owner's workspace; the
 * shared PropLane line goes through the shared-line seam (`decideSharedLineCall`), so a caller is a manager, a resident or a
 * prospect of the right workspace, a stranger is served from PropLane's own homes, and an unclear caller is asked once.
 * `speech` is what the caller has said so far: a spoken house name settles an ambiguity and is remembered on the phone's
 * router session, so the next turn routes straight to it.
 */
export async function resolveVoiceCallRoute(
  db: SupabaseClient,
  args: { fromPhone: string; toPhone: string; callSid?: string; speech?: string },
): Promise<ResolvedVoiceCall> {
  const workNumber = normalizeE164(args.toPhone) ?? args.toPhone.trim();
  const config = await loadSharedLineConfig(db);

  if (config.mode === "shared" && isSharedLineNumber(config, args.toPhone)) {
    const phoneKey = normalizeConsentPhone(args.fromPhone);
    if (!phoneKey) return { ok: false, reason: "unconfigured" };
    const decide = () => decideSharedLineCall(db, { config, fromPhone: args.fromPhone, phoneKey, body: args.speech ?? "", callSid: args.callSid ?? "" });
    let decision = await decide();
    if (decision.kind === "ambiguous" && args.speech) {
      const picked = pickCandidateFromText(args.speech, decision.candidates);
      if (picked) {
        await saveSharedLineRoute(db, phoneKey, { workspaceId: picked.workspaceId, role: picked.role }).catch(() => undefined);
        decision = { kind: "continue", owned: { managerId: picked.ownerUserId, workspaceId: picked.workspaceId }, candidate: picked };
      }
    }
    if (decision.kind === "none") return { ok: false, reason: "unconfigured" };
    const platform = await platformTarget(db);
    if (decision.kind === "stranger" || decision.kind === "ambiguous" || decision.kind === "dedicated") {
      // Nobody's workspace yet: PropLane answers and PropLane pays.
      if (!platform) return { ok: false, reason: "unconfigured" };
      const billing: VoiceBilling = { primary: platform, platform };
      const base = { ok: true as const, managerId: platform.ownerId, workspaceId: platform.workspaceId, workNumber, line: "shared" as const, billing };
      if (decision.kind === "stranger") return { ...base, route: { kind: "prospect", serviceCatalog: true } };
      if (decision.kind === "ambiguous") return { ...base, route: { kind: "ambiguous", candidates: decision.candidates, question: decision.question } };
      const reply = await dedicatedRedirectReplyFor(db, decision.candidate).catch(() => null);
      return reply ? { ...base, route: { kind: "redirect", reply } } : { ok: false, reason: "unconfigured" };
    }
    const owned: Owned = { managerId: decision.owned.managerId, workspaceId: decision.owned.workspaceId };
    const route = await forkByRole(db, { owned, fromPhone: args.fromPhone, toPhone: args.toPhone, candidate: decision.candidate });
    const managed = (await isServiceWorkspace(db, owned.workspaceId)) === true;
    return { ok: true, ...owned, workNumber, route, line: "shared", billing: await billingFor(db, { owned, propLaneRun: managed }) };
  }

  const owned = await resolveOwnedWorkNumber(db, args.toPhone);
  if (!owned) return { ok: false, reason: "unconfigured" };
  const route = await forkByRole(db, { owned, fromPhone: args.fromPhone, toPhone: args.toPhone, candidate: null });
  // A PropLane-managed workspace, or the service owner's own number, is PropLane-run in every line mode.
  const propLaneRun =
    (await isServiceWorkspace(db, owned.workspaceId)) === true ||
    (await isPropLaneServiceLine(db, { ownerUserId: owned.managerId, workNumber }).catch(() => false));
  return {
    ok: true,
    managerId: owned.managerId,
    workspaceId: owned.workspaceId,
    workNumber,
    route,
    line: "dedicated",
    billing: await billingFor(db, { owned, propLaneRun }),
  };
}

export function voiceGreetingForRoute(route: VoiceCallRoute): string {
  switch (route.kind) {
    case "manager":
      return "PropLane assistant. How can I help with tours or property today?";
    case "resident":
      return "PropLane resident assistant. I can help with your lease, payments, or maintenance. What do you need?";
    case "prospect":
      return "Thanks for calling PropLane. I can help with available homes, tour times and applications. Which house are you asking about?";
    case "ambiguous":
      return `Thanks for calling PropLane. ${route.question.replace(/^Is this about /, "Are you calling about ")}`;
    case "redirect":
      return route.reply;
  }
}

export function voiceCounterpartyRole(route: VoiceCallRoute): SmsCounterpartyRole {
  switch (route.kind) {
    case "manager":
      return "manager";
    case "resident":
      return "resident";
    default:
      return "prospect";
  }
}

export function voiceCallLogIdentity(args: {
  managerId: string;
  workNumber: string;
  fromPhone: string;
  route: VoiceCallRoute;
  workspaceId?: string | null;
}): {
  managerUserId: string;
  actorUserId: string;
  actorPhone: string;
  workNumber: string;
  counterpartyRole: SmsCounterpartyRole;
  workspaceId?: string | null;
} {
  const fromPhone = args.fromPhone.trim();
  const workspaceId = args.workspaceId ?? null;
  switch (args.route.kind) {
    case "manager":
      return {
        managerUserId: args.managerId,
        actorUserId: args.route.identity.actorUserId,
        actorPhone: args.route.identity.actorPhone,
        workNumber: args.route.identity.workNumber,
        counterpartyRole: "manager",
        workspaceId,
      };
    case "resident":
      return {
        managerUserId: args.managerId,
        actorUserId: args.route.residentUserId,
        actorPhone: fromPhone,
        workNumber: args.workNumber,
        counterpartyRole: "resident",
        workspaceId,
      };
    default:
      return {
        managerUserId: args.managerId,
        actorUserId: args.managerId,
        actorPhone: fromPhone,
        workNumber: args.workNumber,
        counterpartyRole: "prospect",
        workspaceId,
      };
  }
}

/** The word a caller hears for a candidate: a house or place, never a person. */
export function spokenCandidateLabel(candidate: SharedLineCandidate): string {
  return spokenLabelFor(candidate);
}

export async function ensureManagerVoiceAgentContext(
  db: SupabaseClient,
  route: Extract<VoiceCallRoute, { kind: "manager" }>,
) {
  return resolveManagerSmsAgentContext(db, {
    managerUserId: route.identity.workNumberOwnerId,
    actorUserId: route.identity.actorUserId,
    access: route.identity.access,
  });
}
