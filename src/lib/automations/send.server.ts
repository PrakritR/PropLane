import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { ensureApplicationScopedSmsConsent } from "@/lib/sms/application-consent.server";
import { buildConversationKey } from "@/lib/sms-conversation-identity";

export type AutomationSendResult =
  | { ok: true }
  /** `retry`: a quiet-hours or budget refusal, try again on a later tick. Otherwise final. */
  | { ok: false; retry: boolean; reason: string };

/**
 * One preset text to one resident: through the shared-line sender when the workspace is on it,
 * otherwise from the workspace's work number exactly as every other automated text goes (scoped
 * automated consent, quiet hours, opt-out and wallet are all enforced by the transport).
 */
export async function sendResidentAutomationText(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    ownerUserId: string;
    phoneKey: string;
    residentUserId: string | null;
    residentEmail: string | null;
    text: string;
    idempotencyKey: string;
  },
): Promise<AutomationSendResult> {
  const to = normalizeE164(input.phoneKey);
  if (!to) return { ok: false, retry: false, reason: "bad_phone" };

  const config = await loadSharedLineConfig(db);
  if (workspaceOnSharedLine(config, input.workspaceId)) {
    const result = await sendSharedLineMessage(db, {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      toPhone: to,
      body: input.text,
      role: "resident",
      idempotencyKey: `automation:${input.idempotencyKey}`,
    });
    if (result.ok) return { ok: true };
    if (result.reason !== "not_shared_mode") {
      return { ok: false, retry: result.reason === "quiet_hours" || result.reason === "budget", reason: result.reason };
    }
  }

  const conversationKey = buildConversationKey({
    ownerManagerUserId: input.ownerUserId,
    role: "resident",
    counterpartyUserId: input.residentUserId ?? undefined,
    counterpartyPhone: to,
  });
  const consent = await ensureApplicationScopedSmsConsent(db, {
    managerUserId: input.ownerUserId,
    recipientPhone: to,
    recipientEmail: input.residentEmail,
    recipientUserId: input.residentUserId,
    purpose: "preset_automation",
    sendClass: "automated",
    conversationKey,
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() ?? null,
  });
  if (!consent.ok || !consent.granted) return { ok: false, retry: false, reason: "no_consent" };

  const sent = await sendFromManagerWorkNumber({
    managerUserId: input.ownerUserId,
    workspaceId: input.workspaceId,
    to,
    text: input.text,
    sendClass: "automated",
    purpose: "preset_automation",
    counterpartyRole: "resident",
    conversationKey,
    residentUserId: input.residentUserId,
    residentEmail: input.residentEmail,
    dedupeKey: `automation:${input.idempotencyKey}`,
  });
  if (sent.ok) return { ok: true };
  const error = String(sent.error ?? "");
  if (error === "quiet_hours" || error.includes("budget") || error.startsWith("credit_") || error.startsWith("comms_billing_")) {
    return { ok: false, retry: true, reason: error };
  }
  if (error === "recipient_opted_out") return { ok: false, retry: false, reason: "opted_out" };
  return { ok: false, retry: false, reason: error || "provider_error" };
}
