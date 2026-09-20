import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { normalizeE164 } from "@/lib/twilio";

export type VendorIdentityChannel = "email" | "sms";
export type VendorDeliveryProvider = {
  configured(channel: VendorIdentityChannel): boolean;
  email(input: { from: string; to: string; subject: string; text: string; idempotencyKey: string }): Promise<{ id: string }>;
  sms(input: { from: string; to: string; text: string; idempotencyKey: string }): Promise<{ id: string }>;
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
  const { data: outboxData, error: outboxError } = await db.rpc("claim_vendor_work_identity_outbound", { p_vendor_user_id: input.vendorUserId, p_identity_id: row.id, p_operation_id: operation.operation_id, p_idempotency_key: input.idempotencyKey, p_channel: input.channel, p_recipient: recipient, p_subject: input.subject, p_body: input.text });
  const outbox = (Array.isArray(outboxData) ? outboxData[0] : outboxData) as { outbox_id?: string; claimed?: boolean; blocked_reason?: string } | null;
  if (outboxError || !outbox?.outbox_id) return { ok: false, reason: outbox?.blocked_reason ?? "cap_or_outbox_blocked" };
  if (!operation.claimed || !outbox.claimed) {
    const { data: existing } = await db.from("vendor_work_identity_outbox").select("status,provider_message_id").eq("id", outbox.outbox_id).maybeSingle();
    return { ok: true, sent: (existing as { status?: string } | null)?.status === "sent", providerMessageId: (existing as { provider_message_id?: string | null } | null)?.provider_message_id ?? null };
  }
  const { error: callingError } = await db.from("vendor_work_identity_operations").update({ state: "calling_provider", updated_at: new Date().toISOString() }).eq("id", operation.operation_id);
  if (callingError) return { ok: false, reason: "operation_unavailable" };
  const { data: attempt, error: attemptError } = await db.from("vendor_work_identity_delivery_attempts").insert({ outbox_id: outbox.outbox_id, attempt_number: 1, state: "calling_provider" }).select("id").maybeSingle();
  if (attemptError || !(attempt as { id?: string } | null)?.id) return { ok: false, reason: "attempt_unavailable" };
  let providerAccepted = false;
  try {
    const result = email ? await provider.email({ from, to: recipient, subject: input.subject, text: input.text, idempotencyKey: input.idempotencyKey }) : await provider.sms({ from, to: recipient, text: input.text, idempotencyKey: input.idempotencyKey });
    providerAccepted = true;
    const { error: attemptPersistError } = await db.from("vendor_work_identity_delivery_attempts").update({ state: "sent", provider_message_id: result.id }).eq("id", (attempt as { id: string }).id);
    if (attemptPersistError) throw new Error(attemptPersistError.message);
    const { error: persistError } = await db.from("vendor_work_identity_outbox").update({ status: "sent", provider_message_id: result.id, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", outbox.outbox_id);
    if (persistError) throw new Error(persistError.message);
    const { error: operationPersistError } = await db.from("vendor_work_identity_operations").update({ state: "succeeded", provider_reference: result.id, updated_at: new Date().toISOString() }).eq("id", operation.operation_id);
    if (operationPersistError) throw new Error(operationPersistError.message);
    return { ok: true, sent: true, providerMessageId: result.id };
  } catch (error) {
    const reconcile = providerAccepted || uncertain(error);
    await db.from("vendor_work_identity_delivery_attempts").update({ state: reconcile ? "reconciling" : "failed", error_code: reconcile ? "provider_outcome_unknown" : "provider_rejected" }).eq("id", (attempt as { id: string }).id);
    await db.from("vendor_work_identity_operations").update({ state: reconcile ? "reconciling" : "failed", error_code: reconcile ? "provider_outcome_unknown" : "provider_rejected", updated_at: new Date().toISOString() }).eq("id", operation.operation_id);
    const { error: persistError } = await db.from("vendor_work_identity_outbox").update({ status: reconcile ? "reconciling" : "failed", blocked_reason: reconcile ? "provider_outcome_unknown" : "provider_rejected", updated_at: new Date().toISOString() }).eq("id", outbox.outbox_id);
    if (persistError) throw new Error(persistError.message);
    return { ok: false, reason: reconcile ? "provider_outcome_unknown" : "provider_rejected" };
  }
}
