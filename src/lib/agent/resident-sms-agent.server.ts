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
import { residentSendMyLinkTool, withSendMyLinkTool } from "@/lib/tools/domains/one-number-links";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { PROMPT_IDS } from "@/lib/agent/prompt-metadata";
import { RESIDENT_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import type { TraceActor } from "@/lib/observability/langfuse";
import {
  resolveResidentWorkOrderReference,
  workOrderReferencePromptContext,
} from "@/lib/tools/work-order-reference-resolution";
import { resolveWorkOrderReference } from "@/lib/work-order-reference";
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
    residentPhoneE164?: string | null;
    inboundText: string;
    inboundMessageSid?: string | null;
    testActor?: { userId: string; managerUserId: string; sessionKind: string; sessionId?: string | null; targetListingId: string };
  },
): Promise<ResidentSmsTurn | null> {
  if (args.ctx.activeManagerId !== args.ownerManagerUserId) {
    console.error("resident-sms turn refused: active manager mismatch", args.ctx.userId);
    return null;
  }
  const referenceResolution = resolveWorkOrderReference(args.inboundText).length
    ? await resolveResidentWorkOrderReference(args.ctx, args.inboundText)
    : null;
  return runSmsAgentTurn<ResidentAgentContext>(db, {
    ctx: args.ctx,
    surface: RESIDENT_SMS_SURFACE,
    // "send my rent link" exists only while the line is shared (one-number build).
    registry: await withSendMyLinkTool(db, buildResidentRegistry(args.ctx), residentSendMyLinkTool),
    sessionLandlordId: args.ownerManagerUserId,
    phoneE164: args.residentPhoneE164,
    inboundText: args.inboundText,
    inboundMessageSid: args.inboundMessageSid,
    testActor: args.testActor ? { ...args.testActor, mode: "resident" } : undefined,
    precomputedReply:
      referenceResolution?.kind === "not_found" || referenceResolution?.kind === "ambiguous"
        ? referenceResolution.message
        : null,
    additionalSystemContext: referenceResolution
      ? workOrderReferencePromptContext(referenceResolution)
      : null,
    traceActor: residentSmsTraceActor(args.ctx, args.ownerManagerUserId),
    traceMetadata: {
      landlordId: args.ctx.landlordId,
      role: "resident",
      managerIds: [args.ownerManagerUserId],
      activeManagerId: args.ownerManagerUserId,
      channel: "sms",
      workOrderReference:
        referenceResolution?.kind === "resolved"
          ? referenceResolution.candidates[0].reference
          : undefined,
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
  /** Delivery feel (shared line): the workspace names the bubble setting; `bubbles` skips the lookup. */
  workspaceId?: string | null;
  bubbles?: boolean;
  /** The text being answered (an emoji in it lets the reply keep its own). */
  inboundText?: string | null;
  /** Extra idempotency suffix for a second message answering the same inbound (the work ack). */
  dedupeSuffix?: string;
}): Promise<import("@/lib/proplane-sms-transport.server").PropLaneSmsResult> {
  const { sendFromManagerWorkNumber } = await import("@/lib/proplane-sms-transport.server");
  const { buildConversationKey } = await import("@/lib/sms-conversation-identity");
  const { toGsm7 } = await import("@/lib/one-number/segments");
  const { redactedInboundReplyOverride } = await import("@/lib/one-number/redact-reply.server");
  const { deliverAgentReply, bubbleDedupeKey } = await import("@/lib/one-number/bubble-delivery.server");
  // Segment guard: a curly quote or emoji would bill this reply as UCS-2.
  const text = toGsm7((await redactedInboundReplyOverride(args.inboundMessageSid)) ?? args.text);
  const baseKey = args.inboundMessageSid?.trim()
    ? `inbound_reply_${args.inboundMessageSid.trim()}${args.dedupeSuffix ?? ""}`
    : null;
  return deliverAgentReply({
    workspaceId: args.workspaceId,
    bubbles: args.bubbles,
    text,
    inboundText: args.inboundText,
    send: (bubble, index) =>
      sendFromManagerWorkNumber({
        managerUserId: args.ownerManagerUserId,
        to: args.toPhone,
        text: bubble,
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
        dedupeKey: bubbleDedupeKey(baseKey, index),
        purpose: "manager_conversation",
        actorUserId: args.residentUserId,
        traceId: args.traceId,
      }),
  });
}
