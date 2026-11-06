import { NextResponse, after } from "next/server";
import { createHash } from "node:crypto";
import twilio from "twilio";
import { normalizeE164 } from "@/lib/phone-e164";
import { isTwilioMessageSid } from "@/lib/sms/message-sid";
import { twilioWebhookAuthToken } from "@/lib/twilio-client.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isShieldedRecipient } from "@/lib/protected-accounts.server";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { acceptInboundEnvelope, processInboundEnvelope, smsEnvelopeRuntime } from "@/lib/sms/inbound-envelope.server";

export const runtime = "nodejs";
export const maxDuration = 120;

function emptyTwiml() {
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { headers: { "Content-Type": "text/xml" } });
}

async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Ingress deadline")), milliseconds); })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Signature verification and durable acceptance are the only work before acknowledgement. */
export async function POST(req: Request) {
  const started = Date.now();
  const authToken = twilioWebhookAuthToken();
  if (!authToken) return NextResponse.json({ error: "SMS not configured." }, { status: 503 });
  try {
    const raw = await bounded(req.text(), 1000);
    if (raw.length > 65_536) return NextResponse.json({ error: "Inbound payload too large." }, { status: 413 });
    const params = Object.fromEntries(new URLSearchParams(raw));
    const signature = req.headers.get("x-twilio-signature") ?? "";
    const url = (process.env.TWILIO_WEBHOOK_URL?.trim() || req.url).split("#")[0];
    if ((!signature && Boolean(process.env.VERCEL || process.env.NODE_ENV === "production")) ||
      (signature && !twilio.validateRequest(authToken, signature, url, params))) {
      return NextResponse.json({ error: "Invalid signature." }, { status: 403 });
    }
    const from = normalizeE164(params.From); const to = normalizeE164(params.To);
    const sid = params.MessageSid?.trim();
    if (!from || !to || !sid || !isTwilioMessageSid(sid)) return NextResponse.json({ error: "Invalid inbound identity." }, { status: 400 });
    if (params.AccountSid !== process.env.TWILIO_ACCOUNT_SID?.trim()) return NextResponse.json({ error: "Invalid provider account." }, { status: 403 });
    const shielded = await bounded(Promise.all([isShieldedRecipient({ phone: from }), isShieldedRecipient({ phone: to })]), 2000);
    if (shielded.some(Boolean)) return emptyTwiml();
    const redaction = redactSensitiveNumbers(String(params.Body ?? "").trim());
    const sanitized = { ...params, Body: redaction.text, PropLaneRedacted: redaction.redacted ? "1" : "0" };
    const db = createSupabaseServiceRoleClient();
    const accepted = await acceptInboundEnvelope(db, { sid, wireFrom: from, wireTo: to, params: sanitized, payloadDigest: createHash("sha256").update(raw).digest("hex"), runtime: smsEnvelopeRuntime() });
    if (accepted.kind === "conflict") return NextResponse.json({ error: "Inbound identity conflict." }, { status: 409 });
    if (accepted.kind === "unavailable") return NextResponse.json({ error: "Inbound persistence unavailable." }, { status: 503 });
    after(async () => {
      try { await processInboundEnvelope(createSupabaseServiceRoleClient(), accepted.id, { process: async (params) => (await import("@/lib/sms/process-accepted-inbound.server")).processAcceptedInbound(params) }); }
      catch { console.error("sms ingress deferred failure", { sid, stage: "worker" }); }
    });
    console.info("sms ingress accepted", { sid, status: accepted.kind, ms: Date.now() - started });
    return emptyTwiml();
  } catch {
    console.error("sms ingress failed", { stage: "accept", ms: Date.now() - started });
    return NextResponse.json({ error: "Inbound acceptance unavailable." }, { status: 503 });
  }
}
