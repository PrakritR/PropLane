import type { SupabaseClient } from "@supabase/supabase-js";
import { runManagerVoiceAgentTurn } from "@/lib/agent/manager-voice-agent.server";
import { runResidentVoiceAgentTurn } from "@/lib/agent/resident-voice-agent.server";
import { runLeasingVoiceAgentTurn } from "@/lib/agent/leasing-sms-agent.server";
import { PRODUCTION_APP_ORIGIN } from "@/lib/app-url";
import { normalizeE164 } from "@/lib/twilio";
import { upsertManagerSmsContact } from "@/lib/sms/manager-sms-contacts.server";
import { logVoiceCallLinks, logVoiceCallTurnNotes } from "@/lib/voice/log-voice-call-notes.server";
import { normalizeVoiceConfirmationForAgentGate } from "@/lib/voice/voice-confirmation.server";
import {
  ensureManagerVoiceAgentContext,
  resolveVoiceCallRoute,
  voiceCallLogIdentity,
  type ResolvedVoiceCall,
  type VoiceCallRoute,
} from "@/lib/voice/voice-call-routing.server";
import { linkNoteLines, linksToOffer, sanitizeForSpeech } from "@/lib/voice/voice-call-flow";
import { prospectContextFromEvidence } from "@/lib/prospect-replies";
import { evaluateManagerCommsBillingGate } from "@/lib/comms-billing/eligibility.server";
import type { VoicePayer } from "@/lib/comms-billing/voice-credit.server";

const FALLBACK_REPLY =
  "Sorry, I could not process that right now. Please try again or text this number instead.";

type Resolved = Extract<ResolvedVoiceCall, { ok: true }>;

async function touchSmsContact(
  db: SupabaseClient,
  args: { managerId: string; fromPhone: string; route: VoiceCallRoute },
): Promise<void> {
  if (args.route.kind === "manager") return;
  const role = args.route.kind === "resident" ? "resident" : "prospect";
  await upsertManagerSmsContact(db, {
    managerUserId: args.managerId,
    phone: args.fromPhone,
    counterpartyRole: role,
    lastInboundAt: new Date().toISOString(),
  }).catch(() => undefined);
}

export type VoiceTurnResult = {
  /** What the caller hears. Null = the agent produced nothing (refused credit, model failure). */
  reply: string | null;
  /** How many pages this turn queued for the post-call text. */
  offered: number;
  /** The agent handed the question to a person (it called `escalate_to_manager`): the call is bridged to one. */
  needsHuman?: boolean;
};

/**
 * One spoken turn. The role decides the agent and the registry (the same ones SMS uses; a voice turn is read-only like an
 * SMS surface), `landlordId` comes from the routed call and never from the caller. A prospect turn also records the pages
 * the caller asked for (or the agent promised) in the call's own thread, which is what the post-call text sends.
 */
export async function runVoiceCallTurn(args: {
  db: SupabaseClient;
  resolved: Resolved;
  payer: VoicePayer | null;
  fromPhone: string;
  speechResult: string;
  callSid: string;
  turnId?: string;
}): Promise<VoiceTurnResult> {
  const { db, resolved, payer } = args;
  const { managerId, route } = resolved;
  if (route.kind === "ambiguous" || route.kind === "redirect") return { reply: null, offered: 0 };

  // PropLane paying on its own line is never stopped by an empty wallet; every other call keeps its gate.
  if (!(payer?.allowUnfunded && route.kind === "prospect")) {
    const billing = await evaluateManagerCommsBillingGate(db, managerId, 15, resolved.workspaceId);
    if (!billing.allowed) return { reply: null, offered: 0 };
  }

  await touchSmsContact(db, { managerId, fromPhone: args.fromPhone, route });

  const speech = normalizeVoiceConfirmationForAgentGate(args.speechResult);
  const callSid = args.callSid.trim();
  const fromE164 = normalizeE164(args.fromPhone) ?? args.fromPhone.trim();
  const logIdentity = voiceCallLogIdentity({
    managerId,
    workNumber: resolved.workNumber,
    fromPhone: args.fromPhone,
    route,
    workspaceId: resolved.workspaceId,
  });
  const turnSid = `${callSid}:${args.turnId ?? "legacy"}`;

  let reply: string | null = null;
  let offered = 0;
  let needsHuman = false;

  if (route.kind === "manager") {
    const managerIdentity = await ensureManagerVoiceAgentContext(db, route);
    if (!managerIdentity.ok) return { reply: null, offered: 0 };
    const turn = await runManagerVoiceAgentTurn(db, {
      ctx: managerIdentity.ctx,
      managerPhoneE164: fromE164,
      inboundText: speech,
      inboundCallSid: turnSid,
    });
    reply = turn?.reply?.trim() || null;
  } else if (route.kind === "resident") {
    const turn = await runResidentVoiceAgentTurn(db, {
      ctx: route.ctx,
      ownerManagerUserId: managerId,
      residentPhoneE164: fromE164,
      inboundText: speech,
      inboundCallSid: turnSid,
    });
    reply = turn?.reply?.trim() || null;
  } else {
    const turn = await runLeasingVoiceAgentTurn(db, {
      landlordId: managerId,
      prospectPhoneE164: fromE164,
      inboundText: speech,
      workNumber: resolved.workNumber,
      workspaceId: resolved.workspaceId,
      serviceCatalog: route.serviceCatalog === true,
      ...(payer?.allowUnfunded ? { billingOverride: { ownerUserId: payer.ownerId, workspaceId: payer.workspaceId, allowUnfunded: true } } : {}),
      inboundCallSid: turnSid,
    });
    reply = turn?.reply?.trim() || null;
    needsHuman = (turn?.toolTrace ?? []).some((entry) => entry.tool === "escalate_to_manager" && entry.ok);
    if (reply) {
      // The pages come from this turn's own tool results for the home it matched; what the caller said only picks WHICH.
      const evidence = ((turn?.candidateContext ?? []) as Array<{ tool: string; input?: unknown; output: unknown }>).filter((item) => item && typeof item.tool === "string");
      const context = prospectContextFromEvidence(evidence, PRODUCTION_APP_ORIGIN);
      const kinds = linksToOffer({ speech: args.speechResult, reply, links: context.links });
      const lines = linkNoteLines(context.links, kinds);
      if (lines.length > 0) {
        offered = lines.length;
        await logVoiceCallLinks(db, { ...logIdentity, callSid, lines }).catch(() => false);
      }
    }
  }

  if (!reply) return { reply: null, offered };
  const spoken = sanitizeForSpeech(reply);

  await logVoiceCallTurnNotes(db, {
    ...logIdentity,
    callSid,
    spoken: args.speechResult,
    reply: spoken,
  });

  return { reply: spoken, offered, ...(needsHuman ? { needsHuman } : {}) };
}

/** Records the one page a caller is always sent when the agent could not answer: the browse page, by text. */
export async function queueBrowseLinkForCall(db: SupabaseClient, resolved: Resolved, fromPhone: string, callSid: string): Promise<void> {
  if (resolved.route.kind !== "prospect") return;
  const identity = voiceCallLogIdentity({ managerId: resolved.managerId, workNumber: resolved.workNumber, fromPhone, route: resolved.route, workspaceId: resolved.workspaceId });
  await logVoiceCallLinks(db, { ...identity, callSid, lines: [`See all homes: ${PRODUCTION_APP_ORIGIN}/rent/browse`] }).catch(() => false);
}

/** Back-compat wrapper: the spoken answer, or the fixed apology. */
export async function runVoiceCallTurnFromSpeechOrFallback(args: {
  db: SupabaseClient;
  fromPhone: string;
  toPhone: string;
  speechResult: string;
  callSid: string;
  turnId?: string;
  payer?: VoicePayer | null;
}): Promise<string> {
  const resolved = await resolveVoiceCallRoute(args.db, { fromPhone: args.fromPhone, toPhone: args.toPhone, callSid: args.callSid, speech: args.speechResult });
  if (!resolved.ok) return FALLBACK_REPLY;
  const result = await runVoiceCallTurn({ ...args, resolved, payer: args.payer ?? null });
  return result.reply?.trim() || FALLBACK_REPLY;
}

export { FALLBACK_REPLY as VOICE_TURN_FALLBACK_REPLY };
