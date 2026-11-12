import {
  fundedVoiceGather,
  reserveVoiceCallFunding,
  VOICE_CREDIT_UNAVAILABLE,
} from "@/lib/comms-billing/voice-credit.server";
import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  isManagerVoiceAgentEnabled,
  isVoiceRecordingEnabled,
  resolveVoiceInboundWebhookUrl,
  twimlGoodbye,
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
import { VOICE_CONSENT_PROMPT, VOICE_DISABLED_PROMPT } from "@/lib/voice/voice-call-flow";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * A call comes in. In order: the signature (fail closed on Vercel), the kill switch (`MANAGER_VOICE_AGENT_ENABLED`), the
 * route (the same decision an inbound text gets), the funding (the workspace's wallet, then PropLane's on a PropLane-run
 * line), the recording-consent line when recording is on, and then the first speech Gather.
 */
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
    return twimlResponse(twimlSay(VOICE_DISABLED_PROMPT) + twimlHangup());
  }

  const db = createSupabaseServiceRoleClient();
  const resolved = await resolveVoiceCallRoute(db, { fromPhone, toPhone, callSid });
  if (!resolved.ok) {
    return twimlResponse(twimlSay(MANAGER_VOICE_UNCONFIGURED_PROMPT) + twimlHangup());
  }
  // A caller with nothing for an agent to do (a workspace with its own number, a vendor) is told so and the call ends.
  if (resolved.route.kind === "redirect") return twimlResponse(twimlGoodbye(resolved.route.reply));

  const payer = await reserveVoiceCallFunding(db, resolved.billing, callSid).catch(() => null);
  if (!payer) return twimlResponse(twimlSay(VOICE_CREDIT_UNAVAILABLE) + twimlHangup());
  const gather = (phase: "consent" | "agent", prompt: string) =>
    fundedVoiceGather(db, { owner: payer.ownerId, workspaceId: payer.workspaceId, allowUnfunded: payer.allowUnfunded, callSid, turnId: "start", phase, prompt });

  // Consent comes BEFORE anything is recorded: the recording starts only in the turn that hears a yes.
  if (isVoiceRecordingEnabled()) return twimlResponse(await gather("consent", VOICE_CONSENT_PROMPT));

  await logVoiceCallStarted(db, {
    ...voiceCallLogIdentity({ managerId: resolved.managerId, workNumber: resolved.workNumber, fromPhone, route: resolved.route, workspaceId: resolved.workspaceId }),
    callSid,
  });
  return twimlResponse(await gather("agent", voiceGreetingForRoute(resolved.route)));
}
