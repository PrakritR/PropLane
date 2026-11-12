/** Prospect spine contracts (design-1112 §3.0). Pure types: no server imports. */
export type ProspectSource =
  | "sms" | "listing_message" | "in_app" | "application" | "tour" | "voice"
  | "spareroom" | "roomies" | "facebook" | "zillow" | "craigslist" | "roomster"
  | "airbnb" | "booking_com" | "padsplit" | "other";
export const PLATFORM_SOURCES = ["spareroom","roomies","facebook","zillow","craigslist","roomster","airbnb","booking_com","padsplit"] as const;
export type PlatformSource = (typeof PLATFORM_SOURCES)[number];
export type ProspectContextInput = {
  propertyId: string | null;
  roomId?: string | null;
  roomLabel?: string | null;
  source: ProspectSource;
  sourceRef?: string | null;
};
/** Who wrote. Exactly one of phoneE164 / contactHandle is the identity; a name or email is never one. */
export type ProspectIdentity =
  | { kind: "phone"; phoneE164: string; verified: boolean; displayName?: string | null; email?: string | null }
  | { kind: "handle"; contactHandle: string; site: PlatformSource; displayName?: string | null; replyAddress?: string | null };
export type SpineMedia = { storagePath: string; contentType: string; byteSize: number | null };
export type RecordInboundInput = {
  workspaceId: string;
  ownerUserId: string;                 // re-derived by the caller from the workspace, never from a request body
  identity: ProspectIdentity;
  context: ProspectContextInput;
  body: string;
  channel: "sms" | "email" | "in_app";
  /** Provider id (Twilio SID, email Message-ID hash, `web:<uuid>`): the idempotency key of the turn. */
  eventId: string;
  occurredAt: string;                  // ISO
  media?: SpineMedia[];
  /** false = store only (a replay, a held platform mail). Default true. */
  notify?: boolean;
};
export type RecordInboundResult =
  | { ok: true; threadId: string; messageId: string; contextId: string; created: boolean; duplicate: boolean; label: string }
  | { ok: false; reason: "workspace_not_found" | "invalid_identity" | "store_unavailable" };
export type RecordOutboundInput = {
  workspaceId: string;
  ownerUserId: string;
  threadId: string;
  body: string;
  channel: "sms" | "email" | "in_app";
  author: { kind: "staff"; userId: string; name: string } | { kind: "assistant" } | { kind: "automated"; label: string };
  eventId: string;
  context?: ProspectContextInput;
};
export type DeliveryIssueInput = {
  threadId: string | null;             // null = no thread yet (inbound never routed): goes to the admin inbox
  workspaceId: string | null;
  direction: "inbound" | "outbound";
  reason: string;                      // human sentence, no ids, no phone numbers
  messageId?: string | null;
  eventId: string;
};
export type ProspectRecordView = {
  phoneE164: string | null;
  userId: string | null;
  displayName: string | null;
  contexts: Array<{ id: string; workspaceId: string; propertyId: string | null; propertyLabel: string | null;
    roomId: string | null; roomLabel: string | null; source: ProspectSource; channelState: "active" | "moved";
    threadId: string | null; firstMessageAt: string; lastMessageAt: string; messageCount: number }>;
};
export type StitchResult =
  | { ok: true; threadId: string; movedContextIds: string[] }
  | { ok: false; reason: "unknown_code" | "ambiguous" | "store_unavailable" };
