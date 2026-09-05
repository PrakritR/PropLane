/**
 * Resident voice agent — same tool catalog and confirm gate as resident SMS.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildResidentRegistry } from "@/lib/tools/resident-index";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { PROMPT_IDS } from "@/lib/agent/prompt-metadata";
import { RESIDENT_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import {
  resolveResidentWorkOrderReference,
  workOrderReferencePromptContext,
} from "@/lib/tools/work-order-reference-resolution";
import { resolveWorkOrderReference } from "@/lib/work-order-reference";
import {
  runSmsAgentTurn,
  type SmsAgentSurface,
  type SmsAgentTurn,
} from "@/lib/agent/sms-agent-turn.server";
import { residentSmsTraceActor } from "@/lib/agent/resident-sms-agent.server";
import { renderPreviewForVoice } from "@/lib/voice/voice-confirmation.server";

const VOICE_ADDENDUM =
  "You are speaking on a phone call, not texting. Keep replies concise and easy to hear. " +
  "Never read full account numbers aloud; offer to send details by text when needed.";

const RESIDENT_VOICE_SURFACE: SmsAgentSurface = {
  sessionKind: "resident_sms",
  portal: "resident",
  basePrompt: `${RESIDENT_SMS_AGENT_SYSTEM_PROMPT}\n\n${VOICE_ADDENDUM}`,
  promptId: PROMPT_IDS.residentSmsAgent,
  traceName: "resident-voice-agent-turn",
  analytics: {
    messageIn: "resident_voice_message_in",
    messageOut: "resident_voice_message_out",
    actionProposed: "resident_voice_action_proposed",
  },
  maxReplyChars: 900,
  messageChannel: "voice",
};

export type ResidentVoiceTurn = SmsAgentTurn;

export async function runResidentVoiceAgentTurn(
  db: SupabaseClient,
  args: {
    ctx: ResidentAgentContext;
    ownerManagerUserId: string;
    residentPhoneE164: string;
    inboundText: string;
    inboundCallSid?: string | null;
  },
): Promise<ResidentVoiceTurn | null> {
  if (args.ctx.activeManagerId !== args.ownerManagerUserId) {
    console.error("resident-voice turn refused: active manager mismatch", args.ctx.userId);
    return null;
  }

  const referenceResolution = resolveWorkOrderReference(args.inboundText).length
    ? await resolveResidentWorkOrderReference(args.ctx, args.inboundText)
    : null;

  return runSmsAgentTurn<ResidentAgentContext>(db, {
    ctx: args.ctx,
    surface: RESIDENT_VOICE_SURFACE,
    registry: buildResidentRegistry(args.ctx),
    sessionLandlordId: args.ownerManagerUserId,
    phoneE164: args.residentPhoneE164,
    inboundText: args.inboundText,
    inboundMessageSid: args.inboundCallSid?.trim() || null,
    precomputedReply:
      referenceResolution?.kind === "not_found" || referenceResolution?.kind === "ambiguous"
        ? referenceResolution.message
        : null,
    additionalSystemContext: referenceResolution
      ? workOrderReferencePromptContext(referenceResolution)
      : null,
    traceActor: {
      ...residentSmsTraceActor(args.ctx, args.ownerManagerUserId),
      metadata: {
        ...residentSmsTraceActor(args.ctx, args.ownerManagerUserId).metadata,
        channel: "voice",
      },
    },
    traceMetadata: {
      landlordId: args.ctx.landlordId,
      role: "resident",
      managerIds: [args.ownerManagerUserId],
      activeManagerId: args.ownerManagerUserId,
      channel: "voice",
      callSid: args.inboundCallSid ?? undefined,
      workOrderReference:
        referenceResolution?.kind === "resolved"
          ? referenceResolution.candidates[0].reference
          : undefined,
    },
    renderActionPreview: renderPreviewForVoice,
  });
}
