import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeConsentPhone, readScopedSmsConsentState, recordScopedSmsConsent, readSmsSuppressionState } from "@/lib/sms-consent";
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

/** The consent purpose every vendor text thread uses: job-agent replies, a manager's texts, a vendor's replies. */
export const VENDOR_CONVERSATION_PURPOSE = "vendor_conversation";
export const VENDOR_TEXT_ATTESTATION_SOURCE = "manager_attested_vendor_relationship";
export const VENDOR_TEXT_ATTESTATION_WORDING_VERSION = "vendor-text-attestation-v1";
/** A vendor texting the work number first is the vendor's own opt-in to replies in that thread. */
export const VENDOR_INBOUND_CONSENT_SOURCE = "recipient_initiated_inbound";

/** The first text's identification and opt-out line (the approved wording, Oct 6). */
export function buildVendorSenderLine(input: { managerFirstName?: string | null; workspaceName?: string | null }): string {
  const first = String(input.managerFirstName ?? "").trim().split(/\s+/)[0] || "Your property manager";
  const workspace = String(input.workspaceName ?? "").trim() || "PropLane";
  return `— ${first} at ${workspace} via PropLane. Reply STOP to opt out.`;
}

/** Every key this vendor's thread may have carried: the account's, then the phone's. */
export function vendorConversationKeys(input: {
  managerUserId: string; vendorUserId: string | null; phone: string;
}): string[] {
  const phoneKey = buildConversationKey({ ownerManagerUserId: input.managerUserId, role: "vendor",
    counterpartyUserId: null, counterpartyPhone: input.phone });
  if (!input.vendorUserId) return [phoneKey];
  const userKey = buildConversationKey({ ownerManagerUserId: input.managerUserId, role: "vendor",
    counterpartyUserId: input.vendorUserId, counterpartyPhone: input.phone });
  return [userKey, phoneKey];
}

export type VendorTextConsentState =
  | {
      ok: true; state: "none" | "granted" | "revoked" | "opted_out"; conversationKey: string; grantedUnder: string | null;
      /** `sms_consent_events.source` of the grant that counts, so a send can tell an attestation from a vendor's own text. */
      grantSource: string | null;
    }
  | { ok: false; error: string };

function scopeFor(managerUserId: string, conversationKey: string, messagingServiceSid: string) {
  return { managerUserId, purpose: VENDOR_CONVERSATION_PURPOSE, sendClass: "transactional" as const, conversationKey, messagingServiceSid };
}

/**
 * Where does a text to this vendor stand? STOP (any rail) is read first and is
 * final: `opted_out` is never overridden by an attestation or a reply grant.
 * A grant under either of the vendor's keys counts (the key changes when the
 * vendor's account links); the current key is `conversationKey`.
 */
export async function readVendorTextConsent(db: SupabaseClient, input: {
  managerUserId: string; vendorUserId: string | null; phone: string;
}): Promise<VendorTextConsentState> {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || "";
  if (!messagingServiceSid) return { ok: false, error: "provider_identity_mismatch" };
  const keys = vendorConversationKeys(input);
  const conversationKey = keys[0]!;
  const suppression = await readSmsSuppressionState(db, input.phone, { userId: input.vendorUserId });
  if (!suppression.ok) return { ok: false, error: suppression.error };
  if (suppression.optedOut) return { ok: true, state: "opted_out", conversationKey, grantedUnder: null, grantSource: null };
  let grantedUnder: string | null = null;
  for (const key of keys) {
    const current = await readScopedSmsConsentState(db, input.phone, scopeFor(input.managerUserId, key, messagingServiceSid));
    if (!current.ok) return { ok: false, error: current.error };
    if (current.state === "revoked") return { ok: true, state: "revoked", conversationKey, grantedUnder: null, grantSource: null };
    if (current.state === "granted" && !grantedUnder) grantedUnder = key;
  }
  let grantSource: string | null = null;
  if (grantedUnder) {
    const { data, error } = await db
      .from("sms_consent_events")
      .select("source")
      .eq("recipient_phone_key", normalizeConsentPhone(input.phone))
      .eq("manager_user_id", input.managerUserId)
      .eq("purpose", VENDOR_CONVERSATION_PURPOSE)
      .eq("conversation_key", grantedUnder)
      .eq("event_type", "granted")
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return { ok: false, error: "scoped_consent_unreadable" };
    grantSource = String((data as { source?: unknown }[] | null)?.[0]?.source ?? "") || null;
  }
  return { ok: true, state: grantedUnder ? "granted" : "none", conversationKey, grantedUnder, grantSource };
}

/**
 * The manager attests a business relationship on the first text. The grant is
 * stored with its evidence: who attested, the exact identification line and
 * STOP footer that went out with the message, and which roster row it was for.
 */
export async function recordManagerAttestedVendorConsent(db: SupabaseClient, input: {
  managerUserId: string; actorUserId: string; phone: string; conversationKey: string;
  vendorRecordId: string; senderLine: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || "";
  if (!messagingServiceSid) return { ok: false, error: "provider_identity_mismatch" };
  return recordScopedSmsConsent(db, input.phone, {
    ...scopeFor(input.managerUserId, input.conversationKey, messagingServiceSid),
    eventType: "granted", source: VENDOR_TEXT_ATTESTATION_SOURCE, wordingVersion: VENDOR_TEXT_ATTESTATION_WORDING_VERSION,
    evidence: { attestation: "i_work_with_this_vendor", attestedBy: input.actorUserId,
      vendorRecordId: input.vendorRecordId, senderLine: input.senderLine, stopFooter: true },
  });
}

/** Copy a grant the vendor's other key already holds onto the current key. Never overwrites STOP. */
export async function carryVendorConsentToKey(db: SupabaseClient, input: {
  managerUserId: string; phone: string; conversationKey: string; fromKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || "";
  if (!messagingServiceSid) return { ok: false, error: "provider_identity_mismatch" };
  return recordScopedSmsConsent(db, input.phone, {
    ...scopeFor(input.managerUserId, input.conversationKey, messagingServiceSid),
    eventType: "granted", source: "carried_from_vendor_key", evidence: { fromConversationKey: input.fromKey },
  });
}

/**
 * A text from a vendor on the manager's list (or one the manager texted in the
 * last 90 days) unlocks replies in that thread. Called only after the webhook
 * signature and the routing decision. Never overwrites a STOP or a revoke.
 */
export async function recordVendorInboundReplyConsent(db: SupabaseClient, input: {
  managerUserId: string; vendorUserId: string | null; phone: string; messageSid: string;
}): Promise<"allowed" | "suppressed" | "unavailable"> {
  if (!input.messageSid.trim()) return "unavailable";
  const state = await readVendorTextConsent(db, input);
  if (!state.ok) return "unavailable";
  if (state.state === "opted_out" || state.state === "revoked") return "suppressed";
  if (state.state === "granted" && state.grantedUnder === state.conversationKey) return "allowed";
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim() || "";
  const recorded = await recordScopedSmsConsent(db, input.phone, {
    ...scopeFor(input.managerUserId, state.conversationKey, messagingServiceSid),
    eventType: "granted", source: VENDOR_INBOUND_CONSENT_SOURCE,
    evidence: { messageSid: input.messageSid, role: "vendor" },
  });
  return recorded.ok ? "allowed" : "unavailable";
}
