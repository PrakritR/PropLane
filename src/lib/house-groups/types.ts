/**
 * House group chats: shared types. One Twilio Conversation per house, residents as SMS
 * participants, PropLane as a participant projected from the shared number. See
 * docs/agents/one-number.md § W10.
 */

/** Twilio group MMS allows 10 participants including PropLane. */
export const GROUP_MEMBER_CAP = 9;
/** Fewer than two residents is not a group; each of them gets 1:1 texts. */
export const GROUP_MIN_MEMBERS = 2;
export const DEFAULT_MAX_POSTS_PER_DAY = 4;

/** What a post is for. Quiet hours and the daily cap read it; W11's presets pass their own words. */
export type HouseGroupPostKind =
  | "intro"
  | "answer"
  | "announcement"
  | "reminder"
  | "rent_reminder"
  | "rules"
  | "complaint_ack"
  | "maintenance"
  | "emergency"
  | "notice"
  | (string & {});

export type HouseGroupPostInput = {
  workspaceId: string;
  propertyId: string;
  text: string;
  kind: HouseGroupPostKind;
  /** Stable per intended post: a retry returns the first send instead of posting twice. */
  idempotencyKey: string;
};

export type HouseGroupPostResult =
  | { ok: true; messageSid: string }
  | {
      ok: false;
      reason: "no_group" | "not_enabled" | "quiet_hours" | "rate_limited" | "provider_error";
      detail?: string;
    };

/** One resident the group manager considered for a house. */
export type ResidentCandidate = {
  phoneKey: string;
  phoneE164: string;
  userId: string | null;
  firstName: string;
  roomLabel: string;
  /** ISO date the stay began; the 9-seat cap keeps the earliest. */
  moveIn: string | null;
  /** A lease or approved long-term hold. False for a short stay. */
  longTerm: boolean;
  /** The phone belongs to a PropLane account that verified it. */
  verifiedPhone: boolean;
  /** Group consent on file (`house_group_preferences.consent_at`). */
  consented: boolean;
  /** "leave group". */
  optedOut: boolean;
  /** The global STOP ledger. */
  stopped: boolean;
};

export type GroupMember = {
  phoneKey: string;
  phoneE164: string;
  userId: string | null;
  firstName: string;
  roomLabel: string;
  moveIn: string | null;
};

export type ExclusionReason = "short_stay" | "unverified_phone" | "no_consent" | "left_group" | "stopped" | "duplicate";

/** The Twilio Conversations calls the group manager and poster need. Mocked in tests. */
export type ConversationsGateway = {
  createConversation(input: { friendlyName: string }): Promise<{ sid: string }>;
  /** Registers the post-event webhook (`onMessageAdded`) on this conversation only. */
  watchConversation(conversationSid: string): Promise<void>;
  addResident(conversationSid: string, phoneE164: string): Promise<{ participantSid: string }>;
  addProplane(conversationSid: string, sharedNumberE164: string): Promise<void>;
  postMessage(conversationSid: string, body: string): Promise<{ messageSid: string }>;
  closeConversation(conversationSid: string): Promise<void>;
};

export const PROPLANE_IDENTITY = "proplane";
