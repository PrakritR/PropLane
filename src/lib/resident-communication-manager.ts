/**
 * Which MANAGER a resident conversation is with.
 *
 * A resident can hold conversations with several managers (one per workspace
 * they have a tenancy with), so every row and every thread header names the
 * manager and the home that conversation is about, never a single shared
 * label. The match is by the manager's contact email — the same address the
 * thread's counterparty carries — and is never guessed when several managers
 * exist and none matches.
 */
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { ResidentManagerContact } from "@/hooks/use-resident-manager-contacts";
import { conversationHouseLabels, inboxRowAddressLabel } from "@/lib/communication-row-meta";

export type ResidentThreadManager = {
  /** Who the conversation is with: the server-stamped manager name, else what the thread carries. */
  name: string;
  /** The manager's workspace, from the server-stamped counterparty. */
  workspaceName?: string;
  /** The work number the resident texts (server-stamped counterparty, else the matched contact's). */
  workPhone?: string;
  /** Server-stamped initials, when the conversation carries a counterparty. */
  initials?: string;
  /** Street of the home the conversation is about, when one is known. */
  homeLabel?: string;
  email?: string;
  phone?: string;
};

/** Placeholders that name no one. "Resident" / "You" are the resident themself, never the other party. */
const GENERIC_PARTICIPANT_NAMES: ReadonlySet<string> = new Set([
  "",
  "property manager",
  "manager",
  "resident",
  "you",
  "unknown sender",
  "unknown recipient",
]);

export function isGenericParticipantName(name: string | null | undefined): boolean {
  return GENERIC_PARTICIPANT_NAMES.has(String(name ?? "").trim().toLowerCase());
}

function firstNamed(...candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    const name = String(candidate ?? "").trim();
    if (!isGenericParticipantName(name)) return name;
  }
  return "";
}

function norm(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

export function matchResidentManagerContact(
  threadEmail: string | null | undefined,
  contacts: readonly ResidentManagerContact[],
): ResidentManagerContact | undefined {
  const email = norm(threadEmail);
  if (!email) return undefined;
  return contacts.find((contact) => norm(contact.email) === email);
}

export function resolveResidentThreadManager(
  thread: Pick<PersistedInboxThread, "from" | "email" | "houses" | "folder" | "counterparty">,
  contacts: readonly ResidentManagerContact[],
): ResidentThreadManager {
  // The server resolved WHO this conversation is with from its workspace key;
  // that wins over matching the thread's email against the contact list, which
  // stays only for rows the server could not stamp.
  const counterparty = thread.counterparty;
  const matched = matchResidentManagerContact(thread.email, contacts);
  const sole = contacts.length === 1 ? contacts[0] : undefined;
  // The row title is never a placeholder when a real name is resolvable: the manager's name, then
  // their workspace, then what the thread stored. "Resident" on a stored row is the resident
  // themself, so it is skipped like every generic label; only then the generic fallback.
  const named = firstNamed(counterparty?.name, counterparty?.workspaceName, matched?.managerName, thread.from);
  // A row stored as "Resident" / "You" (or with no name) has only an address to offer; a stored
  // "Property manager" is already the generic label, so it is not swapped for a raw address.
  const fromIsSelf = isGenericParticipantName(thread.from) && !/manager/i.test(thread.from ?? "");
  const name =
    named ||
    (fromIsSelf ? firstNamed(thread.folder === "sent" ? thread.email : "", thread.email) : "") ||
    "Property manager";
  const homeLabel =
    conversationHouseLabels(thread.houses)?.[0] ??
    inboxRowAddressLabel(matched?.propertyLabel) ??
    inboxRowAddressLabel(sole?.propertyLabel);
  const email = thread.email?.trim() || matched?.email?.trim() || undefined;
  const workPhone = counterparty?.workPhone?.trim() || matched?.phone?.trim() || undefined;
  return {
    name,
    ...(counterparty?.workspaceName?.trim() ? { workspaceName: counterparty.workspaceName.trim() } : {}),
    ...(counterparty?.initials ? { initials: counterparty.initials } : {}),
    ...(workPhone ? { workPhone } : {}),
    ...(homeLabel ? { homeLabel } : {}),
    ...(email ? { email } : {}),
    ...(workPhone ? { phone: workPhone } : {}),
  };
}
