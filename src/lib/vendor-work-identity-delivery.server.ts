import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { isShieldedRecipient } from "@/lib/protected-accounts.server";
import { normalizeE164 } from "@/lib/twilio";
import { quietHoursBlocks, type SmsSendClass } from "@/lib/sms/number-registration-policy";
import { createTwilioRestClient } from "@/lib/twilio-client.server";

export type VendorIdentityChannel = "email" | "sms";
export type VendorDeliveryProvider = {
  configured(channel: VendorIdentityChannel): boolean;
  email(input: { from: string; to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ id: string }>;
  sms(input: { from: string; to: string; text: string; idempotencyKey: string }): Promise<{ id: string }>;
};

/**
 * Provider adapter for the platform-owned identity only.  It deliberately does
 * not enter the manager work-number dispatcher: a sponsored vendor identity is
 * neither a manager entitlement nor a manager-funded communication.
 */
export function createVendorWorkIdentityDeliveryProvider(): VendorDeliveryProvider {
  return {
    configured(channel) {
      if (process.env.VENDOR_WORK_IDENTITY_PROVIDER_ENABLED !== "1") return false;
      return channel === "email"
        ? Boolean(process.env.RESEND_API_KEY?.trim())
        : Boolean(createTwilioRestClient());
    },
    async email(input) {
      const key = process.env.RESEND_API_KEY?.trim();
      if (!key) throw new Error("email provider is not configured");
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        body: JSON.stringify({ from: input.from, to: [input.to], subject: input.subject, text: input.text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`email provider rejected send (${response.status})`);
      const payload = (await response.json().catch(() => ({}))) as { id?: unknown };
      if (typeof payload.id !== "string" || !payload.id) throw new Error("email provider omitted message id");
      return { id: payload.id };
    },
    async sms(input) {
      const client = createTwilioRestClient();
      if (!client) throw new Error("SMS provider is not configured");
      const message = await client.messages.create({
        from: input.from,
        to: input.to,
        body: input.text,
        ...(process.env.VENDOR_WORK_IDENTITY_SMS_STATUS_CALLBACK_URL?.trim()
          ? { statusCallback: process.env.VENDOR_WORK_IDENTITY_SMS_STATUS_CALLBACK_URL.trim() }
          : {}),
      });
      if (!message.sid) throw new Error("SMS provider omitted message id");
      return { id: message.sid };
    },
  };
}

function uncertain(error: unknown) { return /timeout|network|socket|abort|econn/i.test(error instanceof Error ? error.message : String(error)); }

/** Durable vendor-sponsored delivery. This intentionally knows nothing about manager billing. */
export async function deliverVendorWorkIdentity(
  db: SupabaseClient,
  input: { vendorUserId: string; channel: VendorIdentityChannel; recipient: string; recipientUserId?: string | null; subject: string; text: string; idempotencyKey: string; contextFingerprint?: string; sendClass?: SmsSendClass },
  provider: VendorDeliveryProvider,
): Promise<{ ok: boolean; sent?: boolean; authorized?: boolean; reason?: string; providerMessageId?: string | null }> {
  const recipient = input.channel === "email" ? input.recipient.trim().toLowerCase() : normalizeE164(input.recipient);
  if (!recipient || (input.channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) || !input.idempotencyKey.trim()) return { ok: false, reason: "invalid_recipient" };
  const contextFingerprint = input.contextFingerprint?.trim() || `recipient:${recipient}|subject:${input.subject}|body:${input.text}`;
  type Replay = { status?: string; provider_message_id?: string | null; blocked_reason?: string | null; recipient?: string; context_fingerprint?: string; subject?: string | null; body?: string; channel?: string };
  const replayResult = (replay: Replay) => {
    if (
      replay.channel !== input.channel ||
      String(replay.recipient ?? "").trim().toLowerCase() !== recipient.toLowerCase() ||
      String(replay.context_fingerprint ?? "") !== contextFingerprint ||
      String(replay.subject ?? "") !== input.subject ||
      String(replay.body ?? "") !== input.text
    ) return { ok: false, sent: false, reason: "idempotency_mismatch" };
    if (replay.status === "sent") return { ok: true, sent: true, providerMessageId: replay.provider_message_id ?? null };
    if (replay.status === "reconciling" || replay.status === "authorized" || replay.status === "calling_provider") return { ok: false, sent: false, reason: "provider_outcome_unknown", providerMessageId: replay.provider_message_id ?? null, authorized: true };
    return { ok: false, sent: false, reason: replay.blocked_reason ?? "provider_rejected", providerMessageId: replay.provider_message_id ?? null, authorized: true };
  };
  // A durable outbox is the authority on replay. Inspect it before mutable
  // runtime/readiness gates so a paused provider cannot prevent repair of an
  // already accepted message, and so Twilio is never called twice.
  const { data: existingOutbox, error: existingOutboxError } = await db
    .from("vendor_work_identity_outbox")
    .select("status,provider_message_id,blocked_reason,recipient,context_fingerprint,subject,body,channel")
    .eq("vendor_user_id", input.vendorUserId)
    .eq("idempotency_key", input.idempotencyKey)
    .eq("channel", input.channel)
    .maybeSingle();
  if (existingOutboxError) return { ok: false, reason: "replay_state_unavailable" };
  if (existingOutbox) return replayResult(existingOutbox as Replay);
  const { data: runtime, error: runtimeError } = await db.from("vendor_work_identity_runtime").select("enabled").eq("singleton", true).maybeSingle();
  if (runtimeError || !(runtime as { enabled?: boolean } | null)?.enabled) return { ok: false, reason: "provider_disabled" };
  if (!provider.configured(input.channel)) return { ok: false, reason: "provider_unconfigured" };
  const { data, error } = await db.from("vendor_work_identities").select("id,email_address,phone_number,email_state,sms_state,email_send_ready,sms_send_ready,email_domain_verified").eq("vendor_user_id", input.vendorUserId).maybeSingle();
  if (error || !data) return { ok: false, reason: "identity_not_ready" };
  const row = data as Record<string, unknown>;
  const email = input.channel === "email";
  const from = String(email ? row.email_address ?? "" : row.phone_number ?? "").trim();
  const ready = email ? row.email_state === "ready" && row.email_send_ready === true && row.email_domain_verified === true : row.sms_state === "ready" && row.sms_send_ready === true;
  if (!from || !ready) return { ok: false, reason: "identity_not_ready" };
  if (!email) {
    // The route derives this class from the server-owned action type; a browser
    // cannot mark automation as a manual reply to evade quiet hours.
    if (quietHoursBlocks(input.sendClass ?? "transactional", new Date())) return { ok: false, reason: "quiet_hours" };
    const suppression = await readSmsSuppressionState(db, recipient, { userId: input.recipientUserId ?? null });
    if (!suppression.ok) return { ok: false, reason: suppression.error };
    if (suppression.optedOut) return { ok: false, reason: "recipient_opted_out" };
    // Vendor-sponsored SMS bypasses the manager dispatcher, so it must apply
    // the non-production protected-contact shield at this transport boundary.
    if (await isShieldedRecipient({ phone: recipient })) return { ok: false, reason: "protected_recipient" };
  }
  const kind = email ? "send_email" : "send_sms";
  const { data: operationData, error: operationError } = await db.rpc("claim_vendor_work_identity_operation", { p_vendor_user_id: input.vendorUserId, p_identity_id: row.id, p_operation_kind: kind, p_idempotency_key: input.idempotencyKey });
  const operation = (Array.isArray(operationData) ? operationData[0] : operationData) as { operation_id?: string; claimed?: boolean } | null;
  if (operationError || !operation?.operation_id) return { ok: false, reason: "operation_unavailable" };
  const { data: outboxData, error: outboxError } = await db.rpc("claim_vendor_work_identity_outbound", { p_vendor_user_id: input.vendorUserId, p_identity_id: row.id, p_operation_id: operation.operation_id, p_idempotency_key: input.idempotencyKey, p_channel: input.channel, p_recipient: recipient, p_context_fingerprint: contextFingerprint, p_subject: input.subject, p_body: input.text });
  const outbox = (Array.isArray(outboxData) ? outboxData[0] : outboxData) as { outbox_id?: string; claimed?: boolean; blocked_reason?: string } | null;
  if (outboxError || !outbox?.outbox_id) {
    const reason = outbox?.blocked_reason ?? "cap_or_outbox_blocked";
    await db.from("vendor_work_identity_operations").update({ state: "failed", error_code: reason, updated_at: new Date().toISOString() }).eq("id", operation.operation_id);
    return { ok: false, reason };
  }
  if (!operation.claimed || !outbox.claimed) {
    const { data: existing, error: replayError } = await db.from("vendor_work_identity_outbox").select("status,provider_message_id,blocked_reason,recipient,context_fingerprint,subject,body,channel").eq("id", outbox.outbox_id).maybeSingle();
    if (replayError || !existing) return { ok: false, reason: "replay_state_unavailable" };
    return replayResult(existing as Replay);
  }
  const { error: callingError } = await db.from("vendor_work_identity_operations").update({ state: "calling_provider", updated_at: new Date().toISOString() }).eq("id", operation.operation_id);
  if (callingError) return { ok: false, reason: "operation_unavailable", authorized: true };
  const { data: attempt, error: attemptError } = await db.from("vendor_work_identity_delivery_attempts").insert({ outbox_id: outbox.outbox_id, attempt_number: 1, state: "calling_provider" }).select("id").maybeSingle();
  if (attemptError || !(attempt as { id?: string } | null)?.id) {
    await db.from("vendor_work_identity_operations").update({ state: "failed", error_code: "attempt_unavailable", updated_at: new Date().toISOString() }).eq("id", operation.operation_id);
    await db.from("vendor_work_identity_outbox").update({ status: "blocked", blocked_reason: "attempt_unavailable", updated_at: new Date().toISOString() }).eq("id", outbox.outbox_id);
    return { ok: false, reason: "attempt_unavailable", authorized: true };
  }
  let providerAccepted = false;
  let acceptedId: string | null = null;
  try {
    // Twilio's Messages API has no idempotency-key parameter. The claimed
    // operation/outbox is therefore the single provider-call fence; uncertain
    // outcomes stay reconciling and never receive a blind retry.
    const result = email ? await provider.email({ from, to: recipient, subject: input.subject, text: input.text, idempotencyKey: input.idempotencyKey }) : await provider.sms({ from, to: recipient, text: input.text, idempotencyKey: input.idempotencyKey });
    providerAccepted = true;
    acceptedId = result.id;
    const { error: attemptPersistError } = await db.from("vendor_work_identity_delivery_attempts").update({ state: "sent", provider_message_id: result.id }).eq("id", (attempt as { id: string }).id);
    if (attemptPersistError) throw new Error(attemptPersistError.message);
    const { error: persistError } = await db.from("vendor_work_identity_outbox").update({ status: "sent", provider_message_id: result.id, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", outbox.outbox_id);
    if (persistError) throw new Error(persistError.message);
    const { error: operationPersistError } = await db.from("vendor_work_identity_operations").update({ state: "succeeded", provider_reference: result.id, updated_at: new Date().toISOString() }).eq("id", operation.operation_id);
    if (operationPersistError) throw new Error(operationPersistError.message);
    return { ok: true, sent: true, providerMessageId: result.id };
  } catch (error) {
    const reconcile = providerAccepted || uncertain(error);
    await db.from("vendor_work_identity_delivery_attempts").update({ state: reconcile ? "reconciling" : "failed", provider_message_id: acceptedId, error_code: reconcile ? "provider_outcome_unknown" : "provider_rejected" }).eq("id", (attempt as { id: string }).id);
    await db.from("vendor_work_identity_operations").update({ state: reconcile ? "reconciling" : "failed", provider_reference: acceptedId, error_code: reconcile ? "provider_outcome_unknown" : "provider_rejected", updated_at: new Date().toISOString() }).eq("id", operation.operation_id);
    const { error: persistError } = await db.from("vendor_work_identity_outbox").update({ status: reconcile ? "reconciling" : "failed", provider_message_id: acceptedId, blocked_reason: reconcile ? "provider_outcome_unknown" : "provider_rejected", updated_at: new Date().toISOString() }).eq("id", outbox.outbox_id);
    if (persistError) throw new Error(persistError.message);
    return { ok: false, reason: reconcile ? "provider_outcome_unknown" : "provider_rejected", authorized: true };
  }
}
