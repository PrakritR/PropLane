import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;
export type PaymentReminderChannel = "email" | "sms" | "inbox";
export type PaymentReminderChannelStatus = "submitted" | "failed" | "unknown" | "skipped";

export type PaymentReminderOccurrence = {
  id: string;
  managerUserId: string;
  recipientEmail: string;
  chargeIds: string[];
  dedupIds: string[];
  subject: string;
  body: string;
};

/** The existing per-charge alias is stable across cron and Send now. */
export function paymentReminderOccurrenceId(managerUserId: string, primaryDedupId: string): string {
  return `payment:${managerUserId}:${primaryDedupId}`;
}

export async function claimPaymentReminderChannel(
  db: ServiceDb,
  occurrence: PaymentReminderOccurrence,
  channel: PaymentReminderChannel,
): Promise<{ outcome: "claimed"; token: string } | { outcome: string; token: null }> {
  const { data, error } = await db.rpc("claim_payment_reminder_channel", {
    p_occurrence_id: occurrence.id,
    p_manager_user_id: occurrence.managerUserId,
    p_recipient_email: occurrence.recipientEmail,
    p_charge_ids: [...new Set(occurrence.chargeIds)].sort(),
    p_dedup_ids: [...new Set(occurrence.dedupIds)].sort(),
    p_subject: occurrence.subject,
    p_body: occurrence.body,
    p_channel: channel,
  });
  if (error) throw new Error(`Could not claim ${channel} reminder: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (row?.outcome === "claimed" && typeof row.token === "string") {
    return { outcome: "claimed", token: row.token };
  }
  if (!row?.outcome) throw new Error(`Could not claim ${channel} reminder: empty result`);
  return { outcome: String(row.outcome), token: null };
}

export async function resolvePaymentReminderChannel(
  db: ServiceDb,
  occurrenceId: string,
  channel: PaymentReminderChannel,
  token: string,
  status: PaymentReminderChannelStatus,
  providerReference?: string | null,
  errorMessage?: string | null,
): Promise<void> {
  const { data, error } = await db.rpc("resolve_payment_reminder_channel", {
    p_occurrence_id: occurrenceId,
    p_channel: channel,
    p_token: token,
    p_status: status,
    p_provider_reference: providerReference ?? null,
    p_error: errorMessage ?? null,
  });
  if (error) throw new Error(`Could not record ${channel} reminder: ${error.message}`);
  if (data !== true) throw new Error(`Lost ${channel} reminder claim`);
}
