import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import { readSmsSuppressionState } from "@/lib/sms-consent";
import { isShieldedRecipient } from "@/lib/protected-accounts.server";
import type { VendorDeliveryProvider } from "@/lib/vendor-work-identity-delivery.server";
import type { ResidentAgentNumber } from "./number.server";

export type ResidentAgentSendResult = { ok: true; providerMessageId: string } | { ok: false; reason: string };

/**
 * Why a text from this number could not leave right now (read-only), or null. Checked BEFORE the
 * model runs, so a reply that could never be delivered is never paid for. Any unreadable state is a
 * block.
 */
export async function residentAgentSendBlocker(
  db: SupabaseClient,
  args: { number: ResidentAgentNumber; recipient: string; provider: VendorDeliveryProvider },
): Promise<string | null> {
  try {
    if (!args.number.sendReady) return "number_not_send_ready";
    if (!args.provider.configured("sms")) return "provider_unconfigured";
    const { data: runtime, error } = await db.from("vendor_work_identity_runtime").select("enabled").eq("singleton", true).maybeSingle();
    if (error || (runtime as { enabled?: boolean } | null)?.enabled !== true) return "provider_disabled";
    const suppression = await readSmsSuppressionState(db, args.recipient, { userId: args.number.residentUserId });
    if (!suppression.ok) return suppression.error;
    if (suppression.optedOut) return "recipient_opted_out";
    if (await isShieldedRecipient({ phone: args.recipient })) return "protected_recipient";
    return null;
  } catch {
    return "blocker_check_failed";
  }
}

/**
 * Send one text from the resident's own number to a recipient, with the same gates as every other
 * platform-owned line (STOP, protected contacts, provider switch). The caller has ALREADY reserved
 * the credit for it and settles or releases it from this result; this function never touches money.
 * The text leaves from the resident's number and nowhere else.
 */
export async function sendFromResidentNumber(
  db: SupabaseClient,
  args: { number: ResidentAgentNumber; to: string; text: string; idempotencyKey: string; provider: VendorDeliveryProvider },
): Promise<ResidentAgentSendResult> {
  const to = normalizeE164(args.to);
  if (!to || !args.text.trim()) return { ok: false, reason: "invalid_recipient" };
  const blocker = await residentAgentSendBlocker(db, { number: args.number, recipient: to, provider: args.provider });
  if (blocker) return { ok: false, reason: blocker };
  try {
    const result = await args.provider.sms({ from: args.number.phoneNumber, to, text: args.text, idempotencyKey: args.idempotencyKey });
    return { ok: true, providerMessageId: result.id };
  } catch (error) {
    // Twilio has no idempotency key: an uncertain outcome is NOT retried by anyone.
    return { ok: false, reason: error instanceof Error && /timeout|network|socket|abort|econn/i.test(error.message) ? "provider_outcome_unknown" : "provider_rejected" };
  }
}
