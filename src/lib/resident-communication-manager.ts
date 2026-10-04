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
  /** Who the conversation is with: the manager's name, else what the thread carries. */
  name: string;
  /** Street of the home the conversation is about, when one is known. */
  homeLabel?: string;
  email?: string;
  phone?: string;
};

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
  thread: Pick<PersistedInboxThread, "from" | "email" | "houses" | "folder">,
  contacts: readonly ResidentManagerContact[],
): ResidentThreadManager {
  const matched = matchResidentManagerContact(thread.email, contacts);
  const sole = contacts.length === 1 ? contacts[0] : undefined;
  const name =
    matched?.managerName?.trim() ||
    thread.from?.trim() ||
    (thread.folder === "sent" ? thread.email?.trim() : "") ||
    thread.email?.trim() ||
    "Property manager";
  const homeLabel =
    conversationHouseLabels(thread.houses)?.[0] ??
    inboxRowAddressLabel(matched?.propertyLabel) ??
    inboxRowAddressLabel(sole?.propertyLabel);
  const email = thread.email?.trim() || matched?.email?.trim() || undefined;
  return {
    name,
    ...(homeLabel ? { homeLabel } : {}),
    ...(email ? { email } : {}),
    ...(matched?.phone ? { phone: matched.phone } : {}),
  };
}
