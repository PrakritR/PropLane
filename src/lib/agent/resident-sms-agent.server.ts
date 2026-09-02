/**
 * The resident SMS agent: one inbound text from a VERIFIED resident becomes one
 * outbound reply, with the resident portal's full tool catalog behind it.
 *
 * The turn itself lives in `sms-agent-turn.server.ts` — shared with the manager
 * SMS agent so the write gate, the one-open-proposal invariant, and the
 * confirmation-before-the-model rule cannot drift between the two surfaces.
 * This module is the resident-specific binding around it:
 *
 *  - Identity comes from {@link resolveResidentSmsAgentContext}, which requires
 *    a verified phone AND that the texted work number's owner is one of this
 *    resident's managers. This module NEVER resolves identity itself; it is
 *    handed a context that already passed that gate.
 *  - The registry is the resident portal's own, so every tool's existing
 *    `ctx.userId` / `ctx.email` scoping applies unchanged. That is what keeps a
 *    manager's scheduled message invisible here: `get_my_scheduled_messages`
 *    filters on `senderPortal = 'resident'` AND `senderUserId = ctx.userId`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { PROMPT_IDS } from "@/lib/agent/prompt-metadata";
import { RESIDENT_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import type { TraceActor } from "@/lib/observability/langfuse";
import {
  findOrCreateSmsAgentSession,
  runSmsAgentTurn,
  type SmsAgentSessionRow,
  type SmsAgentSurface,
  type SmsAgentTurn,
} from "@/lib/agent/sms-agent-turn.server";

type Db = SupabaseClient;

const SESSION_KIND = "resident_sms";

export type ResidentSmsSessionRow = SmsAgentSessionRow;
export type ResidentSmsTurn = SmsAgentTurn;

const RESIDENT_SMS_SURFACE: SmsAgentSurface = {
  sessionKind: SESSION_KIND,
  portal: "resident",
  basePrompt: RESIDENT_SMS_AGENT_SYSTEM_PROMPT,
  promptId: PROMPT_IDS.residentSmsAgent,
  traceName: "resident-sms-agent-turn",
  analytics: {
    messageIn: "resident_sms_message_in",
    messageOut: "resident_sms_message_out",
    actionProposed: "resident_sms_action_proposed",
  },
};

/**
 * The session is keyed on the OWNING MANAGER, verified resident user and phone:
 * one person renting from two managers holds two conversations, while a phone
 * later verified by a different user cannot inherit the prior user's history.
 */
export async function findOrCreateResidentSmsSession(
  db: Db,
  args: { landlordId: string; residentUserId: string; residentPhoneE164: string },
): Promise<ResidentSmsSessionRow | null> {
  return findOrCreateSmsAgentSession(db, {
    kind: SESSION_KIND,
    landlordId: args.landlordId,
    actorUserId: args.residentUserId,
    phoneE164: args.residentPhoneE164,
  });
}

/** ID-only Langfuse attribution; never include the resident phone or message. */
export function residentSmsTraceActor(
  ctx: ResidentAgentContext,
  ownerManagerUserId: string,
): TraceActor {
  return {
    userId: ctx.userId,
    metadata: {
      landlordId: ctx.landlordId,
      role: "resident",
      managerIds: [ownerManagerUserId],
      activeManagerId: ownerManagerUserId,
      channel: "sms",
    },
  };
}

/**
 * Run one resident-SMS turn. Returns null when suppressed (no API key, empty
 * body, hourly cap) so the caller can stay silent rather than send filler.
 *
 * `ctx` must come from `resolveResidentSmsAgentContext`. Passing a context built
 * any other way would hand the resident tool catalog to an unverified texter.
 */
export async function runResidentSmsAgentTurn(
  db: Db,
  args: {
    ctx: ResidentAgentContext;
    ownerManagerUserId: string;
    residentPhoneE164: string;
    inboundText: string;
    inboundMessageSid?: string | null;
  },
): Promise<ResidentSmsTurn | null> {
  if (args.ctx.activeManagerId !== args.ownerManagerUserId) {
    console.error("resident-sms turn refused: active manager mismatch", args.ctx.userId);
    return null;
  }
  return runSmsAgentTurn<ResidentAgentContext>(db, {
    ctx: args.ctx,
    surface: RESIDENT_SMS_SURFACE,
    registry: buildResidentRegistry(args.ctx),
    sessionLandlordId: args.ownerManagerUserId,
    phoneE164: args.residentPhoneE164,
    inboundText: args.inboundText,
    inboundMessageSid: args.inboundMessageSid,
    traceActor: residentSmsTraceActor(args.ctx, args.ownerManagerUserId),
    traceMetadata: {
      landlordId: args.ctx.landlordId,
      role: "resident",
      managerIds: [args.ownerManagerUserId],
      activeManagerId: args.ownerManagerUserId,
      channel: "sms",
    },
  });
}

/**
 * Send the resident agent's reply from the manager's work number.
 *
 * The conversation key uses role `resident` and the resident's USER ID as the
 * person ref, so this thread stays distinct from the prospect thread the same
 * phone may already own from before they applied.
 */
export async function deliverResidentSmsReply(args: {
  ownerManagerUserId: string;
  residentUserId: string;
  toPhone: string;
  text: string;
  workNumber?: string | null;
  inboundMessageSid?: string | null;
  traceId?: string | null;
}): Promise<import("@/lib/proplane-sms-transport.server").PropLaneSmsResult> {
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  const { buildConversationKey } = await import("@/lib/sms-conversation-identity");
  return sendFromManagerWorkNumber({
    managerUserId: args.ownerManagerUserId,
    to: args.toPhone,
    text: args.text,
    fromNumber: args.workNumber,
    source: "automated",
    counterpartyRole: "resident",
    residentUserId: args.residentUserId,
    conversationKey: buildConversationKey({
      ownerManagerUserId: args.ownerManagerUserId,
      role: "resident",
      counterpartyUserId: args.residentUserId,
      counterpartyPhone: args.toPhone,
    }),
    dedupeKey: args.inboundMessageSid?.trim()
      ? `inbound_reply_${args.inboundMessageSid.trim()}`
      : null,
    purpose: "manager_conversation",
    actorUserId: args.residentUserId,
    traceId: args.traceId,
  });
}
