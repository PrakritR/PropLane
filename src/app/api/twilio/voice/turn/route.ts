import { fundedVoiceGather, findVoiceCallPayer } from "@/lib/comms-billing/voice-credit.server";
import { settleCommsCreditQuantity } from "@/lib/comms-billing/wallet.server";
import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { createHash } from "node:crypto";
import { classifySharedLineKeyword, emergencyReplyFor } from "@/lib/one-number/keywords";
import {
  isManagerVoiceAgentEnabled,
  isVoiceRecordingEnabled,
  resolveVoiceRecordingWebhookUrl,
  resolveVoiceTurnWebhookUrl,
  truncateForVoiceSpeech,
  twimlDialEscalation,
  resolveVoiceWhisperWebhookUrl,
  twimlGoodbye,
  twimlHangup,
  twimlResponse,
  twimlSay,
  twimlStartRecording,
  validateTwilioVoiceWebhook,
} from "@/lib/twilio-voice.server";
import { callerWantsHuman, transferUnavailablePrompt } from "@/lib/voice/voice-transfer.server";
import {
  callerIsFrustrated,
  escalationSummaryText,
  mayRingNow,
  resolveEscalationTarget,
  sendEscalationSummary,
  escalationIsUrgent,
  type EscalationReason,
} from "@/lib/voice/voice-escalation.server";
import { loadVoiceCallTranscript } from "@/lib/voice/voice-call-summary.server";
import { logVoiceCallStarted, logVoiceCallTurnNotes } from "@/lib/voice/log-voice-call-notes.server";
import {
  MANAGER_VOICE_UNCONFIGURED_PROMPT,
  resolveVoiceCallRoute,
  voiceCallLogIdentity,
  voiceGreetingForRoute,
} from "@/lib/voice/voice-call-routing.server";
import { queueBrowseLinkForCall, runVoiceCallTurn, VOICE_TURN_FALLBACK_REPLY } from "@/lib/voice/voice-call-turn.server";
import { loadCallOfferedPages } from "@/lib/voice/voice-call-links.server";
import { spokenConsentGranted } from "@/lib/voice/voice-confirmation.server";
import {
  MAX_SILENT_ATTEMPTS,
  VOICE_CONSENT_REASK,
  VOICE_DECLINED_GOODBYE,
  VOICE_REPROMPT,
  VOICE_UNREACHABLE,
  callerIsDone,
  spokenConsentDeclined,
  spokenConsentGivenLoosely,
} from "@/lib/voice/voice-call-flow";

export const runtime = "nodejs";
export const maxDuration = 60;

type Phase = "consent" | "agent" | "escalation";

function phaseFromRequest(req: Request): Phase {
  const phase = new URL(req.url).searchParams.get("phase");
  return phase === "consent" ? "consent" : phase === "escalation" ? "escalation" : "agent";
}

const REASONS: readonly EscalationReason[] = ["asked_for_person", "cannot_answer", "emergency", "frustrated", "misunderstood"];

/** How long a person's phone rings before the assistant takes the call back. */
const ESCALATION_RING_SECONDS = 20;
const CALLBACK_PROMISE = "They're not available right now. I'll have them call you back.";
const OFFLINE_PROMISE = "Our team is offline right now. I'll have them call you back first thing.";
const NOBODY_PROMISE = "I can't reach anyone right now, but I'll make sure the team gets your message.";

/**
 * One turn of the call. Silence is handled here: Twilio hands a silent Gather back through the Redirect with `attempt` one
 * higher, so the caller is re-asked once and then told goodbye (and still texted the pages already offered) instead of the
 * line going dead.
 */
export async function POST(req: Request) {
  const phase = phaseFromRequest(req);
  const search = new URL(req.url).searchParams;
  const turnId = search.get("turn") ?? "legacy";
  if (!/^(?:[a-f0-9]{32}|legacy)$/.test(turnId)) return NextResponse.json({ error: "Invalid turn." }, { status: 400 });
  const attempt = Math.min(5, Math.max(0, Number.parseInt(search.get("attempt") ?? "0", 10) || 0));
  const reasonParam = search.get("reason") ?? "";
  const reason = (REASONS as readonly string[]).includes(reasonParam) ? (reasonParam as EscalationReason) : undefined;
  const raw = await req.text();
  const validated = validateTwilioVoiceWebhook(req, raw, resolveVoiceTurnWebhookUrl(phase, turnId === "legacy" ? undefined : turnId, attempt, reasonParam || undefined));
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

  const resolved = await resolveVoiceCallRoute(db, { fromPhone, toPhone, callSid, speech });
  if (!resolved.ok) return twimlResponse(twimlSay(MANAGER_VOICE_UNCONFIGURED_PROMPT) + twimlHangup());
  if (resolved.route.kind === "redirect") return twimlResponse(twimlGoodbye(resolved.route.reply));

  // Whoever holds this call's minutes also pays for each recognition. Nobody holding them means the call was never funded.
  const payer = await findVoiceCallPayer(db, resolved.billing, callSid).catch(() => null);
  if (!payer) return twimlResponse(twimlGoodbye("This number cannot take calls right now. Please try again later."));
  const gather = (prompt: string, nextPhase: "consent" | "agent" = "agent", silentAttempt = 0, withTurnId = turnId) =>
    fundedVoiceGather(db, {
      owner: payer.ownerId,
      workspaceId: payer.workspaceId,
      allowUnfunded: payer.allowUnfunded,
      callSid,
      turnId: withTurnId,
      phase: nextPhase,
      prompt,
      attempt: silentAttempt,
    });
  const logIdentity = voiceCallLogIdentity({
    managerId: resolved.managerId,
    workNumber: resolved.workNumber,
    fromPhone,
    route: resolved.route,
    workspaceId: resolved.workspaceId,
  });
  const goodbyeFor = async () => {
    const pages = await loadCallOfferedPages(db, { managerUserId: resolved.managerId, callSid }).catch(() => []);
    return pages.length > 0 ? "Thanks for calling PropLane. I will text you those links now. Goodbye." : "Thanks for calling PropLane. Goodbye.";
  };


  const callerKind = resolved.route.kind === "resident" ? "resident" : resolved.route.kind === "manager" ? "manager" : "prospect";
  const gistOf = async (spoken: string) => {
    if (spoken) return spoken;
    const lines = await loadVoiceCallTranscript(db, { managerUserId: resolved.managerId, callSid }).catch(() => []);
    return lines.filter((l) => l.direction === "inbound").map((l) => l.body).slice(-2).join(" ");
  };
  /**
   * Bring in a person: say so, ring the right one for a short time, and let the assistant take the call back if they do not
   * answer. Quiet hours turn a routine escalation into a call-back; an emergency always rings. Never for the manager's own call.
   */
  const escalate = async (why: EscalationReason, spoken: string, lead = ""): Promise<Response> => {
    if (resolved.route.kind === "manager") return twimlResponse(twimlSay(transferUnavailablePrompt("caller_is_manager")) + (await gather("What can I help with?")));
    const safety = why === "emergency" ? `${twimlSay(emergencyReplyFor(spoken))}` : "";
    const target = await resolveEscalationTarget(db, { resolved, callerPhone: fromPhone }).catch(() => null);
    const callbackNote = (note: string) => logVoiceCallTurnNotes(db, { ...logIdentity, callSid, spoken, reply: note });
    const text = escalationSummaryText({ callerPhone: fromPhone, callerKind, gist: await gistOf(spoken), reason: why });
    if (!target) {
      await callbackNote("No one was reachable to take the call; the team was left a message.");
      return twimlResponse(`${lead}${safety}${twimlSay(NOBODY_PROMISE)}${await gather("Is there anything else I can help with?")}`);
    }
    if (!mayRingNow(why)) {
      await callbackNote(`Outside calling hours: ${target.firstName ?? "the team"} was texted to call the caller back.`);
      await sendEscalationSummary(db, { resolved, target, callSid, text, urgent: false });
      return twimlResponse(`${lead}${twimlSay(OFFLINE_PROMISE)}${await gather("Is there anything else I can help with?")}`);
    }
    await callbackNote(`Connecting the caller to ${target.firstName ?? "the manager"}.`);
    const nextTurn = createHash("sha256").update(`${callSid}:${turnId}:esc`).digest("hex").slice(0, 32);
    return twimlResponse(
      `${lead}${safety}${twimlSay(`One moment, connecting you to ${target.firstName ?? "the manager"}.`)}` +
        twimlDialEscalation({
          toPhone: target.toPhone,
          callerId: resolved.workNumber,
          actionUrl: resolveVoiceTurnWebhookUrl("escalation", nextTurn, 0, why),
          whisperUrl: resolveVoiceWhisperWebhookUrl(callerKind),
          timeoutSeconds: ESCALATION_RING_SECONDS,
        }),
    );
  };

  if (phase === "escalation") {
    // The ring ended. A bridged call that finished is over; an unanswered one comes back to the assistant.
    const dialStatus = String(validated.params.DialCallStatus ?? "").toLowerCase();
    if (dialStatus === "completed" || dialStatus === "answered") return twimlResponse(twimlHangup());
    const why = reason ?? "asked_for_person";
    const target = await resolveEscalationTarget(db, { resolved, callerPhone: fromPhone }).catch(() => null);
    const spoken = await gistOf("");
    await logVoiceCallTurnNotes(db, { ...logIdentity, callSid, spoken: "", reply: `${target?.firstName ?? "The manager"} did not answer (${dialStatus || "no answer"}); a call-back was requested.` });
    if (target) await sendEscalationSummary(db, { resolved, target, callSid, text: escalationSummaryText({ callerPhone: fromPhone, callerKind, gist: spoken, reason: why }), urgent: escalationIsUrgent(why) });
    return twimlResponse(twimlSay(CALLBACK_PROMISE) + (await gather("Is there anything else I can help with?", "agent", 0, turnId)));
  }

  if (phase === "consent") {
    const granted = spokenConsentGranted(speech) || spokenConsentGivenLoosely(speech);
    if (!granted) {
      // Silence or an unclear answer is not a no: ask once more. Only an actual refusal, or a second miss, ends the call.
      if (!spokenConsentDeclined(speech) && attempt < MAX_SILENT_ATTEMPTS - 1) {
        return twimlResponse(await gather(VOICE_CONSENT_REASK, "consent", attempt + 1));
      }
      try {
        await settleCommsCreditQuantity(db, payer.ownerId, `voice_recording_minute:${callSid}`, 0);
      } catch {
        return NextResponse.json({ error: "Recording credit settlement unavailable." }, { status: 503 });
      }
      return twimlResponse(twimlGoodbye(VOICE_DECLINED_GOODBYE));
    }
    await logVoiceCallStarted(db, { ...logIdentity, callSid });
    const recordingXml = isVoiceRecordingEnabled() ? twimlStartRecording(resolveVoiceRecordingWebhookUrl()) : "";
    return twimlResponse(`${recordingXml}${await gather(`Thanks. ${voiceGreetingForRoute(resolved.route)}`)}`);
  }

  if (!speech) {
    // Twilio sends silence back here with attempt + 1: one re-ask, then a goodbye that still texts what was offered.
    if (attempt >= MAX_SILENT_ATTEMPTS) {
      // A caller who keeps going unheard is handed to a person when one can be rung; otherwise the call ends politely.
      if (resolved.route.kind !== "manager" && mayRingNow("misunderstood") && (await resolveEscalationTarget(db, { resolved, callerPhone: fromPhone }).catch(() => null))) return escalate("misunderstood", "");
      return twimlResponse(twimlGoodbye(await goodbyeFor()));
    }
    return twimlResponse(await gather(attempt === 0 ? voiceGreetingForRoute(resolved.route) : VOICE_REPROMPT, "agent", attempt));
  }

  // An ambiguous caller who has said nothing that settles it is asked again, once; after that a teammate follows up by text.
  if (resolved.route.kind === "ambiguous") {
    if (attempt >= 1) return twimlResponse(twimlGoodbye("I could not tell which home you mean. A teammate will text you. Goodbye."));
    return twimlResponse(await gather(`${resolved.route.question.replace(/^Is this about /, "Is this about ")}`, "agent", 1));
  }

  if (callerIsDone(speech)) return twimlResponse(twimlGoodbye(await goodbyeFor()));

  // Checked before the model runs, so the caller is not made to argue with an assistant to reach a person (or to be heard in an emergency).
  if (classifySharedLineKeyword(speech) === "EMERGENCY") return escalate("emergency", speech);
  if (callerWantsHuman(speech) || classifySharedLineKeyword(speech) === "HUMAN") return escalate("asked_for_person", speech);
  if (callerIsFrustrated(speech)) return escalate("frustrated", speech);

  const turn = await runVoiceCallTurn({ db, resolved, payer, fromPhone, speechResult: speech, callSid, turnId });
  if (turn.reply === null) {
    // The agent had nothing: a person is tried first; failing that a prospect is promised a text and gets the browse page after
    // the call, and anyone else is pointed at texting.
    if (mayRingNow("cannot_answer") && (await resolveEscalationTarget(db, { resolved, callerPhone: fromPhone }).catch(() => null))) return escalate("cannot_answer", speech);
    if (resolved.route.kind === "prospect") {
      await queueBrowseLinkForCall(db, resolved, fromPhone, callSid);
      return twimlResponse(twimlGoodbye(VOICE_UNREACHABLE));
    }
    return twimlResponse(twimlGoodbye(VOICE_TURN_FALLBACK_REPLY));
  }

  // The agent itself handed the question to a person: it says so, then the call is bridged.
  if (turn.needsHuman && resolved.route.kind !== "manager") return escalate("cannot_answer", speech, twimlSay(truncateForVoiceSpeech(turn.reply)));

  return twimlResponse(`${twimlSay(truncateForVoiceSpeech(turn.reply))}${await gather("Anything else?")}`);
}
