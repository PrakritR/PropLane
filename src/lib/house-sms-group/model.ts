/**
 * The SMS group text of one house, pure half. NOT a second chat: it is the SMS door to the ONE in-app house
 * chat (`house-thread:<owner>:ws:<workspace>:prop:<property>`, `src/lib/house-chat`). The Twilio
 * Conversation SID, the line it projects from and the member list live on that thread's `row_data.smsGroup`
 * (a top-level key: `row_data.houseChat` is rebuilt from an allowlist on every write and would drop it).
 *
 * Twilio rules this file encodes (docs/agents/sms-system.md § House SMS group text):
 *  - Group MMS needs at least TWO SMS participants plus the projected line (error 50435 otherwise), so a
 *    house with one phone (only the owner) is `pending`: its members are remembered and the Conversation
 *    is made the moment a second phone qualifies. A Conversation exists if and only if there are 2+ phones.
 *  - Twilio keys a group by its sorted set of addresses (50438 on a duplicate), so two houses can never
 *    share an identical phone set on one line; `memberSetKey` is how the sync refuses it before Twilio does.
 *  - At most ten participants including the line: `SMS_GROUP_MEMBER_CAP` phones.
 */
import { createHash } from "node:crypto";
import { GROUP_MEMBER_CAP } from "@/lib/house-groups/types";
import { normalizeConsentPhone } from "@/lib/sms-consent";

export const SMS_GROUP_MEMBER_CAP = GROUP_MEMBER_CAP;
/** Phones needed before Twilio will activate a group (the line is the third participant). */
export const SMS_GROUP_MIN_PHONES = 2;
/** Longest text posted into a group in one message (Conversations accepts 1600 characters). */
export const SMS_GROUP_MAX_TEXT = 1000;

export type SmsGroupMemberKind = "staff" | "resident";

export type SmsGroupMember = {
  /** Last ten digits: the identity of a member. */
  phoneKey: string;
  phoneE164: string;
  kind: SmsGroupMemberKind;
  /** First name only. */
  firstName: string;
  /** Rooms are drawn for residents; staff carry none. */
  roomLabel: string;
  /** The PropLane account behind the phone, when known (decides which side of the in-app thread a line is drawn on). */
  userId: string | null;
  /** The Twilio participant, once the member is in a live Conversation. */
  participantSid: string | null;
  addedAt: string;
};

export type SmsGroupStatus = "pending" | "active";

export type SmsGroupState = {
  version: 1;
  status: SmsGroupStatus;
  /** Set exactly while `status` is `active`. */
  conversationSid: string | null;
  /** The projected line (E.164): the workspace work number, or the PropLane line for a managed workspace. */
  line: string | null;
  members: SmsGroupMember[];
  /** Phone keys a manager removed on purpose: a resident re-derived from occupancy is not re-added over them. */
  excludedPhoneKeys: string[];
  introPostedAt: string | null;
  /** The last posts' idempotency keys: a retried post goes out once. */
  postKeys: string[];
  updatedAt: string;
};

export const SMS_GROUP_POST_KEYS_KEPT = 60;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

function readMember(raw: unknown): SmsGroupMember | null {
  const r = asRecord(raw);
  const phoneKey = str(r.phoneKey);
  const phoneE164 = str(r.phoneE164);
  if (!/^\d{10}$/.test(phoneKey) || !phoneE164) return null;
  return {
    phoneKey,
    phoneE164,
    kind: r.kind === "resident" ? "resident" : "staff",
    firstName: str(r.firstName).slice(0, 40),
    roomLabel: str(r.roomLabel).slice(0, 60),
    userId: str(r.userId) || null,
    participantSid: str(r.participantSid) || null,
    addedAt: str(r.addedAt),
  };
}

/** The stored group of a house thread, or `null` when the house has never been given one. */
export function readSmsGroupState(rowData: Record<string, unknown> | null | undefined): SmsGroupState | null {
  const raw = asRecord(asRecord(rowData).smsGroup);
  if (raw.version !== 1) return null;
  const members = (Array.isArray(raw.members) ? raw.members : []).map(readMember).filter((m): m is SmsGroupMember => m !== null);
  const conversationSid = str(raw.conversationSid);
  return {
    version: 1,
    status: raw.status === "active" && /^CH[a-zA-Z0-9]{32}$/.test(conversationSid) ? "active" : "pending",
    conversationSid: /^CH[a-zA-Z0-9]{32}$/.test(conversationSid) ? conversationSid : null,
    line: str(raw.line) || null,
    members,
    excludedPhoneKeys: (Array.isArray(raw.excludedPhoneKeys) ? raw.excludedPhoneKeys : []).map(str).filter((k) => /^\d{10}$/.test(k)),
    introPostedAt: str(raw.introPostedAt) || null,
    postKeys: (Array.isArray(raw.postKeys) ? raw.postKeys : []).map(str).filter(Boolean).slice(-SMS_GROUP_POST_KEYS_KEPT),
    updatedAt: str(raw.updatedAt),
  };
}

export function withSmsGroupState(rowData: Record<string, unknown>, state: SmsGroupState): Record<string, unknown> {
  return { ...rowData, smsGroup: state };
}

export function emptySmsGroupState(now: Date): SmsGroupState {
  return {
    version: 1,
    status: "pending",
    conversationSid: null,
    line: null,
    members: [],
    excludedPhoneKeys: [],
    introPostedAt: null,
    postKeys: [],
    updatedAt: now.toISOString(),
  };
}

/** "•••• 8345": a phone is shown to a manager as its last four digits and never leaves the server whole. */
export function maskPhoneLast4(phone: string): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "••••";
}

/** What a manager's screen is given for one member: no full number, no participant sid, no user id. */
export type SmsGroupMemberView = {
  phoneKey: string;
  maskedPhone: string;
  kind: SmsGroupMemberKind;
  firstName: string;
  roomLabel: string;
  inGroup: boolean;
};

export function memberView(member: SmsGroupMember, active: boolean): SmsGroupMemberView {
  return {
    phoneKey: member.phoneKey,
    maskedPhone: maskPhoneLast4(member.phoneE164),
    kind: member.kind,
    firstName: member.firstName,
    roomLabel: member.roomLabel,
    inGroup: active && Boolean(member.participantSid),
  };
}

/** Twilio's identity of a group: the line plus the sorted phone keys. Two houses may never share one. */
export function memberSetKey(line: string | null, phoneKeys: readonly string[]): string {
  const sorted = [...new Set(phoneKeys.map((k) => normalizeConsentPhone(k)).filter(Boolean))].sort();
  return createHash("sha256").update(`${line ?? ""}|${sorted.join(",")}`).digest("hex");
}

/** A resident as the group sync reads one (a subset of `ResidentCandidate`). */
export type GroupResidentCandidate = {
  phoneKey: string;
  phoneE164: string;
  userId: string | null;
  firstName: string;
  roomLabel: string;
  moveIn: string | null;
  longTerm: boolean;
  verifiedPhone: boolean;
  /** "leave group". */
  optedOut: boolean;
  /** The global STOP ledger. */
  stopped: boolean;
};

export type ResidentExclusion = "short_stay" | "unverified_phone" | "left_group" | "stopped" | "removed_by_manager" | "duplicate";

/**
 * Residents the group should hold. Opt-OUT, not opt-in (captain, Nov 12): a current long-term resident with
 * a VERIFIED phone who has not left the group and has not texted STOP. A short stay never joins. Two
 * candidates on one phone count once (the earlier move-in), and a phone a manager removed stays removed.
 */
export function selectResidentMembers(
  candidates: readonly GroupResidentCandidate[],
  excludedPhoneKeys: readonly string[],
  takenPhoneKeys: ReadonlySet<string> = new Set(),
): { members: GroupResidentCandidate[]; excluded: { phoneKey: string; reason: ResidentExclusion }[] } {
  const excluded: { phoneKey: string; reason: ResidentExclusion }[] = [];
  const members: GroupResidentCandidate[] = [];
  const seen = new Set<string>(takenPhoneKeys);
  const ordered = [...candidates].sort((a, b) => (a.moveIn ?? "9999-12-31").localeCompare(b.moveIn ?? "9999-12-31") || a.phoneKey.localeCompare(b.phoneKey));
  for (const c of ordered) {
    const reason: ResidentExclusion | null = !c.longTerm
      ? "short_stay"
      : c.stopped
        ? "stopped"
        : c.optedOut
          ? "left_group"
          : !c.verifiedPhone
            ? "unverified_phone"
            : excludedPhoneKeys.includes(c.phoneKey)
              ? "removed_by_manager"
              : seen.has(c.phoneKey)
                ? "duplicate"
                : null;
    if (reason) {
      excluded.push({ phoneKey: c.phoneKey, reason });
      continue;
    }
    seen.add(c.phoneKey);
    members.push(c);
  }
  return { members, excluded };
}

export type MembershipPlan = {
  /** Everyone who belongs in the group, staff first, capped. */
  desired: SmsGroupMember[];
  added: SmsGroupMember[];
  removed: SmsGroupMember[];
  /** Eligible phones past the cap: they stay on 1:1 texts. */
  overflow: number;
};

/**
 * The next member list. Staff are the manager's explicit choice and are kept (a STOP on the global ledger
 * is applied by the caller through `stoppedPhoneKeys`); residents are whoever `selectResidentMembers`
 * returned. Existing participant sids are carried over so nobody is re-added.
 */
export function planMembership(input: {
  current: readonly SmsGroupMember[];
  staff: readonly SmsGroupMember[];
  residents: readonly GroupResidentCandidate[];
  stoppedPhoneKeys?: ReadonlySet<string>;
  now: Date;
  cap?: number;
}): MembershipPlan {
  const cap = input.cap ?? SMS_GROUP_MEMBER_CAP;
  const stopped = input.stoppedPhoneKeys ?? new Set<string>();
  const byKey = new Map(input.current.map((m) => [m.phoneKey, m] as const));
  const nowIso = input.now.toISOString();
  const all: SmsGroupMember[] = [];
  const seen = new Set<string>();
  for (const s of input.staff) {
    if (seen.has(s.phoneKey) || stopped.has(s.phoneKey)) continue;
    seen.add(s.phoneKey);
    all.push({ ...s, participantSid: byKey.get(s.phoneKey)?.participantSid ?? s.participantSid ?? null, addedAt: byKey.get(s.phoneKey)?.addedAt ?? s.addedAt ?? nowIso });
  }
  for (const r of input.residents) {
    if (seen.has(r.phoneKey)) continue;
    seen.add(r.phoneKey);
    const prior = byKey.get(r.phoneKey);
    all.push({
      phoneKey: r.phoneKey,
      phoneE164: r.phoneE164,
      kind: "resident",
      firstName: r.firstName,
      roomLabel: r.roomLabel,
      userId: r.userId,
      participantSid: prior?.participantSid ?? null,
      addedAt: prior?.addedAt ?? nowIso,
    });
  }
  const desired = all.slice(0, cap);
  const desiredKeys = new Set(desired.map((m) => m.phoneKey));
  return {
    desired,
    added: desired.filter((m) => !byKey.has(m.phoneKey)),
    removed: input.current.filter((m) => !desiredKeys.has(m.phoneKey)),
    overflow: Math.max(0, all.length - cap),
  };
}

/** "Maya · Room 2" for a resident, the first name for staff: how an inbound text is drawn in the in-app thread. */
export function smsAuthorLabel(member: Pick<SmsGroupMember, "kind" | "firstName" | "roomLabel">): string {
  const name = member.firstName.trim() || (member.kind === "staff" ? "Team" : "Housemate");
  const room = member.roomLabel.trim();
  return member.kind === "resident" && room ? `${name} · ${room}` : name;
}

/** An in-app line as it reads in the group text: the sender's label, then the words. */
export function groupTextFor(from: string, body: string): string {
  const label = from.replace(/\s+/g, " ").trim();
  const text = String(body ?? "").trim();
  const full = label ? `${label}: ${text}` : text;
  return full.length > SMS_GROUP_MAX_TEXT ? `${full.slice(0, SMS_GROUP_MAX_TEXT - 3)}...` : full;
}

/** The stored id of one inbound group text on the in-app thread: a Twilio retry posts once. */
export function inboundLineId(messageSid: string): string {
  return `sms-group:${messageSid.trim()}`;
}
