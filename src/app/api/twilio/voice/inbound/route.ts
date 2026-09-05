import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  isManagerVoiceAgentEnabled,
  isVoiceRecordingEnabled,
  resolveVoiceInboundWebhookUrl,
  resolveVoiceTurnWebhookUrl,
  twimlGatherSpeech,
  twimlHangup,
  twimlResponse,
  twimlSay,
  validateTwilioVoiceWebhook,
} from "@/lib/twilio-voice.server";
import { logVoiceCallStarted } from "@/lib/voice/log-voice-call-notes.server";
import {
  MANAGER_VOICE_UNCONFIGURED_PROMPT,
  resolveVoiceCallRoute,
  voiceCallLogIdentity,
  voiceGreetingForRoute,
} from "@/lib/voice/voice-call-routing.server";

export const runtime = "nodejs";
export const maxDuration = 60;

const CONSENT_PROMPT =
  "This call may be recorded to improve PropLane. Say yes to continue, or hang up to decline.";
const DISABLED_PROMPT =
  "The voice assistant is not enabled yet. Please text this number, or try again later.";

export async function POST(req: Request) {
  const raw = await req.text();
  const validated = validateTwilioVoiceWebhook(req, raw, resolveVoiceInboundWebhookUrl());
  if (!validated.ok) {
    return NextResponse.json({ error: validated.message }, { status: validated.status });
  }

  const fromPhone = String(validated.params.From ?? "").trim();
  const toPhone = String(validated.params.To ?? "").trim();
  const callSid = String(validated.params.CallSid ?? "").trim();
  if (!fromPhone || !toPhone || !callSid) {
    return twimlResponse(twimlSay("Goodbye.") + twimlHangup());
  }

  if (!isManagerVoiceAgentEnabled()) {
    return twimlResponse(twimlSay(DISABLED_PROMPT) + twimlHangup());
  }

  const db = createSupabaseServiceRoleClient();
  const resolved = await resolveVoiceCallRoute(db, { fromPhone, toPhone });
  if (!resolved.ok) {
    return twimlResponse(twimlSay(MANAGER_VOICE_UNCONFIGURED_PROMPT) + twimlHangup());
  }

  if (isVoiceRecordingEnabled()) {
    return twimlResponse(
      twimlGatherSpeech({
        actionUrl: resolveVoiceTurnWebhookUrl("consent"),
        prompt: CONSENT_PROMPT,
      }),
    );
  }

  const logIdentity = voiceCallLogIdentity({
    managerId: resolved.managerId,
    workNumber: resolved.workNumber,
    fromPhone,
    route: resolved.route,
  });
  await logVoiceCallStarted(db, { ...logIdentity, callSid });

  return twimlResponse(
    twimlGatherSpeech({
      actionUrl: resolveVoiceTurnWebhookUrl("agent"),
      prompt: voiceGreetingForRoute(resolved.route),
    }),
  );
}
