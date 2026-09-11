import { reserveBoundedVoiceCall, fundedVoiceGather, VOICE_CREDIT_UNAVAILABLE } from "@/lib/comms-billing/voice-credit.server";
import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  isManagerVoiceAgentEnabled,
  isVoiceRecordingEnabled,
  resolveVoiceInboundWebhookUrl,
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

  const funded = await reserveBoundedVoiceCall(db, resolved.managerId, callSid).catch(() => false);
  if (!funded) return twimlResponse(twimlSay(VOICE_CREDIT_UNAVAILABLE) + twimlHangup());
  if (isVoiceRecordingEnabled()) {
    return twimlResponse(await fundedVoiceGather(db, { owner: resolved.managerId, callSid, turnId: "start", phase: "consent", prompt: CONSENT_PROMPT }));
  }

  const logIdentity = voiceCallLogIdentity({
    managerId: resolved.managerId,
    workNumber: resolved.workNumber,
    fromPhone,
    route: resolved.route,
  });
  await logVoiceCallStarted(db, { ...logIdentity, callSid });

  return twimlResponse(await fundedVoiceGather(db, { owner: resolved.managerId, callSid, turnId: "start", phase: "agent", prompt: voiceGreetingForRoute(resolved.route) }));
}
