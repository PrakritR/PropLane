/**
 * Twilio inbound SMS webhook — the vendor agent's after-hours front door.
 * Returns empty TwiML immediately and runs the agent turn via after(), so
 * Twilio's response window is never a constraint. Configure the Messaging
 * webhook (POST) to {APP_URL}/api/webhooks/twilio/sms and enable Advanced
 * Opt-Out in the console (it sends the STOP compliance reply; we only record
 * the opt-out and unbind the number).
 */
import { after } from "next/server";
import twilio from "twilio";
import { resolveVendorAgentSessionForInbound, runVendorAgentSessionTurn } from "@/lib/agent/vendor-agent.server";
import { resolveAppOrigin } from "@/lib/app-url";
import { rateLimit } from "@/lib/rate-limit";
import { normalizeConsentPhone, profilePhoneVariants } from "@/lib/sms-consent";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { normalizeE164 } from "@/lib/twilio";
import { fetchTwilioMessageCreatedAt, twilioWebhookAuthToken } from "@/lib/twilio-client.server";

export const runtime = "nodejs";
export const maxDuration = 60;

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const START_WORDS = new Set(["START", "YES", "UNSTOP"]);

function twiml(): Response {
  return new Response(EMPTY_TWIML, { status: 200, headers: { "Content-Type": "text/xml" } });
}

function maskedPhone(phone: string): string {
  return `${phone.slice(0, 5)}***${phone.slice(-2)}`;
}

function timestampMillis(raw: unknown): number | null {
  const value = raw ? Date.parse(String(raw)) : NaN;
  return Number.isNaN(value) ? null : value;
}

async function controlKeywordIsCurrent(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  phoneKey: string,
  keyword: "STOP" | "START",
  providerOccurredAt: string,
): Promise<{ ok: true; current: boolean } | { ok: false }> {
  const { data, error } = await db
    .from("sms_consent")
    .select("opted_in_at, opted_out_at")
    .eq("phone", phoneKey)
    .maybeSingle();
  if (error || !data) return { ok: false };
  const eventAt = Date.parse(providerOccurredAt);
  const optedInAt = timestampMillis(data.opted_in_at);
  const optedOutAt = timestampMillis(data.opted_out_at);
  if (keyword === "STOP") {
    return {
      ok: true,
      current: optedOutAt === eventAt && (optedInAt == null || optedOutAt >= optedInAt),
    };
  }
  return {
    ok: true,
    current: optedInAt === eventAt && (optedOutAt == null || optedInAt > optedOutAt),
  };
}

export async function POST(req: Request) {
  const raw = await req.text();
  const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
  const signature = req.headers.get("x-twilio-signature");
  const authToken = twilioWebhookAuthToken();

  // Signature over the exact URL Twilio was configured with. Only local dev
  // may run unsigned — any deployed environment fails closed (Checkr precedent).
  // Set TWILIO_WEBHOOK_URL when a proxy rewrites the request origin.
  if (!authToken || !signature) {
    if (process.env.VERCEL || process.env.NODE_ENV === "production") {
      return new Response("Forbidden", { status: 403 });
    }
  } else {
    const url = process.env.TWILIO_WEBHOOK_URL?.trim() || `${resolveAppOrigin(req)}/api/webhooks/twilio/sms`;
    if (!twilio.validateRequest(authToken, signature, url, params)) {
      return new Response("Forbidden", { status: 403 });
    }
  }

  const from = normalizeE164(String(params.From ?? "")) ?? "";
  const body = String(params.Body ?? "").trim();
  if (!from || !body) return twiml();

  const db = createSupabaseServiceRoleClient();
  const keyword = body.toUpperCase().replace(/[.!?]/g, "").trim();

  // Carrier controls must be durably ordered before ordinary traffic shedding.
  // MessageSid provides replay identity; Twilio's immutable dateCreated provides
  // event order when webhook deliveries and retries arrive out of order.
  const controlKeyword = STOP_WORDS.has(keyword) ? "STOP" : START_WORDS.has(keyword) ? "START" : null;
  if (controlKeyword) {
    const messageSid = String(params.MessageSid ?? "").trim();
    const phoneKey = normalizeConsentPhone(from);
    if (!messageSid || !phoneKey) return new Response("Invalid control message", { status: 400 });
    const providerOccurredAt = await fetchTwilioMessageCreatedAt(messageSid);
    if (!providerOccurredAt) return new Response("Control message time unavailable", { status: 503 });
    const { error: controlError } = await db.rpc("apply_sms_control_keyword", {
      p_message_sid: messageSid,
      p_recipient_phone_key: phoneKey,
      p_keyword: controlKeyword,
      p_provider_occurred_at: providerOccurredAt,
      p_manager_user_id: null,
      p_messaging_service_sid: null,
    });
    if (controlError) return new Response("Control receipt unavailable", { status: 503 });

    // The RPC can return false for a replay or an event made stale by a newer
    // control. Read the canonical ledger so a retry can finish auxiliary vendor
    // updates, while a stale START/STOP can never mutate profiles or sessions.
    const current = await controlKeywordIsCurrent(db, phoneKey, controlKeyword, providerOccurredAt);
    if (!current.ok) return new Response("Control state unavailable", { status: 503 });
    if (!current.current) return twiml();

    if (controlKeyword === "STOP") {
      const { data: sessions, error: sessionReadError } = await db
        .from("agent_sessions")
        .select("vendor_user_id")
        .eq("kind", "vendor_work_order")
        .eq("vendor_phone_e164", from);
      if (sessionReadError) return new Response("Vendor control state unavailable", { status: 503 });
      const vendorIds = [...new Set((sessions ?? []).map((s) => s.vendor_user_id as string | null).filter(Boolean))] as string[];
      if (vendorIds.length > 0) {
        const { error: profileError } = await db
          .from("profiles")
          .update({ sms_opt_out_at: providerOccurredAt })
          .in("id", vendorIds);
        if (profileError) return new Response("Vendor control state unavailable", { status: 503 });
      }
      const { error: unbindError } = await db
        .from("agent_sessions")
        .update({ vendor_phone_e164: null, updated_at: new Date().toISOString() })
        .eq("kind", "vendor_work_order")
        .eq("vendor_phone_e164", from);
      if (unbindError) return new Response("Vendor control state unavailable", { status: 503 });
      return twiml();
    }

    const { data: profs, error: profileReadError } = await db
      .from("profiles")
      .select("id")
      .in("phone", profilePhoneVariants(from));
    if (profileReadError) return new Response("Vendor control state unavailable", { status: 503 });
    const ids = ((profs ?? []) as { id: string }[]).map((p) => p.id);
    if (ids.length > 0) {
      const { error: profileError } = await db
        .from("profiles")
        .update({ sms_opt_out_at: null, sms_consent_at: providerOccurredAt })
        .in("id", ids);
      if (profileError) return new Response("Vendor control state unavailable", { status: 503 });
    }
    return twiml();
  }

  // Per-phone rate limit. Over-limit still gets a 200 — a non-2xx makes Twilio
  // retry, which would amplify a flood instead of shedding it.
  if (!rateLimit(`twilio-sms:${from}`, 10, 60_000).ok) {
    console.warn("twilio sms rate-limited", maskedPhone(from));
    return twiml();
  }

  const sessionResolution = await resolveVendorAgentSessionForInbound(db, from, body);
  if (sessionResolution.kind === "unknown_phone") {
    // Silent drop: replying to unknown numbers turns us into an SMS echo
    // service and a cost amplifier. Nothing actionable to audit either.
    console.warn("twilio sms from unknown number, dropped", maskedPhone(from));
    return twiml();
  }

  const session = sessionResolution.session;

  const task = () =>
    runVendorAgentSessionTurn(db, session, body, "sms", {
      precomputedReply: sessionResolution.kind === "reply" ? sessionResolution.reply : null,
      reference: sessionResolution.kind === "session" ? sessionResolution.reference : null,
    }).catch((e) =>
      console.error("vendor-agent sms turn failed", session.id, e),
    );
  try {
    after(task);
  } catch {
    void task();
  }
  return twiml();
}
