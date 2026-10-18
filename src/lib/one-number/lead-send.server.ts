import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig } from "@/lib/one-number/config.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { quietHoursBlocks } from "@/lib/sms/number-registration-policy";
import { createTwilioRestClient } from "@/lib/twilio-client.server";

export type PlatformLeadSendResult =
  | { ok: true; sid: string }
  | { ok: false; reason: "not_shared_mode" | "no_shared_number" | "invalid_to" | "opted_out" | "quiet_hours" | "shielded" | "provider_error" | "delivery_unknown" };

/**
 * A text from PropLane itself on the shared number, to a lead that has no team yet (the quiet-lead
 * nudges). There is no workspace to bill or sign off for, so this is not `sendSharedLineMessage`.
 * It keeps every gate a send has: shared mode only, the opt-out ledger, quiet hours (automated
 * class), and the real-customer shield outside production. Scheduled nudges stay automated.
 * Only an explicitly requested, consented homepage demo link is transactional:
 * it answers a live request rather than starting an unsolicited conversation.
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
  if (await isPhoneOptedOut(db, to).catch(() => false)) return { ok: false, reason: "opted_out" };
  const { isShieldedRecipient } = await import("@/lib/protected-accounts.server");
  if (await isShieldedRecipient({ phone: to })) return { ok: false, reason: "shielded" };
  const client = createTwilioRestClient();
  if (!client) return { ok: false, reason: "provider_error" };
  const statusCallback = process.env.TWILIO_STATUS_CALLBACK_URL?.trim();
  try {
    const message = await client.messages.create({
      to,
      body: input.body,
      ...(config.messagingServiceSid ? { messagingServiceSid: config.messagingServiceSid } : { from: config.sharedNumber }),
      ...(input.mediaUrls?.length ? { mediaUrl: input.mediaUrls.slice(0, 1) } : {}),
      ...(statusCallback ? { statusCallback } : {}),
    });
    return { ok: true, sid: message.sid };
  } catch (error) {
    // Twilio's client already cancels requests at its 30-second timeout. A
    // lost response can follow acceptance, so never retry or call that unsent.
    const status = error && typeof error === "object" && "status" in error ? Number(error.status) : 0;
    return { ok: false, reason: status >= 400 && status < 500 ? "provider_error" : "delivery_unknown" };
  }
}
