import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendPlatformLeadText } from "@/lib/one-number/lead-send.server";
import { smsEnvelopeRuntime } from "@/lib/sms/inbound-envelope.server";

/** A reply that did not leave is never silent: one Attention item per envelope and reason (best effort, never throws). */
const flagEnvelope = (db: SupabaseClient, envelopeId: string, reason: string): Promise<void> =>
  import("@/lib/prospect-spine/delivery-issue.server").then((m) => m.reportEnvelopeIssue(db, envelopeId, reason)).catch(() => undefined);

/** The same configured URL is used for the provider and signature verification. */
export function platformReplyCallbackUrl(token: string): string | null {
 try {
  const configured = process.env.TWILIO_PLATFORM_REPLY_STATUS_URL?.trim();
  const inbound = process.env.TWILIO_WEBHOOK_URL?.trim();
  if (!configured && !inbound) return null;
  const url = configured ? new URL(configured) : new URL("/api/twilio/platform-reply-status", inbound!.split("#")[0]);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/twilio/platform-reply-status") return null;
  url.searchParams.set("token", token);
  return url.toString();
 } catch { return null; }
}

/** Ordered bubbles, with a CAS before every potentially irreversible provider request. */
export async function dispatchPlatformReplies(db: SupabaseClient, envelopeId: string): Promise<void> {
 const account = process.env.TWILIO_ACCOUNT_SID?.trim();
 if (!account) return;
 const runtime = smsEnvelopeRuntime(); const now = new Date().toISOString();
 const envelope = await db.from("sms_ingress_envelopes").select("status,expires_at").eq("id", envelopeId).eq("runtime", runtime).eq("account_sid", account).maybeSingle();
 if (envelope.error) throw new Error("Ingress read unavailable");
 if (envelope.data?.status !== "prepared") return;
 if (envelope.data.expires_at <= now) {
  await db.from("sms_ingress_envelopes").update({ status: "expired", updated_at: now }).eq("id", envelopeId).eq("status", "prepared"); return;
 }
 const stale = await db.from("sms_platform_replies").update({ status: "delivery_unknown", updated_at: now }).eq("envelope_id", envelopeId).eq("status", "submitting").lt("submit_lease_until", now);
 if (stale.error) throw new Error("Reply recovery unavailable");
 const rows = await db.from("sms_platform_replies").select("*").eq("envelope_id", envelopeId).eq("runtime", runtime).eq("account_sid", account).order("bubble_index");
 if (rows.error) throw new Error("Reply read unavailable");
 for (const row of rows.data ?? []) {
  if (row.status === "accepted") continue;
  if (row.status !== "prepared") {
   if (row.status === "delivery_unknown" || row.status === "blocked") {
    await db.from("sms_ingress_envelopes").update({ status: "needs_review", reason: row.status === "delivery_unknown" ? "delivery_unknown" : "reply_blocked", updated_at: now }).eq("id", envelopeId).eq("status", "prepared");
    await flagEnvelope(db, envelopeId, row.status === "delivery_unknown" ? "delivery_unknown" : "reply_blocked");
   }
   return;
  }
  if (row.next_attempt_at && row.next_attempt_at > now) return;
  const callback = platformReplyCallbackUrl(row.callback_token);
  if (!callback || row.attempt_count >= 3) {
   await db.from("sms_platform_replies").update({ status: "blocked", updated_at: now }).eq("id", row.id).eq("status", "prepared");
   await db.from("sms_ingress_envelopes").update({ status: "needs_review", reason: "reply_blocked", updated_at: now }).eq("id", envelopeId).eq("status", "prepared");
   await flagEnvelope(db, envelopeId, "reply_blocked"); return;
  }
  const claimed = await db.from("sms_platform_replies").update({ status: "submitting", attempt_count: row.attempt_count + 1, submit_lease_until: new Date(Date.now() + 120_000).toISOString(), updated_at: now }).eq("id", row.id).eq("status", "prepared").eq("attempt_count", row.attempt_count).select("id").maybeSingle();
  if (claimed.error) throw new Error("Reply claim unavailable");
  if (!claimed.data) return;
  let result: Awaited<ReturnType<typeof sendPlatformLeadText>>;
  try { result = await sendPlatformLeadText(db, { to: row.wire_to, body: row.body, mediaUrls: row.media_urls, inboundReply: true, expectedFrom: row.wire_from, statusCallbackUrl: callback }); }
  catch { result = { ok: false, reason: "delivery_unknown" }; }
  const status = result.ok ? "accepted" : result.reason === "delivery_unknown" ? "delivery_unknown" : ["provider_error", "config_unavailable", "suppression_unavailable"].includes(result.reason) ? "prepared" : "blocked";
  // Callback may have already bound the SID. Never overwrite a callback's acceptance.
  const update = await db.from("sms_platform_replies").update({ status, ...(status === "prepared" ? { next_attempt_at: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** (row.attempt_count + 1))).toISOString() } : {}), ...(result.ok ? { provider_sid: result.sid } : {}), updated_at: new Date().toISOString() }).eq("id", row.id).eq("status", "submitting").select("id").maybeSingle();
  if (update.error) throw new Error("Reply outcome unavailable");
  if (!update.data) {
   if (result.ok) {
    const bound = await db.from("sms_platform_replies").select("provider_sid,status").eq("id", row.id).maybeSingle();
    if (bound.error || !bound.data || bound.data.provider_sid !== result.sid) {
     await db.from("sms_ingress_envelopes").update({ status: "needs_review", reason: "sid_conflict", updated_at: new Date().toISOString() }).eq("id", envelopeId).eq("status", "prepared");
     await flagEnvelope(db, envelopeId, "sid_conflict");
    }
   }
   return;
  }
  if (status !== "accepted") {
   if (status !== "prepared") {
    await db.from("sms_ingress_envelopes").update({ status: "needs_review", reason: status === "delivery_unknown" ? "delivery_unknown" : "reply_blocked", updated_at: new Date().toISOString() }).eq("id", envelopeId).eq("status", "prepared");
    await flagEnvelope(db, envelopeId, status === "delivery_unknown" ? "delivery_unknown" : "reply_blocked");
   }
   return;
  }
 }
 await db.from("sms_ingress_envelopes").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", envelopeId).eq("status", "prepared");
}
