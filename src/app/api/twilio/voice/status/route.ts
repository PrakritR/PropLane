import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  resolveVoiceStatusWebhookUrl,
  validateTwilioVoiceWebhook,
} from "@/lib/twilio-voice.server";
import { resolveVoiceCallRoute } from "@/lib/voice/voice-call-routing.server";
import { deliverVoiceCallSummary, type VoiceCallerKind } from "@/lib/voice/voice-call-summary.server";
import { sendVoiceSummaryEmail } from "@/lib/voice/voice-summary-email.server";

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
