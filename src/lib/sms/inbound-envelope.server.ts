import "server-only";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runWithDurableSmsIngress, SafeSmsIngressRetry, type SmsIngressCheckpoint } from "@/lib/sms/durable-ingress-context.server";
import { dispatchPlatformReplies } from "@/lib/sms/platform-reply-dispatch.server";

export function smsEnvelopeRuntime(): string { return process.env.VERCEL_ENV?.trim() || "development"; }
export type EnvelopeInput = { sid: string; wireFrom: string; wireTo: string; params: Record<string, string>; payloadDigest: string; runtime: string };
export type PreparedBubble = { body: string; mediaUrls?: string[] };
export type EnvelopeProcessor = (params: Record<string, string>) => Promise<{ bubbles: PreparedBubble[]; sender?: string }>;

/** Only call after signature verification and redaction. The digest covers the original wire bytes. */
export async function acceptInboundEnvelope(db: SupabaseClient, input: EnvelopeInput): Promise<{ kind: "accepted" | "duplicate"; id: string } | { kind: "conflict" | "unavailable" }> {
 const account = process.env.TWILIO_ACCOUNT_SID?.trim();
 if (!account || !input.sid || !input.wireFrom || !input.wireTo || !/^[a-f0-9]{64}$/.test(input.payloadDigest) || input.runtime !== smsEnvelopeRuntime()) return { kind: "unavailable" };
 try {
  const signal = AbortSignal.timeout(4000);
  const { data, error } = await db.from("sms_ingress_envelopes").insert({ message_sid: input.sid, wire_from: input.wireFrom, wire_to: input.wireTo, params: input.params, payload_digest: input.payloadDigest, runtime: input.runtime, account_sid: account }).select("id").single().abortSignal(signal);
  if (!error && data) return { kind: "accepted", id: data.id };
  if (error?.code !== "23505") return { kind: "unavailable" };
  const existing = await db.from("sms_ingress_envelopes").select("id,wire_from,wire_to,payload_digest,runtime,account_sid").eq("message_sid", input.sid).maybeSingle().abortSignal(signal);
  if (existing.error || !existing.data) return { kind: "unavailable" };
  const e = existing.data;
  return e.wire_from === input.wireFrom && e.wire_to === input.wireTo && e.payload_digest === input.payloadDigest && e.runtime === input.runtime && e.account_sid === account ? { kind: "duplicate", id: e.id } : { kind: "conflict" };
 } catch { return { kind: "unavailable" }; }
}

export async function processInboundEnvelope(db: SupabaseClient, id: string, options: { process: EnvelopeProcessor }): Promise<void> {
 const runtime = smsEnvelopeRuntime();
 const account = process.env.TWILIO_ACCOUNT_SID?.trim();
 if (!account) return;
 const token = randomUUID();
 const claim = await db.rpc("sms_ingress_claim", { p_id: id, p_token: token, p_runtime: runtime, p_account: account });
 if (claim.error) throw new Error("Ingress claim unavailable");
 if (claim.data) {
  // Only persisted safe/control checkpoints may replay; unknown effects stay frozen.
  try {
   const initial = { stage: claim.data.checkpoint_stage || "unstarted", controlKeyword: claim.data.control_keyword || undefined, delegatedSid: claim.data.delegated_sid || undefined } as SmsIngressCheckpoint;
   const result = await runWithDurableSmsIngress({ current: initial, save: async checkpoint => {
    const saved = await db.rpc("sms_ingress_checkpoint", { p_id: id, p_token: token, p_stage: checkpoint.stage, p_control: checkpoint.controlKeyword ?? null, p_delegated_sid: checkpoint.delegatedSid ?? null });
    if (saved.error || saved.data !== true) throw new Error("Ingress checkpoint unavailable");
   } }, () => options.process(claim.data.params as Record<string, string>));
   if (!Array.isArray(result.bubbles) || result.bubbles.length > 10 || result.bubbles.some(b => typeof b.body !== "string" || b.body.length > 16000 || (b.mediaUrls && (!Array.isArray(b.mediaUrls) || b.mediaUrls.length > 1)))) throw new Error("Invalid prepared reply");
   let sender = "";
   if (result.bubbles.length) {
    if (!result.sender) throw new Error("Shared sender unavailable");
    sender = result.sender;
   }
   const saved = await db.rpc("sms_ingress_prepare", { p_id: id, p_token: token, p_sender: sender, p_bubbles: result.bubbles });
   if (saved.error || saved.data !== true) throw new Error("Prepared reply persistence unavailable");
  } catch (error) {
   // Read the persisted checkpoint: a lost checkpoint response must not cause replay
   // after an effect or delegation has already been recorded.
   const current = await db.from("sms_ingress_envelopes").select("checkpoint_stage,attempts").eq("id", id).eq("status", "executing").eq("lease_token", token).maybeSingle();
   if (current.error || !current.data) return;
   const stage = current.data.checkpoint_stage;
   const retry = error instanceof SafeSmsIngressRetry && (stage === "safe" || stage === "control") && current.data.attempts < 3;
   const reason = stage === "delegated" ? "delegated_receipt" : retry ? ( /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : "safe_retry") : error instanceof SafeSmsIngressRetry && (stage === "safe" || stage === "control") ? "retry_exhausted" : "uncertain_effect";
   await db.from("sms_ingress_envelopes").update({ status: retry ? "accepted" : "needs_review", reason, next_attempt_at: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** current.data.attempts)).toISOString(), lease_token: null, lease_until: null, updated_at: new Date().toISOString() }).eq("id", id).eq("status", "executing").eq("lease_token", token);
   return;
  }
 }
 await dispatchPlatformReplies(db, id);
}

export async function recoverInboundEnvelopes(db: SupabaseClient, options: { process: EnvelopeProcessor; batch?: number; deadline?: number }): Promise<{ processed: number; needsReview: number }> {
 const runtime = smsEnvelopeRuntime(); const account = process.env.TWILIO_ACCOUNT_SID?.trim();
 if (!account) throw new Error("SMS account unavailable");
 const now = new Date().toISOString();
 const reconciled = await db.rpc("sms_ingress_reconcile", { p_runtime: runtime, p_account: account });
 if (reconciled.error) throw new Error("Ingress reconciliation unavailable");
 // Lease expiry alone is ambiguous: only explicit safe/control checkpoints replay.
 const stale = await db.from("sms_ingress_envelopes").select("id,checkpoint_stage,attempts,lease_token").eq("runtime", runtime).eq("account_sid", account).eq("status", "executing").lt("lease_until", now);
 if (stale.error) throw new Error("Ingress recovery unavailable");
 for (const row of stale.data ?? []) {
  const retry = (row.checkpoint_stage === "safe" || row.checkpoint_stage === "control") && row.attempts < 3;
  const update = await db.from("sms_ingress_envelopes").update({ status: retry ? "accepted" : "needs_review", reason: row.checkpoint_stage === "delegated" ? "delegated_receipt" : retry ? "lease_retry" : "uncertain_effect", lease_token: null, lease_until: null, next_attempt_at: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** row.attempts)).toISOString(), updated_at: now }).eq("id", row.id).eq("status", "executing").eq("lease_token", row.lease_token).lt("lease_until", now);
  if (update.error) throw new Error("Ingress recovery unavailable");
 }
 for (const [status, field] of [["accepted", "expires_at"], ["prepared", "expires_at"]] as const) {
  const update = await db.from("sms_ingress_envelopes").update({ status: "expired", updated_at: now }).eq("runtime", runtime).eq("account_sid", account).eq("status", status).lt(field, now);
  if (update.error) throw new Error("Ingress recovery unavailable");
 }
 const rows = await db.from("sms_ingress_envelopes").select("id").eq("runtime", runtime).eq("account_sid", account).in("status", ["accepted", "prepared"]).gt("expires_at", now).order("received_at").limit(Math.min(Math.max(options.batch ?? 10, 1), 25));
 if (rows.error) throw new Error("Ingress recovery unavailable");
 let processed = 0;
 for (const row of rows.data ?? []) { if (options.deadline && Date.now() >= options.deadline) break; await processInboundEnvelope(db, row.id, options); processed++; }
 const pending = await db.from("sms_ingress_envelopes").select("id", { count: "exact", head: true }).eq("runtime", runtime).eq("account_sid", account).eq("status", "needs_review");
 if (pending.error) throw new Error("Ingress health unavailable");
 return { processed, needsReview: pending.count ?? 0 };
}
