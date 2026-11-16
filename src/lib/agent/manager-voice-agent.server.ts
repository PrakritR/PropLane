/**
 * Manager voice agent — same tool catalog and confirm gate as manager SMS,
 * with spoken replies instead of texted ones.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildManagerSmsRegistry } from "@/lib/tools";
import type { AgentContext } from "@/lib/tools/context";
import { PROMPT_IDS } from "@/lib/agent/prompt-metadata";
import { MANAGER_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { managerSmsScopePrompt } from "@/lib/sms/manager-sms-access";
import {
  resolveManagerWorkOrderReference,
  workOrderReferencePromptContext,
} from "@/lib/tools/work-order-reference-resolution";
import { resolveWorkOrderReference } from "@/lib/work-order-reference";
import type { TraceActor } from "@/lib/observability/langfuse";
import {
  runSmsAgentTurn,
  type SmsAgentSurface,
  type SmsAgentTurn,
} from "@/lib/agent/sms-agent-turn.server";
import { renderPreviewForVoice } from "@/lib/voice/voice-confirmation.server";

type Db = SupabaseClient;

export type ManagerVoiceTurn = SmsAgentTurn;

const VOICE_ADDENDUM =
  "You are speaking on a phone call, not texting. Keep replies concise and easy to hear. " +
  "When offering tour times, read at most three options unless asked for more. " +
  "Always call list_open_tour_slots before quoting availability. " +
  "Calls are read-only: you cannot change, send, schedule or approve anything by voice. " +
  "For any change, tell the caller to use the portal or to text this number.";

const MANAGER_VOICE_SURFACE: SmsAgentSurface = {
  sessionKind: "manager_voice",
  portal: "manager",
  basePrompt: `${MANAGER_SMS_AGENT_SYSTEM_PROMPT}\n\n${VOICE_ADDENDUM}`,
  promptId: PROMPT_IDS.managerVoiceAgent,
  traceName: "manager-voice-agent-turn",
  analytics: {
    messageIn: "manager_voice_message_in",
    messageOut: "manager_voice_message_out",
    actionProposed: "manager_voice_action_proposed",
  },
  // Voice is read-only: no write tool is ever proposed on a call (see the registry below).
  allowWriteTools: [],
  maxReplyChars: 900,
  messageChannel: "voice",
};

export function managerVoiceTraceActor(ctx: AgentContext): TraceActor {
  return {
    userId: ctx.userId,
    metadata: {
      landlordId: ctx.landlordId,
      role: "manager",
      managerIds: [...new Set([ctx.landlordId, ctx.userId])],
      activeManagerId: ctx.landlordId,
      channel: "voice",
      smsAccessMode: ctx.managerSmsAccess?.mode ?? "owner",
    },
  };
}

export async function runManagerVoiceAgentTurn(
  db: Db,
  args: {
    ctx: AgentContext;
    managerPhoneE164: string;
    inboundText: string;
    inboundCallSid?: string | null;
  },
): Promise<ManagerVoiceTurn | null> {
  const access = args.ctx.managerSmsAccess;
  const scopeNote = access ? managerSmsScopePrompt(access) : "";
  const surface: SmsAgentSurface = scopeNote
    ? { ...MANAGER_VOICE_SURFACE, basePrompt: `${MANAGER_VOICE_SURFACE.basePrompt}\n\n${scopeNote}` }
    : MANAGER_VOICE_SURFACE;
  const referenceResolution = resolveWorkOrderReference(args.inboundText).length
    ? await resolveManagerWorkOrderReference(args.ctx, args.inboundText)
    : null;

  const turn = await runSmsAgentTurn<AgentContext>(db, {
    ctx: args.ctx,
    surface,
    // Caller ID (Twilio `From`) is spoofable and a call has no second factor, so a manager/admin identity resolved
    // from it may READ but never write: the manager SMS registry with every write tool withheld.
    registry: buildManagerSmsRegistry(access, { readOnly: true }),
    sessionLandlordId: args.ctx.landlordId,
    phoneE164: args.managerPhoneE164,
    inboundText: args.inboundText,
    inboundMessageSid: args.inboundCallSid?.trim() || null,
    precomputedReply:
      referenceResolution?.kind === "not_found" || referenceResolution?.kind === "ambiguous"
        ? referenceResolution.message
        : null,
    additionalSystemContext: referenceResolution
      ? workOrderReferencePromptContext(referenceResolution)
      : null,
    traceActor: managerVoiceTraceActor(args.ctx),
    traceMetadata: {
      landlordId: args.ctx.landlordId,
      role: "manager",
      managerIds: [...new Set([args.ctx.landlordId, args.ctx.userId])],
      activeManagerId: args.ctx.landlordId,
      channel: "voice",
      smsAccessMode: access?.mode ?? "owner",
      callSid: args.inboundCallSid ?? undefined,
      workOrderReference:
        referenceResolution?.kind === "resolved"
          ? referenceResolution.candidates[0].reference
          : undefined,
    },
    renderActionPreview: renderPreviewForVoice,
  });

  return turn;
}
