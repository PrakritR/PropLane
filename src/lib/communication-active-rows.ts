import {
  withPinnedPropLaneAssistantThreads,
  type CommunicationAssistantPortal,
} from "@/lib/communication-assistant-inbox-list";
import type { ManagerAssistantWorkspace } from "@/lib/communication-manager-assistant-thread";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import { collapsePersonInboxThreads, type PersistedInboxThread } from "@/lib/portal-inbox-storage";
import type { InboxListSegment } from "@/lib/communication-assistant-inbox-list";
import {
  mergeUnifiedInboxItems,
  unifiedInboxKey,
  unifiedInboxPersonKey,
  unifiedInboxSmsBindingKey,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";
import { smsThreadHasUnread, type ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

export type BuildActiveCommunicationThreadsOpts = {
  portal: CommunicationAssistantPortal;
  viewerId: string | null | undefined;
  workspace?: ManagerAssistantWorkspace | null;
  smsUiEnabled: boolean;
  /**
   * Which page tab is being built. The badge always counts Active; the pages
   * pass their own tab so the resident Unread / Archived tabs keep behaving
   * exactly as before (the resident Assistant row is pinned on Active only).
   */
  listSegment?: InboxListSegment;
};

/**
 * The row set both the manager and resident Communication lists build before
 * splitting into Active / Unread / Archived — lifted out of the manager list's
 * `filteredEmail` (`pro-unified-inbox.tsx`) and the resident list's
 * `filteredEmail` (`resident-communication.tsx`) so the Communication sidebar
 * badge can never drift from what Active actually renders. Every tab (this
 * page's Active, Unread and Archived) filters this same set by `folder`; this
 * function does not drop trash itself, so a caller that needs archived rows
 * (the page) and a caller that needs only unread inbox rows (the badge) can
 * both build on it.
 *
 * The manager list collapses person rows (one row per counterparty, folders
 * merged) before pinning the workspace's PropLane Assistant thread; the
 * resident list does not collapse. This must stay byte-for-byte identical to
 * those two pipelines; if either page's `filteredEmail` changes, update this
 * function (and its callers) in the same commit.
 */
export function buildActiveCommunicationThreads(
  rows: PersistedInboxThread[],
  opts: BuildActiveCommunicationThreadsOpts,
): PersistedInboxThread[] {
  const emailOnly = filterEmailInboxThreads(rows, { keepSmsLike: !opts.smsUiEnabled });
  const base = opts.portal === "manager" ? collapsePersonInboxThreads(emailOnly, { mergeFolders: true }) : emailOnly;
  return withPinnedPropLaneAssistantThreads(
    base,
    opts.portal,
    opts.viewerId,
    opts.listSegment ?? "active",
    opts.workspace,
  );
}

export type CountUnreadActiveCommunicationOpts = BuildActiveCommunicationThreadsOpts & {
  /** SMS conversation bindings the manager has already archived in the SMS panel. */
  archivedSmsIds?: ReadonlySet<string>;
};

/**
 * Unread conversations Active would show — exactly the dotted rows, minus any
 * SMS binding already archived in the SMS panel.
 */
export function countUnreadActiveCommunication(
  rows: PersistedInboxThread[],
  opts: CountUnreadActiveCommunicationOpts,
): number {
  const active = buildActiveCommunicationThreads(rows, opts);
  const archivedSms = opts.archivedSmsIds;
  return active.filter((thread) => {
    if (thread.folder !== "inbox" || !thread.unread) return false;
    const binding = thread.smsConversationKey?.trim();
    if (binding && archivedSms?.has(binding)) return false;
    return true;
  }).length;
}

/**
 * Who an email thread is with — the SAME expression the manager and resident
 * Communication lists use (`pro-unified-inbox.tsx`'s `emailListItems` /
 * `emailThreadMergeStub`) to decide which rows merge into one conversation.
 * Lifted out here so the sidebar badge and the list can never derive two
 * different answers for the same thread.
 */
export function emailThreadPersonKey(
  thread: Pick<PersistedInboxThread, "id" | "smsBindingKeys" | "smsConversationKey" | "email">,
): string | undefined {
  const smsBindingKeys = [...new Set(
    [...(thread.smsBindingKeys ?? []), thread.smsConversationKey ?? ""]
      .map((key) => key.trim())
      .filter(Boolean),
  )];
  return (
    (smsBindingKeys.length === 1 ? unifiedInboxSmsBindingKey(smsBindingKeys[0]) : undefined) ??
    (smsBindingKeys.length > 1 ? `email-explicit-binding:${thread.id}` : unifiedInboxPersonKey(thread.email))
  );
}

/**
 * Who an SMS conversation is with — the SAME expression the manager
 * Communication list uses (`pro-unified-inbox.tsx`'s `allSmsItems`) to decide
 * whether a text thread folds into an email thread's row or stays its own.
 * `explicitlyBoundSmsKeys` is every explicit binding declared by an active
 * email thread (see `emailThreadPersonKey`'s `smsBindingKeys`).
 */
export function smsConversationPersonKey(
  resident: Pick<ManagerSmsResidentConversation, "conversationKey" | "residentEmail">,
  explicitlyBoundSmsKeys: ReadonlySet<string>,
): string | undefined {
  return explicitlyBoundSmsKeys.has(resident.conversationKey ?? "")
    ? unifiedInboxSmsBindingKey(resident.conversationKey)
    : unifiedInboxPersonKey(resident.residentEmail);
}

/**
 * Stable per-conversation id for an SMS resident row — mirrors the local
 * `smsConversationId` in `pro-unified-inbox.tsx`, which hidden/archived ids are
 * keyed on.
 */
export function smsConversationRowId(
  resident: Pick<ManagerSmsResidentConversation, "conversationKey" | "phone" | "residentUserId" | "residentEmail" | "name">,
): string {
  return (
    resident.conversationKey ??
    resident.phone ??
    resident.residentUserId ??
    resident.residentEmail ??
    resident.name
  );
}

function emailThreadToUnreadMergeItem(
  thread: PersistedInboxThread,
  archivedSmsIds: ReadonlySet<string> | undefined,
): UnifiedInboxListItem {
  const smsBindingKeys = [...new Set(
    [...(thread.smsBindingKeys ?? []), thread.smsConversationKey ?? ""]
      .map((key) => key.trim())
      .filter(Boolean),
  )];
  const binding = thread.smsConversationKey?.trim();
  const archivedByBinding = Boolean(binding && archivedSmsIds?.has(binding));
  return {
    key: unifiedInboxKey("email", thread.id),
    channel: "email",
    threadId: thread.id,
    name: thread.id,
    preview: "",
    time: "",
    sortMs: 0,
    unread: thread.folder === "inbox" && Boolean(thread.unread) && !archivedByBinding,
    ...(smsBindingKeys.length > 0 ? { smsBindingKeys } : {}),
    ...(smsBindingKeys.length === 1 ? { smsBindingKey: smsBindingKeys[0] } : {}),
    personKey: emailThreadPersonKey(thread),
  };
}

function smsConversationToUnreadMergeItem(
  resident: ManagerSmsResidentConversation,
  explicitlyBoundSmsKeys: ReadonlySet<string>,
  smsOpenedIds: ReadonlySet<string>,
): UnifiedInboxListItem {
  const rowId = smsConversationRowId(resident);
  const messages = Array.isArray(resident.messages) ? resident.messages : [];
  return {
    key: unifiedInboxKey("sms", rowId),
    channel: "sms",
    threadId: rowId,
    name: resident.name,
    preview: "",
    time: "",
    sortMs: 0,
    unread: smsThreadHasUnread(messages, smsOpenedIds),
    smsBindingKey: resident.conversationKey?.trim() || undefined,
    personKey: smsConversationPersonKey(resident, explicitlyBoundSmsKeys),
  };
}

export type CountUnreadActiveConversationsOpts = CountUnreadActiveCommunicationOpts & {
  /** Every SMS conversation the manager can see. Ignored when `smsUiEnabled` is false — the page never loads them either. */
  smsConversations?: ManagerSmsResidentConversation[];
  /** Inbound message ids the manager has already opened (`loadManagerSmsOpenedIds`). */
  smsOpenedIds?: ReadonlySet<string>;
  /** Conversation ids permanently hidden from the list (`loadSmsHiddenIds`). */
  smsHiddenIds?: ReadonlySet<string>;
  /** Conversation ids archived in the SMS panel — excluded from the Active segment (`loadManagerSmsArchivedIds`). */
  smsArchivedIds?: ReadonlySet<string>;
};

/**
 * Unread conversations Active would show, email AND SMS combined — the
 * SMS-aware sibling of {@link countUnreadActiveCommunication}. A person
 * reached on both channels merges into one row exactly as the manager
 * Communication list merges it (`mergeUnifiedInboxItems`), so a resident with
 * an unread text and a read email counts once, not zero.
 */
export function countUnreadActiveConversations(
  rows: PersistedInboxThread[],
  opts: CountUnreadActiveConversationsOpts,
): number {
  const active = buildActiveCommunicationThreads(rows, opts);
  const explicitlyBoundSmsKeys = new Set(
    active
      .flatMap((thread) => [...(thread.smsBindingKeys ?? []), thread.smsConversationKey ?? ""])
      .map((key) => key.trim())
      .filter(Boolean),
  );
  const smsOpenedIds = opts.smsOpenedIds ?? new Set<string>();
  const smsHiddenIds = opts.smsHiddenIds ?? new Set<string>();
  const smsArchivedIds = opts.smsArchivedIds ?? new Set<string>();
  const smsConversations = opts.smsUiEnabled ? opts.smsConversations ?? [] : [];

  const emailItems = active.map((thread) => emailThreadToUnreadMergeItem(thread, opts.archivedSmsIds));
  const smsItems = smsConversations
    .filter((resident) => {
      const rowId = smsConversationRowId(resident);
      return !smsHiddenIds.has(rowId) && !smsArchivedIds.has(rowId);
    })
    .map((resident) => smsConversationToUnreadMergeItem(resident, explicitlyBoundSmsKeys, smsOpenedIds));

  // Reuses the list's own merge (rather than a second personKey-grouping
  // implementation) so an edge case in explicit-binding resolution can never
  // make the badge and the list disagree.
  return mergeUnifiedInboxItems([...emailItems, ...smsItems]).filter((item) => item.unread).length;
}
