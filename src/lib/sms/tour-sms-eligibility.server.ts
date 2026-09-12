import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/twilio";
import { buildConversationKey } from "@/lib/sms-conversation-identity";
import {
  normalizeConsentPhone,
  readScopedSmsConsentState,
  readSmsSuppressionState,
  recordScopedSmsConsent,
} from "@/lib/sms-consent";

export type TourSmsEligibility =
  | {
      eligible: true;
      phoneE164: string;
      conversationKey: string;
      provenance: "tour_inquiry_opt_in" | "recipient_initiated_inbound" | "twilio_start";
    }
  | { eligible: false; reason: string };

type ConsentEvent = {
  event_type?: string | null;
  source?: string | null;
  occurred_at?: string | null;
  evidence?: Record<string, unknown> | null;
};

type ConversationConsentSource = "recipient_initiated_inbound" | "twilio_start";

const conversationSources = new Set<ConversationConsentSource>([
  "recipient_initiated_inbound",
  "twilio_start",
]);

function isConversationConsentSource(source: string | null | undefined): source is ConversationConsentSource {
  return conversationSources.has(source as ConversationConsentSource);
}

function derivesFromConversation(event: ConsentEvent | null): boolean {
  return event?.evidence?.conversationPurpose === "manager_conversation";
}

async function readLatestScopedEvent(
  db: SupabaseClient,
  input: {
    phoneKey: string;
    managerUserId: string;
    messagingServiceSid: string;
    purpose: string;
    conversationKey: string;
  },
): Promise<{ ok: true; event: ConsentEvent | null } | { ok: false }> {
  const { data, error } = await db
    .from("sms_consent_events")
    .select("event_type, source, occurred_at, evidence")
    .eq("recipient_phone_key", input.phoneKey)
    .eq("manager_user_id", input.managerUserId)
    .eq("messaging_service_sid", input.messagingServiceSid)
    .eq("purpose", input.purpose)
    .eq("send_class", "transactional")
    .eq("conversation_key", input.conversationKey)
    .order("occurred_at", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1);
  return error ? { ok: false } : { ok: true, event: (data?.[0] as ConsentEvent | undefined) ?? null };
}

/**
 * Final outbox-boundary check for a tour-purpose grant.  It deliberately
 * leaves explicit opt-in and independently restored purpose grants alone;
 * only evidence that says it was derived from a manager conversation must
 * continue to have that exact source authority when the provider is called.
 */
export async function validateTourSmsPurposeAtDispatch(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    guestPhone: string;
    purpose: string;
    conversationKey?: string | null;
    messagingServiceSid: string;
  },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const managerUserId = input.managerUserId.trim();
  const phoneE164 = normalizeE164(input.guestPhone);
  const purpose = input.purpose.trim();
  const messagingServiceSid = input.messagingServiceSid.trim();
  const conversationKey = input.conversationKey?.trim() ?? "";
  if (!managerUserId || !phoneE164 || !purpose || !messagingServiceSid || !conversationKey) {
    return { ok: false, reason: "invalid_sms_scope" };
  }
  const purposeEvent = await readLatestScopedEvent(db, {
    phoneKey: normalizeConsentPhone(phoneE164), managerUserId, messagingServiceSid, purpose, conversationKey,
  });
  if (!purposeEvent.ok) return { ok: false, reason: "scoped_consent_unreadable" };
  if (purposeEvent.event?.event_type !== "granted") return { ok: false, reason: "scoped_consent_missing" };
  if (!derivesFromConversation(purposeEvent.event)) return { ok: true };
  const conversation = await readLatestScopedEvent(db, {
    phoneKey: normalizeConsentPhone(phoneE164), managerUserId, messagingServiceSid,
    purpose: "manager_conversation", conversationKey,
  });
  if (!conversation.ok) return { ok: false, reason: "conversation_consent_unreadable" };
  return conversation.event?.event_type === "granted" && isConversationConsentSource(conversation.event.source)
    ? { ok: true }
    : { ok: false, reason: "tour_sms_consent_missing" };
}

/**
 * The only positive authorization for a tour lifecycle SMS.  A legacy
 * `smsConsent` flag remains a record of a web checkbox, not the send-time
 * authority: an authenticated prospect's inbound text is equally valid only
 * inside this manager/service/prospect conversation and transactional scope.
 */
export async function resolveTourSmsEligibility(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    guestPhone: string | null | undefined;
    explicitOptIn: boolean;
    purpose: string;
    allowConversationEvidence?: boolean;
    inquiryId?: string | null;
  },
): Promise<TourSmsEligibility> {
  const managerUserId = input.managerUserId.trim();
  const phoneE164 = normalizeE164(input.guestPhone ?? "");
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  const purposeName = input.purpose.trim();
  if (!managerUserId || !phoneE164 || !messagingServiceSid || !purposeName) {
    return { eligible: false, reason: "invalid_sms_scope" };
  }
  const suppression = await readSmsSuppressionState(db, phoneE164);
  if (!suppression.ok) return { eligible: false, reason: suppression.error };
  if (suppression.optedOut) return { eligible: false, reason: "recipient_opted_out" };
  const conversationKey = buildConversationKey({
    ownerManagerUserId: managerUserId,
    role: "prospect",
    counterpartyPhone: phoneE164,
  });
  const phoneKey = normalizeConsentPhone(phoneE164);
  const tourScope = { managerUserId, messagingServiceSid, purpose: purposeName, sendClass: "transactional" as const, conversationKey };
  const purpose = await readScopedSmsConsentState(db, phoneE164, tourScope);
  if (!purpose.ok) return { eligible: false, reason: purpose.error };
  if (purpose.state === "revoked") return { eligible: false, reason: "tour_sms_revoked" };
  if (!input.explicitOptIn && input.allowConversationEvidence === false) {
    return { eligible: false, reason: "tour_sms_consent_missing" };
  }
  // The lifecycle sender may already have materialized this exact-purpose
  // grant before it writes the reschedule reply proposal. Source remains part
  // of the authorization: another product's purpose event is never evidence.
  if (purpose.state === "granted") {
    const currentPurpose = await readLatestScopedEvent(db, {
      phoneKey,
      managerUserId,
      messagingServiceSid,
      purpose: purposeName,
      conversationKey,
    });
    if (!currentPurpose.ok) return { eligible: false, reason: "scoped_consent_unreadable" };
    const source = currentPurpose.event?.source;
    if (
      currentPurpose.event?.event_type !== "granted" ||
      (source !== "tour_inquiry_opt_in" && source !== "recipient_initiated_inbound" && source !== "twilio_start")
    ) {
      return { eligible: false, reason: "tour_sms_consent_missing" };
    }
    // Source alone is intentionally not enough: START can independently
    // restore a purpose.  Only grants explicitly materialized from the exact
    // manager conversation inherit that conversation's revocation lifecycle.
    if (derivesFromConversation(currentPurpose.event)) {
      const currentConversation = await readLatestScopedEvent(db, {
        phoneKey,
        managerUserId,
        messagingServiceSid,
        purpose: "manager_conversation",
        conversationKey,
      });
      if (!currentConversation.ok) return { eligible: false, reason: "conversation_consent_unreadable" };
      if (
        currentConversation.event?.event_type !== "granted" ||
        !isConversationConsentSource(currentConversation.event.source)
      ) {
        return { eligible: false, reason: "tour_sms_consent_missing" };
      }
    }
    return { eligible: true, phoneE164, conversationKey, provenance: source };
  }
  if (input.explicitOptIn) {
    const recorded = await recordScopedSmsConsent(db, phoneE164, {
      ...tourScope,
      eventType: "granted",
      source: "tour_inquiry_opt_in",
      wordingVersion: "tour-sms-consent-v1",
      evidence: { inquiryId: input.inquiryId?.trim() || null },
    });
    if (!recorded.ok) return { eligible: false, reason: recorded.error };
    return { eligible: true, phoneE164, conversationKey, provenance: "tour_inquiry_opt_in" };
  }
  const conversation = await readLatestScopedEvent(db, {
    phoneKey,
    managerUserId,
    messagingServiceSid,
    purpose: "manager_conversation",
    conversationKey,
  });
  if (!conversation.ok) return { eligible: false, reason: "conversation_consent_unreadable" };
  const grant = conversation.event;
  if (
    grant?.event_type !== "granted" ||
    !isConversationConsentSource(grant.source)
  ) {
    return { eligible: false, reason: "tour_sms_consent_missing" };
  }
  const conversationOccurredAt = grant.occurred_at?.trim();
  if (!conversationOccurredAt || Number.isNaN(Date.parse(conversationOccurredAt))) {
    return { eligible: false, reason: "tour_sms_consent_missing" };
  }
  // Materialize a purpose grant only after the current purpose revoke check.
  const recorded = await recordScopedSmsConsent(db, phoneE164, {
    ...tourScope,
    eventType: "granted",
    source: grant.source,
    evidence: {
      inquiryId: input.inquiryId?.trim() || null,
      conversationPurpose: "manager_conversation",
      conversationSource: grant.source,
      conversationOccurredAt,
    },
    occurredAt: conversationOccurredAt,
  });
  if (!recorded.ok) return { eligible: false, reason: recorded.error };
  return { eligible: true, phoneE164, conversationKey, provenance: grant.source };
}
