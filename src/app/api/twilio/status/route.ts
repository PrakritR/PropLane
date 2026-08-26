import { NextResponse } from "next/server";
import twilio from "twilio";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { shouldApplyTwilioStatus, twilioStatusRank } from "@/lib/sms/delivery-status";
import { twilioWebhookAuthToken } from "@/lib/twilio-client.server";

export const runtime = "nodejs";

/** TwiML no-op response so Twilio doesn't retry or error. */
function twimlOk(): NextResponse {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200,
    headers: { "Content-Type": "text/xml" },
  });
}

/**
 * Twilio outbound message status callback. Twilio POSTs here (when sendSms sets
 * statusCallback via TWILIO_STATUS_CALLBACK_URL) as an outbound message moves
 * through queued → sent → delivered / failed / undelivered. We keep exactly one
 * sms_delivery_log row per MessageSid — updating it in place — so repeated or
 * out-of-order callbacks stay idempotent (the row reflects the latest status
 * we received). The partial unique index on message_sid is a concurrency
 * backstop; a losing race just no-ops.
 *
 * Note: we intentionally do NOT use a PostgREST `.upsert({ onConflict })` here —
 * the arbiter is a PARTIAL unique index (`where message_sid is not null`) and
 * `ON CONFLICT (message_sid)` cannot be inferred against a partial index without
 * its predicate, which PostgREST can't emit. Select-then-write is the idempotent
 * equivalent and is exactly how /api/twilio/inbound dedupes by message_sid.
 *
 * Configure in Twilio: Messaging Service status callback → POST
 * https://<host>/api/twilio/status
 */
export async function POST(req: Request) {
  const authToken = twilioWebhookAuthToken();
  if (!authToken) return NextResponse.json({ error: "SMS not configured." }, { status: 503 });

  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw));

  // Signature check — reject spoofed callbacks. Twilio signs over the URL it was
  // configured to POST to, i.e. the STATUS callback URL that sendSms registered
  // (TWILIO_STATUS_CALLBACK_URL) — NOT the inbound webhook URL. Validating against
  // the wrong path 403s every callback (and silently drops all delivery logging).
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const url = process.env.TWILIO_STATUS_CALLBACK_URL?.trim() || req.url;
  if (!twilio.validateRequest(authToken, signature, url, params)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }

  const messageSid = String(params.MessageSid ?? "").trim() || null;
  const status = String(params.MessageStatus ?? "").trim() || null;
  const toPhone = String(params.To ?? "").trim();
  const errorCode = String(params.ErrorCode ?? "").trim() || null;

  const db = createSupabaseServiceRoleClient();

  const row = { message_sid: messageSid, to_phone: toPhone, status, error_code: errorCode };

  if (messageSid && status) {
    const { error: eventError } = await db.from("sms_delivery_events").insert({
      message_sid: messageSid,
      status,
      status_rank: twilioStatusRank(status),
      error_code: errorCode,
    });
    if (eventError && eventError.code !== "23505") {
      return NextResponse.json({ error: "Delivery event persistence unavailable." }, { status: 503 });
    }

    const { error: applyError } = await db.rpc("apply_sms_delivery_status", {
      p_message_sid: messageSid,
      p_status: status,
      p_status_rank: twilioStatusRank(status),
      p_error_code: errorCode,
      p_provider_occurred_at: new Date().toISOString(),
    });
    if (applyError) {
      return NextResponse.json({ error: "Delivery status persistence unavailable." }, { status: 503 });
    }
  }

  // Idempotent write keyed on message_sid: update the existing row in place, or
  // insert a fresh one. Errors (including a rare insert race on the unique
  // index) are swallowed — a status callback must always ack Twilio with 200.
  if (messageSid) {
    const { data: existing } = await db
      .from("sms_delivery_log")
      .select("id, status")
      .eq("message_sid", messageSid)
      .limit(1);
    if ((existing ?? []).length > 0) {
      if (shouldApplyTwilioStatus(existing?.[0]?.status, status)) {
        await db
          .from("sms_delivery_log")
          .update({ to_phone: toPhone, status, error_code: errorCode })
          .eq("message_sid", messageSid)
          .then(() => undefined, () => undefined);
      }
      return twimlOk();
    }
  }

  await db.from("sms_delivery_log").insert(row).then(() => undefined, () => undefined);

  return twimlOk();
}
