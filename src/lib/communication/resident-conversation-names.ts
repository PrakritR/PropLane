/**
 * What a resident's conversations are CALLED, and in what order they sit. Pure and client-safe.
 *
 * A resident can tell the three kinds of PropLane voice apart by name alone (captain, Nov 12):
 *
 *   - "PropLane"           the PropLane agent: the 206 line and the resident assistant in the top bar, on the
 *                          dashboard and in the list are ONE conversation (`resident-agent-<uid>`), pinned first.
 *   - the HOUSE            a manager's / owner's work-number conversation is titled by the house it is about
 *                          ("4709A 8th Ave"), never by the number that carries it.
 *   - "My PropLane agent"  the agent behind the resident's OWN PropLane Number (a paid number the resident holds).
 *                          Texts that reach that number from other people are filed under it.
 *
 * A phone number is never a title: it is a copyable detail inside the thread's header and info, or a quiet line
 * under the row. Documented in `docs/agents/communication-inbox.md` § What a resident's conversations are called.
 */
import { canonicalResidentAgentThreadId } from "@/lib/agent/resident-inbox-agent-ids";
import { isHouseInboxThread } from "@/lib/house-thread-id";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { inboxRowAddressLabel } from "@/lib/communication-row-meta";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { ResidentManagerContact } from "@/hooks/use-resident-manager-contacts";
import { matchResidentManagerContact, type ResidentThreadManager } from "@/lib/resident-communication-manager";

/** The PropLane agent: the 206 line and the resident assistant, one conversation. */
export const PROPLANE_AGENT_NAME = "PropLane";
/** The agent behind the resident's own PropLane Number. */
export const MY_PROPLANE_AGENT_NAME = "My PropLane agent";
/** A house conversation whose house is not known yet. A resident's conversation is never untitled. */
export const HOUSE_CONVERSATION_FALLBACK_NAME = "Your home";

export type ResidentConversationKind = "proplane_agent" | "house_chat" | "my_agent" | "house";

/** A number written the way people write one: digits and separators only, at least seven digits. */
export function looksLikePhoneNumber(value: string | null | undefined): boolean {
  const bare = String(value ?? "").trim();
  if (!bare) return false;
  if (/\p{L}/u.test(bare)) return false;
  return bare.replace(/\D/g, "").length >= 7;
}

/** The synthetic participant a text from a bare phone is filed under (`<phone>@sms.proplane.local`). */
const SMS_LOCAL_EMAIL = /@sms\.proplane\.local$/i;

/**
 * A text that reached the resident's own PropLane Number from somebody else (`storeThirdPartyText`): keyed by the
 * texter's phone, stored on the resident's side with a synthetic address and a `resident-agent-inbound-sms:` id.
 */
export function isResidentNumberTextThread(thread: Pick<PersistedInboxThread, "id" | "email">): boolean {
  return SMS_LOCAL_EMAIL.test(String(thread.email ?? "").trim()) || String(thread.id ?? "").startsWith("resident-agent-inbound-sms:");
}

/**
 * THE PropLane agent row (`resident-agent-<uid>`). A text that reached the resident's own number is filed under an id
 * that also starts `resident-agent-` (`resident-agent-inbound-sms:`), so it is checked FIRST and is never the agent.
 */
export function isResidentPropLaneAgentThread(thread: PersistedInboxThread): boolean {
  return isPropLaneAssistantInboxThread(thread) && !isResidentNumberTextThread(thread);
}

export function residentConversationKind(thread: PersistedInboxThread): ResidentConversationKind {
  if (isResidentNumberTextThread(thread)) return "my_agent";
  if (isPropLaneAssistantInboxThread(thread)) return "proplane_agent";
  if (isHouseInboxThread(thread)) return "house_chat";
  return "house";
}

/** The one id of a resident's PropLane agent conversation, whichever entry point opened it. */
export function residentAssistantConversationId(residentUserId: string): string {
  return canonicalResidentAgentThreadId(residentUserId.trim());
}

/** Every door into the PropLane agent. */
export type ResidentAssistantEntryPoint =
  | "top_bar"
  | "dashboard_card"
  | "phone_ask_tab"
  | "composer_ask"
  | "communication_list";

export const RESIDENT_ASSISTANT_ENTRY_POINTS: readonly ResidentAssistantEntryPoint[] = [
  "top_bar",
  "dashboard_card",
  "phone_ask_tab",
  "composer_ask",
  "communication_list",
];

/**
 * Which conversation an entry point reaches. There is exactly one answer per resident: the top bar's side panel
 * (desktop) / sheet (phone), the dashboard's Ask card, the phone's Ask tab, a composer's "Ask PropLane" and the
 * pinned row in Communication all mount the same provider state and name the same `resident-agent-<uid>` id, so
 * what a resident typed in one door is the history in every other. There is no second assistant route or registry.
 */
export function residentAssistantEntryTarget(
  _entry: ResidentAssistantEntryPoint,
  residentUserId: string,
): { conversationId: string; endpoint: "/api/agent/resident-chat" } {
  void _entry;
  return { conversationId: residentAssistantConversationId(residentUserId), endpoint: "/api/agent/resident-chat" };
}

/** What a stored author of the assistant ("PropLane Assistant") is called on screen. */
export function residentAssistantDisplayName(storedName: string | null | undefined): string {
  const name = String(storedName ?? "").trim();
  if (!name || /^propLane assistant$/i.test(name)) return PROPLANE_AGENT_NAME;
  return name;
}

export type ResidentConversationLabel = {
  kind: ResidentConversationKind;
  /** The row title and the thread header's title. Never a phone number. */
  title: string;
  /** The house this conversation is about, when one is known. */
  houseLabel?: string;
  /** Who is on the other end: the manager's name, or the number's owner. Omitted when it only repeats the title. */
  withName?: string;
  /**
   * The work number to show as a COPYABLE detail (header / info), never as a title. Only a real work number
   * (a server-stamped counterparty number, or a contact whose phone is a work line), never a manager's profile phone.
   */
  workPhone?: string;
};

/** The first candidate that is a NAME: not empty, not a phone number, not a bare email address. */
function firstNonPhone(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const text = String(candidate ?? "").trim();
    if (text && !looksLikePhoneNumber(text) && !text.includes("@")) return text;
  }
  return "";
}

/** The house's work number for a conversation: a stamped work line, else a contact's work (not profile) phone. */
export function residentHouseWorkPhone(
  thread: Pick<PersistedInboxThread, "email" | "counterparty">,
  contacts: readonly ResidentManagerContact[],
): string | undefined {
  const stamped = thread.counterparty?.workPhone?.trim();
  if (stamped) return stamped;
  const matched = matchResidentManagerContact(thread.email, contacts);
  return matched?.phoneKind === "work" ? matched.phone?.trim() || undefined : undefined;
}

/**
 * The title of one resident conversation. A house conversation is titled by its HOUSE, then the workspace, then the
 * manager's name, then "Your home"; nothing in that chain can be a phone number.
 */
export function residentConversationLabel(
  thread: PersistedInboxThread,
  manager: ResidentThreadManager,
  contacts: readonly ResidentManagerContact[],
): ResidentConversationLabel {
  const kind = residentConversationKind(thread);
  if (kind === "proplane_agent") return { kind, title: PROPLANE_AGENT_NAME };
  if (kind === "house_chat") {
    return { kind, title: firstNonPhone(thread.from) || "House" };
  }
  if (kind === "my_agent") {
    const caller = formatSmsPhoneLabel(String(thread.from ?? "").trim()) ?? undefined;
    return { kind, title: MY_PROPLANE_AGENT_NAME, ...(caller ? { withName: caller } : {}) };
  }
  const houseLabel = manager.homeLabel?.trim() || undefined;
  const title =
    houseLabel ||
    firstNonPhone(manager.workspaceName, manager.name) ||
    HOUSE_CONVERSATION_FALLBACK_NAME;
  const withName = firstNonPhone(manager.name);
  const workPhone = residentHouseWorkPhone(thread, contacts);
  return {
    kind,
    title,
    ...(houseLabel ? { houseLabel } : {}),
    ...(withName && withName !== title ? { withName } : {}),
    ...(workPhone ? { workPhone } : {}),
  };
}

/**
 * A house the resident lives in (or is about to) that has no conversation yet: the list offers it as a place to
 * start one. Derived from the manager contacts the page already loads, never from anything the browser invents.
 */
export type ResidentHouseStarter = {
  /** Stable row id: `house-start:<email>`. Never a stored thread id. */
  id: string;
  houseLabel: string;
  managerName?: string;
  /** The recipient the existing New message path addresses. */
  email: string;
  /** Only a work-kind phone: shown copyable in the starter's info, never as the title. */
  workPhone?: string;
};

export const HOUSE_STARTER_ID_PREFIX = "house-start:";

export function isHouseStarterId(id: string | null | undefined): boolean {
  return String(id ?? "").startsWith(HOUSE_STARTER_ID_PREFIX);
}

export function residentHouseStarters(
  contacts: readonly ResidentManagerContact[],
  threads: readonly Pick<PersistedInboxThread, "email" | "folder">[],
  /** Streets that already have a conversation (a thread whose address differs from the contact's still covers its house). */
  coveredHouses: readonly string[] = [],
): ResidentHouseStarter[] {
  const covered = new Set(coveredHouses.map((label) => label.trim().toLowerCase()).filter(Boolean));
  const talkedTo = new Set(
    threads
      .filter((thread) => thread.folder !== "trash")
      .map((thread) => String(thread.email ?? "").trim().toLowerCase())
      .filter(Boolean),
  );
  const starters: ResidentHouseStarter[] = [];
  const seen = new Set<string>();
  for (const contact of contacts) {
    if (contact.status === "ended") continue;
    const email = contact.email?.trim().toLowerCase() ?? "";
    if (!email || seen.has(email) || talkedTo.has(email)) continue;
    const houseLabel = firstNonPhone(inboxRowAddressLabel(contact.propertyLabel), contact.propertyLabel);
    if (!houseLabel || covered.has(houseLabel.toLowerCase())) continue;
    seen.add(email);
    const managerName = firstNonPhone(contact.managerName);
    const workPhone = contact.phoneKind === "work" ? contact.phone?.trim() || undefined : undefined;
    starters.push({
      id: `${HOUSE_STARTER_ID_PREFIX}${email}`,
      houseLabel,
      ...(managerName ? { managerName } : {}),
      email,
      ...(workPhone ? { workPhone } : {}),
    });
  }
  return starters;
}

/** The kinds in the order a resident's list shows them, after the PropLane agent. */
const KIND_ORDER: Record<ResidentConversationKind, number> = {
  proplane_agent: 0,
  house_chat: 1,
  house: 2,
  my_agent: 2,
};

/**
 * The list order: the PropLane agent first, ALWAYS; then the house chats as a group; then every house and
 * number conversation by recency. A stable partition over rows that are already newest-first, so within a group
 * nothing moves. `kindOf` reads a row's kind from its thread id.
 */
export function orderResidentConversationRows<T extends { threadId: string; sortMs: number }>(
  rows: readonly T[],
  kindOf: (row: T) => ResidentConversationKind,
): T[] {
  return rows
    .map((row, index) => ({ row, index, rank: KIND_ORDER[kindOf(row)] }))
    .sort((a, b) => a.rank - b.rank || (a.rank === 2 ? b.row.sortMs - a.row.sortMs : 0) || a.index - b.index)
    .map((entry) => entry.row);
}

/** The thread header's one line under the title: who is on the other end, then the work number (also copyable). */
export function residentThreadHeaderSubtitle(label: ResidentConversationLabel | null | undefined): string | undefined {
  if (!label) return undefined;
  const number = label.workPhone ? formatSmsPhoneLabel(label.workPhone) : null;
  return [label.withName, number].filter(Boolean).join(" · ") || undefined;
}
