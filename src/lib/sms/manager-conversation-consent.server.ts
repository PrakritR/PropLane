import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readScopedSmsConsentState, readSmsSuppressionState, recordScopedSmsConsent } from "@/lib/sms-consent";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import type { ManagerSmsInboundIdentity } from "./manager-sms-access.server";

/** Called only after webhook signature + verified actor resolution. This
 * evidence permits replies in this assistant conversation, not tenant sends,
 * forwarding, or marketing. A previous STOP/revoke is never overwritten.
 */
export async function ensureManagerInboundReplyConsent(
  db: SupabaseClient,
  identity: ManagerSmsInboundIdentity,
  messageSid: string,
): Promise<"allowed" | "suppressed" | "unavailable"> {
  if (!messageSid.trim()) return "unavailable";
  const suppression = await readSmsSuppressionState(db, identity.actorPhone);
  if (!suppression.ok) return "unavailable";
  if (suppression.optedOut) return "suppressed";
  const scope = {
    managerUserId: identity.workNumberOwnerId,
    purpose: "manager_conversation",
    sendClass: "transactional" as const,
    conversationKey: buildConversationKey({
      ownerManagerUserId: identity.workNumberOwnerId,
      role: "manager",
      counterpartyUserId: identity.actorUserId,
      counterpartyPhone: identity.actorPhone,
    }),
    messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || null,
  };
  const current = await readScopedSmsConsentState(db, identity.actorPhone, scope);
  if (!current.ok) return "unavailable";
  if (current.state === "revoked") return "suppressed";
  if (current.state === "granted") return "allowed";
  const recorded = await recordScopedSmsConsent(db, identity.actorPhone, {
    ...scope, eventType: "granted", source: "verified_manager_inbound",
    evidence: { messageSid, actorUserId: identity.actorUserId },
  });
  return recorded.ok ? "allowed" : "unavailable";
}
