import type { SupabaseClient } from "@supabase/supabase-js";
import { runManagerVoiceAgentTurn } from "@/lib/agent/manager-voice-agent.server";
import { runResidentVoiceAgentTurn } from "@/lib/agent/resident-voice-agent.server";
import { runLeasingVoiceAgentTurn } from "@/lib/agent/leasing-sms-agent.server";
import { normalizeE164 } from "@/lib/twilio";
import { upsertManagerSmsContact } from "@/lib/sms/manager-sms-contacts.server";
import { logVoiceCallTurnNotes } from "@/lib/voice/log-voice-call-notes.server";
import { normalizeVoiceConfirmationForAgentGate } from "@/lib/voice/voice-confirmation.server";
import {
  ensureManagerVoiceAgentContext,
  resolveVoiceCallRoute,
  voiceCallLogIdentity,
  type VoiceCallRoute,
} from "@/lib/voice/voice-call-routing.server";

const FALLBACK_REPLY =
  "Sorry, I could not process that right now. Please try again or text this number instead.";

async function touchSmsContact(
  db: SupabaseClient,
  args: { managerId: string; fromPhone: string; route: VoiceCallRoute },
): Promise<void> {
  const role =
    args.route.kind === "manager"
      ? "manager"
      : args.route.kind === "resident"
        ? "resident"
        : "prospect";
  if (args.route.kind === "manager") return;
  await upsertManagerSmsContact(db, {
    managerUserId: args.managerId,
    phone: args.fromPhone,
    counterpartyRole: role,
    lastInboundAt: new Date().toISOString(),
  }).catch(() => undefined);
}

export async function runVoiceCallTurnFromSpeech(args: {
  db: SupabaseClient;
  fromPhone: string;
  toPhone: string;
  speechResult: string;
  callSid: string;
}): Promise<string | null> {
  const resolved = await resolveVoiceCallRoute(args.db, {
    fromPhone: args.fromPhone,
    toPhone: args.toPhone,
  });
  if (!resolved.ok) return null;

  const { managerId, route } = resolved;
  await touchSmsContact(args.db, { managerId, fromPhone: args.fromPhone, route });

  const speech = normalizeVoiceConfirmationForAgentGate(args.speechResult);
  const callSid = args.callSid.trim();
  const fromE164 = normalizeE164(args.fromPhone) ?? args.fromPhone.trim();
  const logIdentity = voiceCallLogIdentity({
    managerId,
    workNumber: resolved.workNumber,
    fromPhone: args.fromPhone,
    route,
  });

  let reply: string | null = null;

  if (route.kind === "manager") {
    const managerIdentity = await ensureManagerVoiceAgentContext(args.db, route);
    if (!managerIdentity.ok) return null;
    const turn = await runManagerVoiceAgentTurn(args.db, {
      ctx: managerIdentity.ctx,
      managerPhoneE164: fromE164,
      inboundText: speech,
      inboundCallSid: callSid,
    });
    reply = turn?.reply?.trim() || null;
  } else if (route.kind === "resident") {
    const turn = await runResidentVoiceAgentTurn(args.db, {
      ctx: route.ctx,
      ownerManagerUserId: managerId,
      residentPhoneE164: fromE164,
      inboundText: speech,
      inboundCallSid: callSid,
    });
    reply = turn?.reply?.trim() || null;
  } else {
    const turn = await runLeasingVoiceAgentTurn(args.db, {
      landlordId: managerId,
      prospectPhoneE164: fromE164,
      inboundText: speech,
      workNumber: resolved.workNumber,
      inboundCallSid: callSid,
    });
    reply = turn?.reply?.trim() || null;
  }

  if (!reply) return null;

  await logVoiceCallTurnNotes(args.db, {
    ...logIdentity,
    callSid,
    spoken: args.speechResult,
    reply,
  });

  return reply;
}

export async function runVoiceCallTurnFromSpeechOrFallback(args: {
  db: SupabaseClient;
  fromPhone: string;
  toPhone: string;
  speechResult: string;
  callSid: string;
}): Promise<string> {
  const reply = await runVoiceCallTurnFromSpeech(args);
  return reply?.trim() || FALLBACK_REPLY;
}
