/**
 * One-number SMS: the shared contracts every workstream builds on.
 *
 * PropLane can run on ONE shared phone number. Every inbound text on that line
 * is stamped with a workspace by the router before any agent replies, and every
 * outbound text goes through `sendSharedLineMessage`. The per-workspace work
 * number system stays the default; the line mode in `sms_runtime_config`
 * decides which one is live (`per_workspace` | `shadow` | `shared`).
 *
 * Changing a type here is a contract change — every workstream reads it.
 * Spec: docs/agents/one-number.md.
 */

/** Who the sender is, relative to the workspace the router picked. */
export type SharedLineRole = "manager" | "resident" | "vendor" | "applicant" | "prospect";

/**
 * Why the router picked a workspace. Ordered: the first match wins
 * (`SHARED_LINE_ROUTING_ORDER`).
 */
export type SharedLineRoutingReason =
  | "team_member"
  | "resident"
  | "vendor_job"
  | "applicant"
  | "returning_prospect"
  | "entry_code";

export const SHARED_LINE_ROUTING_ORDER: readonly SharedLineRoutingReason[] = [
  "team_member",
  "resident",
  "vendor_job",
  "applicant",
  "returning_prospect",
  "entry_code",
] as const;

/** Reason → role the agent answers as. */
export const ROLE_FOR_ROUTING_REASON: Record<SharedLineRoutingReason, SharedLineRole> = {
  team_member: "manager",
  resident: "resident",
  vendor_job: "vendor",
  applicant: "applicant",
  returning_prospect: "prospect",
  entry_code: "prospect",
};

/** One workspace a sender could belong to. */
export type SharedLineCandidate = {
  workspaceId: string;
  /** The workspace owner — the `managerId` the existing inbound pipeline runs as. */
  ownerUserId: string;
  role: SharedLineRole;
  reason: SharedLineRoutingReason;
  /** The house this match is about, when the match carries one (lease, job, code). */
  propertyId: string | null;
  /** Human label for a disambiguation question, e.g. "5259 Brooklyn". Never a person's name. */
  label: string;
  /**
   * The same house as a VENDOR may be TOLD it: the general area ("Capitol Hill", "Seattle"), never the street.
   * A vendor candidate exists while a job is only OFFERED, and an offered vendor gets the general area only
   * (`docs/agents/services-system.md`), so everything we SEND a vendor - the disambiguation question, the
   * dedicated-number redirect - renders this. `label` stays the house, so a vendor who names the street they are
   * standing on still routes. Empty when no area can be told, and `spokenLabelFor` then names `workspaceName`:
   * a vendor-facing label NEVER falls back to `label`, which is the buildingName or the street.
   */
  generalArea?: string;
  /**
   * The workspace's own name. What a vendor is called the place when no general area can be told, so nothing
   * vendor-facing ever has to reach for the house. Absent on a candidate restored from an older stored session.
   */
  workspaceName?: string;
  /**
   * A vendor candidate only: what this workspace is waiting on from the phone right now. `offer` = a dispatch
   * offer out to them (a bare YES / NO is the answer), `accepted` = a job they took that is open (a bare DONE).
   * A live one outranks the sticky thread; absent or empty = nothing is waiting.
   */
  liveDispatch?: Array<"offer" | "accepted">;
};

export type RoutingDecision =
  /** Exactly one workspace. The inbound pipeline runs as `ownerUserId`. */
  | ({ kind: "routed" } & SharedLineCandidate)
  /** Several workspaces fit and the text does not settle it. Ask `question`; route nothing yet. */
  | { kind: "ambiguous"; candidates: SharedLineCandidate[]; question: string }
  /** A new prospect with no entry code: qualified in the platform "Unassigned leads" queue. */
  | { kind: "unassigned"; role: "prospect"; leadId: string | null };

/** Line mode stored on `sms_runtime_config.line_mode`. */
export type SharedLineMode = "per_workspace" | "shadow" | "shared";

export type SharedLineConfig = {
  mode: SharedLineMode;
  /** E.164, e.g. "+12065550100". Null until the shared number is bought and attached. */
  sharedNumber: string | null;
  messagingServiceSid: string | null;
  /** While mode = "shared", only these workspaces answer on the shared line (empty = all). */
  pilotWorkspaceIds: string[];
  /**
   * Workspaces that hold their OWN work number (captain, Oct 18: everyone gets the set PropLane
   * line; Pro and Business may get a personalized number for a workspace; PropLane's managed
   * service keeps its own number). These never answer or send on the shared line. Absent = none.
   */
  dedicatedWorkspaceIds?: string[];
};

/** Router input. `phoneKey` is `normalizeConsentPhone(from)` (10 digits for NANP). */
export type SharedLineInbound = {
  fromPhone: string;
  phoneKey: string;
  body: string;
  messageSid: string;
  mediaCount: number;
};

/**
 * Keywords handled by code before any AI sees the text. STOP/START/HELP are
 * carrier controls (already handled by `/api/twilio/inbound`); HUMAN pauses the
 * AI on the sender's session and pages the team; an emergency word sends the
 * safety reply and an urgent team alert.
 */
export type SharedLineKeyword = "STOP" | "START" | "HELP" | "HUMAN" | "EMERGENCY";

export const HUMAN_KEYWORDS = new Set(["HUMAN", "AGENT", "PERSON", "REPRESENTATIVE"]);

/** Whole-word, case-insensitive. Matched anywhere in the body. */
export const EMERGENCY_TERMS = [
  "gas leak",
  "smell gas",
  "gas smell",
  "fire",
  "smoke",
  "flood",
  "flooding",
  "burst pipe",
  "break-in",
  "break in",
  "broke in",
  "carbon monoxide",
  "co alarm",
  "locked out",
  "lockout",
] as const;

/** Lockout words are urgent for the team but not a danger: "call 911" would be the wrong thing to tell someone standing outside their door. */
export const LOCKOUT_TERMS = ["locked out", "lockout"] as const;

export const LOCKOUT_REPLY = "Sorry about that. We have alerted your property team and someone will contact you shortly.";

export const EMERGENCY_SAFETY_REPLY =
  "If anyone is in danger, call 911 now. We have alerted your property team and someone will call you shortly.";

/** Sticky router state, one row per phone on the shared line (`sms_line_sessions`). */
export type SharedLineSession = {
  phoneKey: string;
  currentWorkspaceId: string | null;
  activeRole: SharedLineRole | null;
  aiPaused: boolean;
  pausedAt: string | null;
  /** Set while we are waiting on "Is this about 5259 Brooklyn or your job at 8th Ave?" */
  pendingCandidates: SharedLineCandidate[] | null;
  updatedAt: string;
};

/** Outbound on the shared line. Every send goes through `sendSharedLineMessage`. */
export type SharedLineSend = {
  workspaceId: string;
  ownerUserId: string;
  toPhone: string;
  body: string;
  role: SharedLineRole;
  /** Appended as "— <signOff>" when a human sends from the inbox, e.g. "5259 Brooklyn team". */
  signOff?: string | null;
  mediaUrls?: string[];
  /** Stable key so a retry never double-sends. */
  idempotencyKey: string;
  /**
   * How the consent gate reads this text. Default `transactional` / `shared_line_message`. A one-time code
   * the person just asked for is `control`; a notice to a signed-in manager or vendor carries that person's
   * own purpose, conversation key and user id so their consent (never an application's) vouches for it.
   */
  delivery?: {
    sendClass?: "control" | "transactional" | "automated";
    purpose?: string;
    conversationKey?: string | null;
    recipientUserId?: string | null;
  };
};

export type SharedLineSendResult =
  | { ok: true; messageSid: string; segments: number }
  | {
      ok: false;
      reason: "opted_out" | "not_shared_mode" | "no_shared_number" | "quiet_hours" | "budget" | "provider_error";
      detail?: string;
    };

/** Phone-bound signed link purposes (`phone_bound_links.purpose`). */
export type PhoneBoundLinkPurpose =
  | "gallery"
  | "tour"
  | "application"
  | "lease"
  | "rent"
  | "move_in"
  | "job"
  | "payouts";

export type PhoneBoundLinkPolicy = { ttlHours: number | "until_closed"; requiresOtp: boolean };

/** Spec table "Links tied to the phone number". */
export const PHONE_BOUND_LINK_POLICY: Record<PhoneBoundLinkPurpose, PhoneBoundLinkPolicy> = {
  gallery: { ttlHours: 24 * 30, requiresOtp: false },
  tour: { ttlHours: 24 * 7, requiresOtp: false },
  application: { ttlHours: 24 * 7, requiresOtp: true },
  lease: { ttlHours: 24 * 7, requiresOtp: true },
  rent: { ttlHours: 24 * 10, requiresOtp: true },
  move_in: { ttlHours: 24 * 14, requiresOtp: true },
  job: { ttlHours: "until_closed", requiresOtp: false },
  payouts: { ttlHours: 24 * 7, requiresOtp: true },
};

/** OTP rules for link unlocks and phone sign-in (reuse `phone_verifications`). */
export const SHARED_LINE_OTP_RULES = {
  codeLength: 6,
  ttlMinutes: 10,
  maxAttempts: 5,
  /** Sends per phone per rolling hour FOR ONE PURPOSE. */
  maxSendsPerHour: 3,
  /**
   * Sends per phone per rolling hour across every purpose. Higher than the per-purpose budget so that abusing
   * one door (the public-bind code anyone holding a printed entry code can aim at any number) cannot spend the
   * allowance a rent link or a phone sign-in needs.
   */
  maxSendsPerPhonePerHour: 8,
  moneySessionMinutes: 30,
  otherSessionDays: 7,
} as const;

/** Per-topic auto-reply mode (`sms_topic_reply_modes`). */
export type TopicReplyMode = "draft" | "auto_review" | "full_auto";

/** Knowledge entry lifecycle (`property_knowledge_entries.status`). */
export type KnowledgeEntryStatus = "suggested" | "approved" | "rejected";

/** Topics that always escalate to the team, whatever the knowledge base says. */
export const ALWAYS_ESCALATE_TOPICS = ["money", "legal", "safety", "fair_housing"] as const;
