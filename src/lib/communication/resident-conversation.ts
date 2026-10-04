/**
 * A resident's Communication, texts included - client-safe, pure.
 *
 * A resident holds ONE conversation per manager workspace (`ws:<workspace>`).
 * Their in-app and email turns are stored rows; their TEXTS live in the SMS
 * projection (keyed by the manager's work line). This module decides which
 * projection conversations are THEIRS and folds the turns into the same
 * conversation, without ever storing a copy of a text on a resident row.
 *
 * The identity rules (table-tested in `tests/unit/resident-conversation.test.ts`):
 *
 *   - a text conversation is the resident's only through the ACCOUNT the SMS
 *     pipeline already resolved (`counterparty_user_id`), or through a phone
 *     the resident VERIFIED (`profiles.phone_verified_at`). A typed, unverified
 *     phone never links anyone.
 *   - if any OTHER account also verified the same number, nothing links by
 *     phone: the number is ambiguous, so the resident sees none of it.
 *   - only prospect / applicant / resident conversations are a resident's.
 *     Manager, admin, vendor and unresolved conversations (the assistant's
 *     own, a manager texting their line) never appear.
 */
import { normalizeE164 } from "@/lib/phone-e164";
import {
  inboxThreadMessages,
  inboxThreadSortMs,
  formatInboxStamp,
  type InboxThreadMessage,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { workspaceKey } from "@/lib/communication/conversation-key";
import { RESIDENT_AGENT_FROM_NAME } from "@/lib/agent/resident-inbox-agent-ids";

/** The PropLane Assistant's own thread: never a manager conversation, never keyed, never given a counterparty or texts. */
export function isResidentAssistantRow(row: PersistedInboxThread): boolean {
  const extended = row as PersistedInboxThread & { threadType?: unknown; thread_type?: unknown };
  const type = String(extended.threadType ?? extended.thread_type ?? "");
  const id = String(row.id ?? "");
  return (
    type === "resident_agent" ||
    type === "agent_notice" ||
    id.startsWith("resident-agent-") ||
    id.startsWith("agent_notice_") ||
    String(row.from ?? "").trim() === RESIDENT_AGENT_FROM_NAME
  );
}

/** Message ids that are projected from the SMS store at read time and never persisted. */
export const PROJECTED_SMS_TURN_PREFIX = "sms-proj:";
/** Row ids the server derives for a text-only conversation; a client never creates them. */
export const RESIDENT_SMS_ROW_PREFIX = "resident_sms_";

export type ResidentSmsRole = "prospect" | "applicant" | "resident";
const RESIDENT_SMS_ROLES: ReadonlySet<string> = new Set<ResidentSmsRole>(["prospect", "applicant", "resident"]);

/** Who the resident is talking to - data only; the resident UI draws it. */
export type ResidentCounterparty = {
  workspaceId: string;
  /** The manager's name, else the workspace's. */
  name: string;
  workspaceName: string | null;
  /** The work number the resident texts (public), E.164. */
  workPhone: string | null;
  /** No avatar is stored on a profile today; the UI draws `initials`. */
  avatarUrl: string | null;
  initials: string;
};

export type ResidentSmsTurn = {
  id: string;
  /** "inbound" = the resident texted the manager; "outbound" = the manager's line texted them. */
  direction: "inbound" | "outbound";
  body: string;
  /** ISO timestamp. */
  at: string;
  fromPhone: string | null;
  toPhone: string | null;
};

export type ResidentSmsConversation = {
  workspaceId: string;
  /** `ws:<workspace>` - the key the resident's in-app / email row carries. */
  key: string;
  counterparty: ResidentCounterparty;
  linkedBy: ("account" | "verified_phone")[];
  /** Oldest first. */
  turns: ResidentSmsTurn[];
  lastEventAt: string | null;
};

export type ResidentPhoneState = {
  /** A phone is on the profile. */
  hasPhone: boolean;
  /** `profiles.phone_verified_at` is set and the phone is a valid E.164. */
  verified: boolean;
  /** Another account verified the same number: nothing links by phone. */
  ambiguous: boolean;
};

export function isResidentSmsRole(role: unknown): role is ResidentSmsRole {
  return RESIDENT_SMS_ROLES.has(String(role ?? ""));
}

export function initialsOf(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

/**
 * Is this projection conversation the resident's? `null` = no. The ONE decision;
 * the loader never re-derives it.
 */
export function decideResidentSmsLink(input: {
  residentId: string;
  /** The resident's verified phone (E.164), or null when none is verified. */
  verifiedPhone: string | null;
  /** Every distinct account id that verified `verifiedPhone` (including the resident). */
  phoneVerifierIds: readonly string[];
  row: { role: unknown; counterpartyUserId: string | null; counterpartyPhone: string | null };
}): "account" | "verified_phone" | null {
  if (!isResidentSmsRole(input.row.role)) return null;
  const userId = String(input.row.counterpartyUserId ?? "").trim();
  if (userId) {
    // The pipeline resolved this conversation to an account: it is that
    // account's, and nobody else's - not even through a shared phone.
    return userId === input.residentId ? "account" : null;
  }
  if (!input.verifiedPhone) return null;
  const phone = normalizeE164(input.row.counterpartyPhone);
  if (!phone || phone !== input.verifiedPhone) return null;
  const verifiers = [...new Set(input.phoneVerifierIds)];
  // Ambiguous: another account verified this number too. Link nobody.
  if (verifiers.length !== 1 || verifiers[0] !== input.residentId) return null;
  return "verified_phone";
}

function smsMessage(turn: ResidentSmsTurn, counterparty: ResidentCounterparty, residentName: string): InboxThreadMessage {
  const fromResident = turn.direction === "inbound";
  return {
    id: `${PROJECTED_SMS_TURN_PREFIX}${turn.id}`,
    from: fromResident ? residentName : counterparty.name,
    body: turn.body,
    at: formatInboxStamp(new Date(turn.at)),
    // Resident rows draw the resident's own turns as outbound.
    outbound: fromResident,
    channel: "sms",
  };
}

function ordered(messages: InboxThreadMessage[]): InboxThreadMessage[] {
  return [...messages].sort((a, b) => inboxThreadSortMs(a.id, a.at) - inboxThreadSortMs(b.id, b.at));
}

/**
 * Put a conversation's root turn in `body` and the rest in `messages`, like every
 * stored row. When the row's OWN root is still the oldest turn it is left
 * exactly as stored (its direction and stamps are the row's, not a guess).
 */
function withTurns(
  base: PersistedInboxThread,
  all: InboxThreadMessage[],
  keepRootId?: string,
): PersistedInboxThread {
  const sorted = ordered(all);
  const first = sorted[0];
  if (!first) return base;
  const last = sorted[sorted.length - 1]!;
  const tail = {
    time: last.at,
    preview: last.body.slice(0, 100).replace(/\n/g, " "),
  };
  if (keepRootId && first.id === keepRootId) {
    return { ...base, messages: sorted.slice(1), ...tail };
  }
  // The row's own derived root is no longer first: it stays in the timeline
  // under a `merged:` id so the id the client persists against never collides
  // with the new root's.
  const rest = sorted.slice(1).map((message) =>
    keepRootId && message.id === keepRootId ? { ...message, id: `merged:${message.id}` } : message,
  );
  return {
    ...base,
    body: first.body,
    from: first.from,
    rootAt: first.at,
    rootOutbound: first.outbound === true,
    rootChannel: first.channel,
    rootSubject: first.subject,
    rootAutomated: first.automated === true,
    rootHouseId: first.houseId,
    rootHouseLabel: first.houseLabel,
    attachments: first.attachments,
    messages: rest,
    ...tail,
  };
}

/** A text-only conversation: the resident has texted this workspace but holds no stored row for it. */
export function smsOnlyResidentRow(conversation: ResidentSmsConversation, residentName: string): PersistedInboxThread | null {
  if (conversation.turns.length === 0) return null;
  const all = conversation.turns.map((turn) => smsMessage(turn, conversation.counterparty, residentName));
  const base: PersistedInboxThread = {
    id: `${RESIDENT_SMS_ROW_PREFIX}${conversation.workspaceId}`,
    folder: "inbox",
    from: conversation.counterparty.name,
    // Never the manager's login address: a text-only conversation has no
    // address, and the resident replies from their phone.
    email: "",
    subject: "Text messages",
    preview: "",
    body: "",
    time: "",
    unread: false,
    conversationKey: conversation.key,
    workspaceId: conversation.workspaceId,
    counterparty: conversation.counterparty,
    smsOnly: true,
  };
  return withTurns(base, all);
}

/**
 * Fold a conversation's projected turns into the stored row that is the same
 * conversation. The row keeps its identity (id, folder, read sources); only the
 * timeline gains the texts.
 */
export function mergeSmsTurnsIntoRow(
  row: PersistedInboxThread,
  conversation: ResidentSmsConversation,
  residentName: string,
): PersistedInboxThread {
  if (conversation.turns.length === 0) return row;
  const known = new Set(inboxThreadMessages(row).map((message) => message.id));
  const added = conversation.turns
    .map((turn) => smsMessage(turn, conversation.counterparty, residentName))
    .filter((message) => !known.has(message.id));
  const rootId = `${row.id}-root`;
  const all = [...inboxThreadMessages(row), ...added];
  return withTurns(row, all, rootId);
}

/** Attach the server-resolved counterparty to every workspace-keyed row; drop any claim the client stored. */
export function stampCounterparties(
  rows: PersistedInboxThread[],
  identities: ReadonlyMap<string, ResidentCounterparty>,
): PersistedInboxThread[] {
  return rows.map((row) => {
    if (isResidentAssistantRow(row)) {
      const { counterparty: _c, smsOnly: _s, ...assistant } = row as PersistedInboxThread & { counterparty?: unknown; smsOnly?: unknown };
      return assistant as PersistedInboxThread;
    }
    const { counterparty: _claimed, smsOnly: _smsOnly, ...rest } = row as PersistedInboxThread & {
      counterparty?: unknown;
      smsOnly?: unknown;
    };
    const key = String(row.conversationKey ?? "");
    const workspaceId = key.startsWith("ws:") ? key.slice(3) : "";
    const identity = workspaceId ? identities.get(workspaceId) : undefined;
    return identity ? { ...rest, counterparty: identity } : rest;
  });
}

/**
 * The resident's list with their texts folded in: a conversation that already
 * has a row gains the texts in place; one that has only texts becomes a row of
 * its own. Never persisted (see `PROJECTED_SMS_TURN_PREFIX`).
 */
export function mergeResidentSmsConversations(
  rows: PersistedInboxThread[],
  conversations: readonly ResidentSmsConversation[],
  residentName: string,
): PersistedInboxThread[] {
  const out = [...rows];
  for (const conversation of conversations) {
    const key = workspaceKey(conversation.workspaceId);
    const index = out.findIndex(
      (row) => !isResidentAssistantRow(row) && row.conversationKey === key && String(row.workspaceId ?? conversation.workspaceId) === conversation.workspaceId,
    );
    if (index >= 0) {
      out[index] = mergeSmsTurnsIntoRow(out[index]!, conversation, residentName);
      continue;
    }
    const only = smsOnlyResidentRow(conversation, residentName);
    if (only) out.push(only);
  }
  return out;
}
