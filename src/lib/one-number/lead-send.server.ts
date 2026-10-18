import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { quietHoursBlocks } from "@/lib/sms/number-registration-policy";
import { sendSms } from "@/lib/twilio";

export type PlatformLeadSendResult =
  | { ok: true; sid: string }
  | { ok: false; reason: "not_shared_mode" | "no_shared_number" | "invalid_to" | "opted_out" | "quiet_hours" | "shielded" | "provider_error" | "delivery_unknown" };

/**
 * A text from PropLane itself on the shared number, to a lead that has no team yet (the quiet-lead
 * nudges). There is no workspace to bill or sign off for, so this is not `sendSharedLineMessage`.
 * It uses the consolidated `sendSms` transport (purpose `platform_lead`), which requires
 * the configured shared number and preserves opt-out, recipient shielding and test capture.
 * No workspace is billed. Scheduled nudges keep automated quiet hours; an explicitly
 * requested, consented homepage demo link is an immediate transactional reply.
 */
export async function sendPlatformLeadText(
  db: SupabaseClient,
  input: { to: string; body: string; mediaUrls?: string[]; now?: Date; purpose?: "requested_demo_link" },
): Promise<PlatformLeadSendResult> {
  const config = await loadSharedLineConfig(db);
  if (config.mode !== "shared") return { ok: false, reason: "not_shared_mode" };
  if (!config.sharedNumber) return { ok: false, reason: "no_shared_number" };
  const to = normalizeE164(input.to);
  if (!to) return { ok: false, reason: "invalid_to" };
  const sendClass = input.purpose === "requested_demo_link" ? "transactional" : "automated";
  if (quietHoursBlocks(sendClass, input.now ?? new Date())) return { ok: false, reason: "quiet_hours" };
  const result = await sendSms(to, input.body, config.sharedNumber, {
    purpose: "platform_lead",
    messagingServiceSid: config.messagingServiceSid,
    ...(input.mediaUrls?.length ? { mediaUrls: input.mediaUrls.slice(0, 1) } : {}),
  }).catch(() => ({ sent: false as const, error: "provider_error", providerAttempted: false, sid: undefined }));
  if (result.sent && result.sid) return { ok: true, sid: result.sid };
  if (result.error === "recipient_opted_out") return { ok: false, reason: "opted_out" };
  if (result.error === "protected_account_shielded") return { ok: false, reason: "shielded" };
  // sendSms catches provider exceptions but intentionally exposes no HTTP status.
  // Once attempted, a lost response may follow acceptance: never retry or claim unsent.
  if (result.providerAttempted || result.sent) return { ok: false, reason: "delivery_unknown" };
  return { ok: false, reason: "provider_error" };
}
