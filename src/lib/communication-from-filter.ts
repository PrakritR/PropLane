import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { PRIMARY_AXIS_ADMIN_EMAIL } from "@/data/inbox-scoped-directory";
import type { SmsCounterpartyRole } from "@/lib/sms-conversation-identity";
import { isTeamThreadId } from "@/lib/team-thread-id";
import { trimmedText } from "@/lib/trimmed-text";

/**
 * The Filter popover's "From" field: who is on the other end of a conversation on the work number / work email.
 * One group per conversation, derived from stored server truth (the SMS projection's `counterparty_role`, the
 * Team chat id, the prospect spine's `prospectContext`, the scoped contact directory's role) - never from a name.
 * A conversation whose counterparty cannot be established belongs to no group and shows only under "All".
 */
export type CommunicationFromGroup = "resident" | "vendor" | "manager" | "prospect";
export type CommunicationFromFilter = "all" | CommunicationFromGroup;

export const COMMUNICATION_FROM_OPTIONS: { value: CommunicationFromFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "resident", label: "Residents" },
  { value: "vendor", label: "Vendors" },
  { value: "manager", label: "Managers" },
  { value: "prospect", label: "Prospects" },
];

export function isCommunicationFromFilter(value: unknown): value is CommunicationFromFilter {
  return COMMUNICATION_FROM_OPTIONS.some((option) => option.value === value);
}

/** An SMS projection's stored counterparty role -> From group. Staff (manager / admin) are Managers. */
export function fromGroupForCounterpartyRole(role: SmsCounterpartyRole | null | undefined): CommunicationFromGroup | null {
  if (role === "resident") return "resident";
  if (role === "vendor") return "vendor";
  if (role === "manager" || role === "admin") return "manager";
  // An applicant has not signed a lease: a prospect until they are a resident.
  if (role === "prospect" || role === "applicant") return "prospect";
  return null;
}

type FromThread = {
  id: string;
  email?: string | null;
  threadType?: string | null;
  prospectContext?: unknown;
  platformState?: unknown;
};

/** An email / in-app thread -> From group, or null (the Assistant, a house group chat, an unknown sender). */
export function fromGroupForThread(
  thread: FromThread,
  contacts: readonly InboxScopedContact[] = [],
): CommunicationFromGroup | null {
  if (isTeamThreadId(thread.id) || thread.threadType === "team") return "manager";
  if (thread.id.startsWith("house-thread:") || thread.id.startsWith("agent_notice_") || thread.id.startsWith("resident-agent-")) {
    return null;
  }
  if (thread.prospectContext || thread.platformState) return "prospect";
  const email = trimmedText(thread.email).toLowerCase();
  if (!email) return null;
  if (email === PRIMARY_AXIS_ADMIN_EMAIL.toLowerCase()) return "manager";
  const contact = contacts.find((c) => trimmedText(c.email).toLowerCase() === email);
  if (!contact) return null;
  if (contact.role === "resident") return "resident";
  if (contact.role === "vendor") return "vendor";
  return "manager";
}

/** True when a conversation in `group` passes the selected From filter (`all` / unset passes everything). */
export function passesFromFilter(
  selected: CommunicationFromFilter | undefined,
  group: CommunicationFromGroup | null,
): boolean {
  if (!selected || selected === "all") return true;
  return group === selected;
}

export const COMMUNICATION_FROM_STORAGE_KEY = "proplane_communication_from_v1";

export function readStoredFromFilter(storage?: Pick<Storage, "getItem"> | null): CommunicationFromFilter {
  try {
    const raw = (storage ?? (typeof window === "undefined" ? null : window.localStorage))?.getItem(COMMUNICATION_FROM_STORAGE_KEY);
    return isCommunicationFromFilter(raw) ? raw : "all";
  } catch {
    return "all";
  }
}

export function writeStoredFromFilter(value: CommunicationFromFilter, storage?: Pick<Storage, "setItem"> | null): void {
  try {
    (storage ?? (typeof window === "undefined" ? null : window.localStorage))?.setItem(COMMUNICATION_FROM_STORAGE_KEY, value);
  } catch {
    /* private window / blocked storage: the filter just does not persist */
  }
}
