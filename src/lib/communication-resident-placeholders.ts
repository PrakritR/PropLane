import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import {
  threadPassesCommunicationFilters,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import {
  unifiedInboxKey,
  unifiedInboxPersonKey,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";

export const CONTACT_INBOX_THREAD_PREFIX = "contact-";

export function contactInboxThreadId(contactId: string): string {
  return `${CONTACT_INBOX_THREAD_PREFIX}${contactId}`;
}

export function parseContactInboxThreadId(threadId: string): string | null {
  if (!threadId.startsWith(CONTACT_INBOX_THREAD_PREFIX)) return null;
  const id = threadId.slice(CONTACT_INBOX_THREAD_PREFIX.length).trim();
  return id || null;
}

export function isContactInboxThreadId(threadId: string): boolean {
  return threadId.startsWith(CONTACT_INBOX_THREAD_PREFIX);
}

/**
 * A persisted (real) thread id for a resident-directory placeholder's
 * contact, minted once the manager archives it. Deliberately a DIFFERENT
 * prefix from `CONTACT_INBOX_THREAD_PREFIX` — that one names the synthetic,
 * never-persisted placeholder ROW ITSELF (no stored conversation exists),
 * while this one becomes a genuine `portal_inbox_thread_records` row the
 * instant it is archived, and must never be mistaken for the placeholder by
 * `isContactInboxThreadId` (which gates "no actions available").
 */
export const CONTACT_ARCHIVE_THREAD_PREFIX = "contact_thread_";

export function contactArchiveThreadId(contactId: string): string {
  return `${CONTACT_ARCHIVE_THREAD_PREFIX}${contactId}`;
}

/** Residents with no live email/SMS thread still appear so managers can start a chat. */
export function buildResidentPlaceholderInboxItems(args: {
  contacts: InboxScopedContact[];
  filters: CommunicationThreadFilters;
  occupiedEmails: ReadonlySet<string>;
  searchQuery?: string;
  listSegment?: "active" | "unread" | "archived";
}): UnifiedInboxListItem[] {
  if (args.listSegment === "archived" || args.listSegment === "unread") return [];

  const q = args.searchQuery?.trim().toLowerCase() ?? "";

  return args.contacts
    .filter((contact) => contact.role === "resident" && contact.email.trim())
    .filter((contact) => {
      const email = contact.email.trim().toLowerCase();
      if (args.occupiedEmails.has(email)) return false;
      if (
        !threadPassesCommunicationFilters({
          filters: args.filters,
          contacts: args.contacts,
          counterpartyEmail: contact.email,
          propertyId: contact.propertyId,
          propertyLabel: contact.propertyLabel,
          isResidentThread: true,
        })
      ) {
        return false;
      }
      if (!q) return true;
      const hay = [contact.name, contact.email, contact.propertyLabel].filter(Boolean).join(" ").toLowerCase();
      return hay.includes(q);
    })
    .map((contact) => {
      const threadId = contactInboxThreadId(contact.id);
      return {
        key: unifiedInboxKey("email", threadId),
        channel: "email" as const,
        threadId,
        personKey: unifiedInboxPersonKey(contact.email),
        personEmail: contact.email.trim() || undefined,
        name: contact.name.trim() || contact.email.trim(),
        subtitle: contact.propertyLabel?.trim() || undefined,
        preview: "No messages yet.",
        time: "",
        unread: false,
        sortMs: 0,
      };
    });
}
