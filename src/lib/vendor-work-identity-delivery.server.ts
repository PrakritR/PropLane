import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { normalizeE164 } from "@/lib/twilio";

export type VendorIdentityChannel = "email" | "sms";
export type VendorDeliveryProvider = {
  configured(channel: VendorIdentityChannel): boolean;
  email(input: { from: string; to: string; subject: string; text: string }): Promise<{ id: string }>;
  sms(input: { from: string; to: string; text: string }): Promise<{ id: string }>;
};

function uncertain(error: unknown) { return /timeout|network|socket|abort|econn/i.test(error instanceof Error ? error.message : String(error)); }

/** Durable vendor-sponsored delivery. This intentionally knows nothing about manager billing. */
export async function deliverVendorWorkIdentity(
  db: SupabaseClient,
  input: { vendorUserId: string; channel: VendorIdentityChannel; recipient: string; recipientUserId?: string | null; subject: string; text: string; idempotencyKey: string },
  provider: VendorDeliveryProvider,
): Promise<{ ok: boolean; sent?: boolean; reason?: string; providerMessageId?: string | null }> {
  const { data: runtime, error: runtimeError } = await db.from("vendor_work_identity_runtime").select("enabled").eq("singleton", true).maybeSingle();
  if (runtimeError || !(runtime as { enabled?: boolean } | null)?.enabled) return { ok: false, reason: "provider_disabled" };
  if (!provider.configured(input.channel)) return { ok: false, reason: "provider_unconfigured" };
  const recipient = input.channel === "email" ? input.recipient.trim().toLowerCase() : normalizeE164(input.recipient);
  if (!recipient || (input.channel === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) || !input.idempotencyKey.trim()) return { ok: false, reason: "invalid_recipient" };
  const { data, error } = await db.from("vendor_work_identities").select("id,email_address,phone_number,email_state,sms_state,email_send_ready,sms_send_ready,email_domain_verified").eq("vendor_user_id", input.vendorUserId).maybeSingle();
  if (error || !data) return { ok: false, reason: "identity_not_ready" };
  const row = data as Record<string, unknown>;
  const email = input.channel === "email";
  const from = String(email ? row.email_address ?? "" : row.phone_number ?? "").trim();
  const ready = email ? row.email_state === "ready" && row.email_send_ready === true && row.email_domain_verified === true : row.sms_state === "ready" && row.sms_send_ready === true;
  if (!from || !ready) return { ok: false, reason: "identity_not_ready" };
  if (!email) {
    const suppression = await readSmsSuppressionState(db, recipient, { userId: input.recipientUserId ?? null });
    if (!suppression.ok) return { ok: false, reason: suppression.error };
    if (suppression.optedOut) return { ok: false, reason: "recipient_opted_out" };
  }
  const kind = email ? "send_email" : "send_sms";
  const { data: operationData, error: operationError } = await db.rpc("claim_vendor_work_identity_operation", { p_vendor_user_id: input.vendorUserId, p_identity_id: row.id, p_operation_kind: kind, p_idempotency_key: input.idempotencyKey });
  const operation = (Array.isArray(operationData) ? operationData[0] : operationData) as { operation_id?: string; claimed?: boolean } | null;
  if (operationError || !operation?.operation_id) return { ok: false, reason: "operation_unavailable" };
  if (!operation.claimed) return { ok: true, sent: false, providerMessageId: null };
  const { data: outboxData, error: outboxError } = await db.rpc("claim_vendor_work_identity_outbound", { p_vendor_user_id: input.vendorUserId, p_identity_id: row.id, p_operation_id: operation.operation_id, p_idempotency_key: input.idempotencyKey, p_channel: input.channel, p_recipient: recipient, p_subject: input.subject, p_body: input.text });
  const outbox = (Array.isArray(outboxData) ? outboxData[0] : outboxData) as { outbox_id?: string; claimed?: boolean; blocked_reason?: string } | null;
  if (outboxError || !outbox?.outbox_id) return { ok: false, reason: outbox?.blocked_reason ?? "cap_or_outbox_blocked" };
  if (!outbox.claimed) return { ok: true, sent: false, providerMessageId: null };
  try {
    const result = email ? await provider.email({ from, to: input.recipient, subject: input.subject, text: input.text }) : await provider.sms({ from, to: input.recipient, text: input.text });
    const { error: persistError } = await db.from("vendor_work_identity_outbox").update({ status: "sent", provider_message_id: result.id, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", outbox.outbox_id);
    if (persistError) throw new Error(persistError.message);
    return { ok: true, sent: true, providerMessageId: result.id };
  } catch (error) {
    const { error: persistError } = await db.from("vendor_work_identity_outbox").update({ status: uncertain(error) ? "reconciling" : "failed", blocked_reason: uncertain(error) ? "provider_outcome_unknown" : "provider_rejected", updated_at: new Date().toISOString() }).eq("id", outbox.outbox_id);
    if (persistError) throw new Error(persistError.message);
    return { ok: false, reason: uncertain(error) ? "provider_outcome_unknown" : "provider_rejected" };
  }
}
