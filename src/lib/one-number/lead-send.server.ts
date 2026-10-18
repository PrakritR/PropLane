import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { quietHoursBlocks } from "@/lib/sms/number-registration-policy";
import { sendSms } from "@/lib/twilio";

export type PlatformLeadSendResult =
  | { ok: true; sid: string }
  | { ok: false; reason: "not_shared_mode" | "no_shared_number" | "invalid_to" | "opted_out" | "quiet_hours" | "shielded" | "provider_error" };

/**
 * A text from PropLane itself on the shared number, to a lead that has no team yet (the quiet-lead
 * nudges). There is no workspace to bill or sign off for, so this is not `sendSharedLineMessage`.
 * It goes through the one provider call, `sendSms` (purpose `platform_lead`: valid only from the
 * configured shared number, no credit hold), which keeps the opt-out ledger, the real-customer
 * shield and test capture. Here: shared mode only and quiet hours (automated class). Platform
 * lead texts are not metered anywhere yet (no platform usage meter exists); they bill no workspace.
 * The 24h / 72h scheduler is the only caller.
 */
export async function sendPlatformLeadText(
  db: SupabaseClient,
  input: { to: string; body: string; mediaUrls?: string[]; now?: Date },
): Promise<PlatformLeadSendResult> {
  const config = await loadSharedLineConfig(db);
  if (config.mode !== "shared") return { ok: false, reason: "not_shared_mode" };
  if (!config.sharedNumber) return { ok: false, reason: "no_shared_number" };
  const to = normalizeE164(input.to);
  if (!to) return { ok: false, reason: "invalid_to" };
  if (quietHoursBlocks("automated", input.now ?? new Date())) return { ok: false, reason: "quiet_hours" };
  const result = await sendSms(to, input.body, config.sharedNumber, {
    purpose: "platform_lead",
    messagingServiceSid: config.messagingServiceSid,
    ...(input.mediaUrls?.length ? { mediaUrls: input.mediaUrls.slice(0, 1) } : {}),
  }).catch(() => ({ sent: false as const, error: "provider_error", sid: undefined }));
  if (result.sent && result.sid) return { ok: true, sid: result.sid };
  if (result.error === "recipient_opted_out") return { ok: false, reason: "opted_out" };
  if (result.error === "protected_account_shielded") return { ok: false, reason: "shielded" };
  return { ok: false, reason: "provider_error" };
}
