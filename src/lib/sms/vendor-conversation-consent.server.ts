import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readScopedSmsConsentState, recordScopedSmsConsent, readSmsSuppressionState } from "@/lib/sms-consent";
import { buildConversationKey } from "@/lib/sms-conversation-identity";

/** Evidence is derived by the vendor runtime from a verified inbound webhook or
 * the server-owned vendor consent/invitation. It is never supplied by a model. */
export async function ensureVendorConversationConsent(db: SupabaseClient, input: {
  managerUserId: string; vendorUserId: string | null; phone: string; sessionId: string;
  evidence: { inboundMessageSid: string } | { consentAt: string } | { invitedVendorDirectoryId: string };
}): Promise<{ allowed: boolean; conversationKey: string }> {
  const conversationKey = buildConversationKey({ ownerManagerUserId: input.managerUserId,
    role: "vendor", counterpartyUserId: input.vendorUserId, counterpartyPhone: input.phone });
  const scope = { managerUserId: input.managerUserId, purpose: "vendor_conversation", sendClass: "transactional" as const,
    conversationKey, messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null };
  if (!scope.messagingServiceSid) throw new Error("Vendor messaging is not configured.");
  const suppression = await readSmsSuppressionState(db, input.phone, { userId: input.vendorUserId });
  if (!suppression.ok) throw new Error("Vendor SMS consent could not be verified.");
  if (suppression.optedOut) return { allowed: false, conversationKey };
  const current = await readScopedSmsConsentState(db, input.phone, scope);
  if (!current.ok) throw new Error("Vendor SMS consent could not be verified.");
  if (current.state === "revoked") return { allowed: false, conversationKey };
  if (current.state === "granted") return { allowed: true, conversationKey };
  const recorded = await recordScopedSmsConsent(db, input.phone, { ...scope, eventType: "granted",
    source: "inboundMessageSid" in input.evidence ? "verified_vendor_inbound" : "vendor_job_consent",
    evidence: { sessionId: input.sessionId, ...input.evidence },
    ...("consentAt" in input.evidence ? { occurredAt: input.evidence.consentAt } : {}),
  });
  if (!recorded.ok) throw new Error("Vendor SMS consent could not be saved.");
  return { allowed: true, conversationKey };
}
