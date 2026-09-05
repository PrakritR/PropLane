import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  resolveVoiceStatusWebhookUrl,
  validateTwilioVoiceWebhook,
} from "@/lib/twilio-voice.server";
import { resolveVoiceCallRoute } from "@/lib/voice/voice-call-routing.server";
import { deliverVoiceCallSummary, type VoiceCallerKind } from "@/lib/voice/voice-call-summary.server";
import { sendVoiceSummaryEmail } from "@/lib/voice/voice-summary-email.server";
import { recordManagerCommsUsage } from "@/lib/comms-billing/record-usage.server";
import { isVoiceRecordingEnabled } from "@/lib/twilio-voice.server";
import { isCommsPaygBillingEnabled } from "@/lib/comms-billing/rates";

export const runtime = "nodejs";

/**
 * Twilio call-status callback. The call is over, so this is where the manager
 * finally gets told what happened — see deliverVoiceCallSummary.
 *
 * Only terminal statuses do anything; Twilio also posts `initiated`/`ringing`/
 * `in-progress`, and summarising on those would send a half-written transcript.
 */
const TERMINAL_STATUSES = new Set(["completed", "busy", "failed", "no-answer", "canceled"]);

export async function POST(req: Request) {
  const raw = await req.text();
  const validated = validateTwilioVoiceWebhook(req, raw, resolveVoiceStatusWebhookUrl());
  if (!validated.ok) {
    return NextResponse.json({ error: validated.message }, { status: validated.status });
  }

  const status = String(validated.params.CallStatus ?? "").trim().toLowerCase();
  if (!TERMINAL_STATUSES.has(status)) return NextResponse.json({ ok: true, skipped: status });

  const fromPhone = String(validated.params.From ?? "").trim();
  const toPhone = String(validated.params.To ?? "").trim();
  const callSid = String(validated.params.CallSid ?? "").trim();
  if (!fromPhone || !toPhone || !callSid) {
    return NextResponse.json({ error: "Missing call fields." }, { status: 400 });
  }

  const db = createSupabaseServiceRoleClient();
  const resolved = await resolveVoiceCallRoute(db, { fromPhone, toPhone });
  if (!resolved.ok) return NextResponse.json({ ok: true, skipped: "unconfigured" });

  // Bill the call itself. Duration is only known once the call ends, which is
  // why this is the only place voice minutes can be metered — the inbound and
  // turn webhooks fire while it is still running. Twilio reports whole seconds;
  // partial minutes round UP, the way carriers bill them.
  const durationSeconds = Number(validated.params.CallDuration ?? 0);
  // Gated like every other meter. Without this, voice rows accrue while
  // pay-as-you-go is OFF and the sweeper has no start date — so switching the
  // feature on would retro-bill every call ever taken.
  if (isCommsPaygBillingEnabled() && Number.isFinite(durationSeconds) && durationSeconds > 0) {
    const minutes = Math.ceil(durationSeconds / 60);
    await recordManagerCommsUsage(db, {
      managerUserId: resolved.managerId,
      meter: "voice_minute",
      quantity: minutes,
      // Keyed on the call, so Twilio's status-callback retries cannot bill the
      // same call twice.
      idempotencyKey: `voice_minute:${callSid}`,
      metadata: { callSid, durationSeconds, from: fromPhone, to: toPhone },
    });
    // The env flag only means recording is POSSIBLE. A caller who declines
    // consent is hung up on and never recorded, so billing them recording
    // minutes would be a charge for something that did not happen. Twilio
    // reports the recording's own duration only when one exists.
    const recordingSeconds = Number(validated.params.RecordingDuration ?? 0);
    if (isVoiceRecordingEnabled() && Number.isFinite(recordingSeconds) && recordingSeconds > 0) {
      await recordManagerCommsUsage(db, {
        managerUserId: resolved.managerId,
        meter: "voice_recording_minute",
        // The RECORDING's length, not the call's — recording starts after the
        // consent turn, so the call is always the longer of the two.
        quantity: Math.ceil(recordingSeconds / 60),
        idempotencyKey: `voice_recording_minute:${callSid}`,
        metadata: { callSid, durationSeconds },
      });
    }
  }

  const { data: manager } = await db
    .from("profiles")
    .select("email, phone, phone_verified_at")
    .eq("id", resolved.managerId)
    .maybeSingle();

  const verifiedMobile =
    (manager as { phone_verified_at?: unknown } | null)?.phone_verified_at
      ? String((manager as { phone?: unknown }).phone ?? "").trim() || null
      : null;

  const delivery = await deliverVoiceCallSummary(db, {
    managerUserId: resolved.managerId,
    managerEmail: String((manager as { email?: unknown } | null)?.email ?? "").trim() || null,
    managerMobile: verifiedMobile,
    workNumber: resolved.workNumber,
    callerPhone: fromPhone,
    callerKind: resolved.route.kind as VoiceCallerKind,
    callSid,
    sendEmail: sendVoiceSummaryEmail,
  });

  return NextResponse.json({ ok: true, delivery });
}
