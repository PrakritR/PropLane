import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  isManagerVoiceAgentEnabled,
  isVoiceRecordingEnabled,
  resolveVoiceRecordingWebhookUrl,
  resolveVoiceTurnWebhookUrl,
  truncateForVoiceSpeech,
  twimlGatherSpeech,
  twimlHangup,
  twimlResponse,
  twimlSay,
  twimlStartRecording,
  validateTwilioVoiceWebhook,
} from "@/lib/twilio-voice.server";
import { logVoiceCallStarted } from "@/lib/voice/log-voice-call-notes.server";
import {
  MANAGER_VOICE_UNCONFIGURED_PROMPT,
  resolveVoiceCallRoute,
  voiceCallLogIdentity,
  voiceGreetingForRoute,
} from "@/lib/voice/voice-call-routing.server";
import { runVoiceCallTurnFromSpeechOrFallback } from "@/lib/voice/voice-call-turn.server";
import { spokenConsentGranted } from "@/lib/voice/voice-confirmation.server";

export const runtime = "nodejs";
export const maxDuration = 60;

function phaseFromRequest(req: Request): "consent" | "agent" {
  const phase = new URL(req.url).searchParams.get("phase");
  return phase === "consent" ? "consent" : "agent";
}

export async function POST(req: Request) {
  const phase = phaseFromRequest(req);
  const raw = await req.text();
  const validated = validateTwilioVoiceWebhook(req, raw, resolveVoiceTurnWebhookUrl(phase));
  if (!validated.ok) {
    return NextResponse.json({ error: validated.message }, { status: validated.status });
  }

  const fromPhone = String(validated.params.From ?? "").trim();
  const toPhone = String(validated.params.To ?? "").trim();
  const callSid = String(validated.params.CallSid ?? "").trim();
  const speech = String(validated.params.SpeechResult ?? validated.params.UnstableSpeechResult ?? "").trim();

  if (!fromPhone || !toPhone || !callSid) {
    return twimlResponse(twimlSay("Goodbye.") + twimlHangup());
  }

  if (!isManagerVoiceAgentEnabled()) {
    return twimlResponse(twimlSay("Voice assistant is disabled.") + twimlHangup());
  }

  const db = createSupabaseServiceRoleClient();

  if (phase === "consent") {
    if (!spokenConsentGranted(speech)) {
      return twimlResponse(twimlSay("No problem. Goodbye.") + twimlHangup());
    }
    const resolved = await resolveVoiceCallRoute(db, { fromPhone, toPhone });
    if (!resolved.ok) {
      return twimlResponse(twimlSay(MANAGER_VOICE_UNCONFIGURED_PROMPT) + twimlHangup());
    }
    const logIdentity = voiceCallLogIdentity({
      managerId: resolved.managerId,
      workNumber: resolved.workNumber,
      fromPhone,
      route: resolved.route,
    });
    await logVoiceCallStarted(db, { ...logIdentity, callSid });
    const recordingXml = isVoiceRecordingEnabled()
      ? twimlStartRecording(resolveVoiceRecordingWebhookUrl())
      : "";
    return twimlResponse(
      `${recordingXml}${twimlGatherSpeech({
        actionUrl: resolveVoiceTurnWebhookUrl("agent"),
        prompt: `Thanks. ${voiceGreetingForRoute(resolved.route)}`,
      })}`,
    );
  }

  if (!speech) {
    const resolved = await resolveVoiceCallRoute(db, { fromPhone, toPhone });
    const reprompt = resolved.ok
      ? voiceGreetingForRoute(resolved.route)
      : "I did not catch that. Please try again.";
    return twimlResponse(
      twimlGatherSpeech({
        actionUrl: resolveVoiceTurnWebhookUrl("agent"),
        prompt: reprompt,
      }),
    );
  }

  const resolved = await resolveVoiceCallRoute(db, { fromPhone, toPhone });
  if (!resolved.ok) {
    return twimlResponse(twimlSay(MANAGER_VOICE_UNCONFIGURED_PROMPT) + twimlHangup());
  }

  const reply = await runVoiceCallTurnFromSpeechOrFallback({
    db,
    fromPhone,
    toPhone,
    speechResult: speech,
    callSid,
  });

  const spoken = truncateForVoiceSpeech(reply);
  return twimlResponse(
    `${twimlSay(spoken)}${twimlGatherSpeech({
      actionUrl: resolveVoiceTurnWebhookUrl("agent"),
      prompt: "Anything else?",
    })}`,
  );
}
