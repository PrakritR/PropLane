import { NextResponse } from "next/server";
import twilio from "twilio";
import { handleClawLeasingInbound } from "@/lib/claw-leasing-bot.server";
import { rateLimit } from "@/lib/rate-limit";
import { recordOptIn, recordOptOut } from "@/lib/sms-consent";
import { isClawSharedLineBridgeEnabled } from "@/lib/claw-leasing-links";
import {
  detectManagerSelfReply,
  forwardResidentInboundToManagerCell,
  handleManagerReplyInbound,
} from "@/lib/sms/manager-relay.server";
import { twilioMediaUrls } from "@/lib/sms-media.server";
import { inboundLogIdentityFields } from "@/lib/manager-sms-messages.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { routeInboundSms, type SmsIntentResult } from "@/lib/sms-intent-router";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import { findResidentProfileByPhone } from "@/lib/claw-resident-messaging.server";
import { notifyManagerOfInboundSms } from "@/lib/sms-inbox-notice.server";
import { relayInboundSms } from "@/lib/sms-relay.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Standard carrier/Twilio SMS control keywords. Twilio's Advanced Opt-Out sends
 * the compliance auto-replies; Axis records the resulting consent state so it
 * never texts an opted-out number again, and never leaks a control message into
 * anyone's inbox. Matched case-insensitively against the entire trimmed body.
 */
const SMS_STOP_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const SMS_START_KEYWORDS = new Set(["START", "YES", "UNSTOP"]);
const SMS_HELP_KEYWORDS = new Set(["HELP", "INFO"]);

function digitsOf(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return digits;
}

/** Common storage formats for one US number, for direct-column matching. */
function phoneVariants(raw: string): string[] {
  const d = digitsOf(raw);
  if (d.length !== 10) return [raw.trim()].filter(Boolean);
  return [
    `+1${d}`,
    d,
    `1${d}`,
    `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,
    `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,
    raw.trim(),
  ].filter(Boolean);
}

/** Empty TwiML — replies are sent asynchronously via the Messaging API. */
function twimlOk(reply?: string): NextResponse {
  const escaped = reply
    ? reply.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : "";
  return new NextResponse(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${escaped ? `<Message>${escaped}</Message>` : ""}</Response>`,
    {
      status: 200,
      headers: { "Content-Type": "text/xml" },
    },
  );
}

/**
 * Twilio inbound SMS webhook for manager work numbers.
 *
 * Any From phone is accepted (no allowlist). After relay-pool handling, the
 * message is routed through leasing bot / resident intents / manager agent
 * commands — same product logic as the former Claw gateway, Twilio-native.
 *
 * Configure in Twilio: Messaging webhook → POST https://<host>/api/twilio/inbound
 * (must match TWILIO_WEBHOOK_URL when set, for signature validation).
 */
export async function POST(req: Request) {
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  if (!authToken) return NextResponse.json({ error: "SMS not configured." }, { status: 503 });

  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw));

  // Signature check — reject spoofed webhook calls. Fail closed on Vercel.
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const url = process.env.TWILIO_WEBHOOK_URL?.trim() || req.url;
  const failClosed = Boolean(process.env.VERCEL || process.env.NODE_ENV === "production");
  if (!signature) {
    if (failClosed) return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  } else if (!twilio.validateRequest(authToken, signature, url, params)) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
  }

  const fromPhone = String(params.From ?? "").trim();
  const toPhone = String(params.To ?? "").trim();
  const body = String(params.Body ?? "").trim();
  const messageSid = String(params.MessageSid ?? "").trim() || null;
  if (!fromPhone || !toPhone) return twimlOk();

  if (!rateLimit(`twilio-inbound:${fromPhone}`, 20, 60_000).ok) {
    return twimlOk();
  }

  const db = createSupabaseServiceRoleClient();

  // Compliance: handle STOP/START/HELP control keywords before any routing.
  const keyword = body.toUpperCase();
  if (SMS_STOP_KEYWORDS.has(keyword)) {
    await recordOptOut(db, fromPhone);
    return twimlOk();
  }
  if (SMS_START_KEYWORDS.has(keyword)) {
    await recordOptIn(db, fromPhone);
    return twimlOk();
  }
  if (SMS_HELP_KEYWORDS.has(keyword)) {
    return twimlOk();
  }

  // Idempotency: Twilio retries on any non-2xx/timeout.
  if (messageSid) {
    const { data: seen } = await db
      .from("inbound_sms_log")
      .select("id")
      .eq("message_sid", messageSid)
      .limit(1);
    if ((seen ?? []).length > 0) return twimlOk();
  }

  // Proxy-pair relay first (manager ↔ resident via pooled number).
  const mediaUrls = twilioMediaUrls(params);
  const relay = await relayInboundSms(db, { fromPhone, toPhone, body, messageSid, mediaUrls });
  if (relay.handled) {
    await db
      .from("inbound_sms_log")
      .insert({
        manager_user_id: relay.managerUserId ?? null,
        from_phone: fromPhone,
        to_phone: toPhone,
        matched_sender_user_id: relay.senderUserId ?? null,
        body,
        message_sid: messageSid,
        // Proxy-pair relay is always a bound resident ↔ manager thread.
        ...inboundLogIdentityFields({
          managerUserId: relay.managerUserId ?? null,
          counterpartyRole: "resident",
          counterpartyUserId: relay.senderUserId ?? null,
          fromPhone,
        }),
      })
      .then(() => undefined, () => undefined);
    return twimlOk(relay.reply);
  }

  // Manager is whoever owns the work number that was texted.
  const { data: managerRows } = await db
    .from("profiles")
    .select("id")
    .in("sms_from_number", phoneVariants(toPhone))
    .limit(1);
  const managerId = String((managerRows ?? [])[0]?.id ?? "").trim();
  if (!managerId) {
    await db
      .from("inbound_sms_log")
      .insert({
        from_phone: fromPhone,
        to_phone: toPhone,
        body,
        message_sid: messageSid,
        ...inboundLogIdentityFields({ managerUserId: null, counterpartyRole: "unknown", fromPhone }),
      })
      .then(() => undefined, () => undefined);
    return twimlOk();
  }

  const workNumber = normalizeE164(toPhone) ?? toPhone;

  // Leg 2 — manager reply. If the sender is this manager's OWN verified cell
  // texting their own work number, route the text to their active resident
  // conversation instead of treating the manager as a resident.
  const selfReply = await detectManagerSelfReply(db, { managerUserId: managerId, fromPhone, toPhone });
  if (selfReply) {
    const relayed = await handleManagerReplyInbound(db, {
      managerUserId: managerId,
      workNumber: selfReply.workNumber,
      body,
    });
    await db
      .from("inbound_sms_log")
      .insert({
        manager_user_id: managerId,
        from_phone: fromPhone,
        to_phone: toPhone,
        matched_sender_user_id: managerId,
        body,
        message_sid: messageSid,
        ...inboundLogIdentityFields({ managerUserId: managerId, counterpartyRole: "manager", fromPhone }),
      })
      .then(() => undefined, () => undefined);
    let notice: string | undefined;
    if (!relayed.ok) {
      notice =
        relayed.error === "registration_pending"
          ? "Your PropLane number isn't approved to send yet. We'll notify you when it's active."
          : relayed.error === "no_active_conversation"
            ? "No active resident conversation to reply to. Open PropLane to pick a recipient."
            : "Couldn't send that reply. Open PropLane to try again.";
    }
    return twimlOk(notice);
  }

  // Intent-router seam (owned by axis-sms-text-to-entry): the transport
  // resolves the sender + conversation and persists the message; the router
  // decides what the message MEANS. `handled` → the router produced the reply,
  // so default handling (leasing bot / resident hub) is skipped — the
  // transport still runs the manager fan-out (inbox + email + cell forward).
  const senderProfile = await findResidentProfileByPhone(fromPhone).catch(() => null);
  const counterpartyRole = senderProfile ? ("resident" as const) : ("prospect" as const);
  const conversationKey = buildConversationKey({
    ownerManagerUserId: managerId,
    role: counterpartyRole,
    counterpartyUserId: senderProfile?.userId ?? null,
    counterpartyPhone: fromPhone,
  });
  let isFirstMessageInConversation = false;
  try {
    const { data: prior } = await db
      .from("inbound_sms_log")
      .select("id")
      .eq("conversation_key", conversationKey)
      .limit(1);
    isFirstMessageInConversation = (prior ?? []).length === 0;
  } catch {
    /* conservative default: not first */
  }

  let intent: SmsIntentResult = { handled: false };
  try {
    intent = await routeInboundSms({
      fromPhone,
      toPhone,
      body,
      managerId,
      conversationId: conversationKey,
      isFirstMessageInConversation,
    });
  } catch (e) {
    console.error("sms intent router failed; falling back to default handling", e);
  }

  if (intent.handled) {
    const autoReply = intent.autoReplyBody?.trim() || null;
    // Persist the inbound with its resolved identity (the default handler that
    // would normally log it is skipped on this branch).
    await db
      .from("inbound_sms_log")
      .insert({
        manager_user_id: managerId,
        from_phone: fromPhone,
        to_phone: toPhone,
        matched_sender_user_id: senderProfile?.userId ?? null,
        body,
        message_sid: messageSid,
        ...inboundLogIdentityFields({
          managerUserId: managerId,
          counterpartyRole,
          counterpartyUserId: senderProfile?.userId ?? null,
          fromPhone,
        }),
      })
      .then(() => undefined, () => undefined);
    // The auto-reply goes out through the ONE transport gate (opt-out, quiet
    // hours, number suspension) from the number that was texted, so it carries
    // a real sid for delivery stamping and is logged there as outbound.
    let deliveredAutoReply: string | null = null;
    if (autoReply) {
      const sent = await sendFromManagerWorkNumber({
        managerUserId: managerId,
        to: fromPhone,
        text: autoReply,
        fromNumber: workNumber,
        residentUserId: senderProfile?.userId ?? null,
        source: "work_number",
        counterpartyRole,
      }).catch(() => ({ ok: false }));
      if (sent.ok) deliveredAutoReply = autoReply;
    }
    // Manager fan-out: inbox notice + email (reply-tokened) + cell forward.
    await notifyManagerOfInboundSms(db, {
      managerUserId: managerId,
      fromPhone,
      text: body,
      autoReply: deliveredAutoReply,
      subjectLabel: counterpartyRole === "resident" ? "Resident text" : "New text",
      senderLabel: senderProfile?.email ?? null,
      idPrefix: "sms_intent",
      threadType: counterpartyRole === "resident" ? "claw_resident_sms" : "claw_leasing_sms",
    }).catch(() => ({ inboxNoticeWritten: false, emailSent: false }));
    if (!isClawSharedLineBridgeEnabled()) {
      await forwardResidentInboundToManagerCell(db, {
        managerUserId: managerId,
        workNumber,
        fromPhone,
        body,
      }).catch(() => undefined);
    }
    return twimlOk();
  }

  try {
    await handleClawLeasingInbound({
      from: fromPhone,
      text: body,
      messageId: messageSid,
      managerUserId: managerId,
      workNumber,
      service: "SMS",
    });
  } catch (e) {
    console.error("twilio inbound leasing handler failed", managerId, e);
    return twimlOk();
  }

  // Leg 1 — forward the resident's text to the manager's own cell (labelled,
  // never the raw number). Only in the per-manager Twilio regime; the Claw
  // shared line has its own forward path, so this avoids a double forward.
  if (!isClawSharedLineBridgeEnabled()) {
    await forwardResidentInboundToManagerCell(db, {
      managerUserId: managerId,
      workNumber,
      fromPhone,
      body,
    }).catch(() => undefined);
  }

  // Belt-and-suspenders: the leasing handler already logs inbound with its
  // resolved role (this insert dedups on the unique message_sid). Populate the
  // identity fields anyway for the rare path where the handler logged nothing.
  await db
    .from("inbound_sms_log")
    .insert({
      manager_user_id: managerId,
      from_phone: fromPhone,
      to_phone: toPhone,
      matched_sender_user_id: null,
      body,
      message_sid: messageSid,
      ...inboundLogIdentityFields({ managerUserId: managerId, fromPhone }),
    })
    .then(() => undefined, () => undefined);

  return twimlOk();
}
