"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  clearCommunicationThreadUrl,
  selectCommunicationThreadUrl,
} from "@/lib/portal-communication-nav";
import { ManagerInbox, type ManagerInboxHandle } from "@/components/portal/pro-inbox";
import { ManagerSmsPanel, type ManagerSmsPanelHandle } from "@/components/portal/pro-sms-panel";
import { DestinationNav } from "@/components/ui/destination-nav";
import {
  CommunicationInboxRowCheckbox,
  CommunicationListBulkBar,
} from "@/components/portal/communication-list-bulk-bar";
import {
  PortalContactDetailsModal,
} from "@/components/portal/portal-contact-details-modal";
import { dispatchManagerSmsContactsChanged } from "@/lib/manager-sms-messages";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import { useIsClient } from "@/hooks/use-is-client";
import { usePortalSession } from "@/hooks/use-portal-session";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import {
  INBOX_LIST_SCROLL,
  InboxConversationListAddRow,
  InboxConversationRow,
  InboxThreadEmpty,
  InboxTwoPane,
  PORTAL_INBOX_LIST_TOOLBAR_CLASS,
  PortalInboxEmptyState,
  type InboxListSegment,
} from "@/components/portal/portal-inbox-ui";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import {
  buildManagerAssistantPlaceholderThread,
  communicationInboxListPreview,
  managerAgentNoticeThreadId,
  pinPropLaneAssistantUnifiedItems,
  propLaneAssistantListPreview,
  propLaneAssistantListSubtitle,
  propLaneAssistantThreadIdForPortal,
  resolveCommunicationViewerId,
  withPinnedPropLaneAssistantThreads,
} from "@/lib/communication-assistant-inbox-list";
import {
  buildResidentPlaceholderInboxItems,
  parseContactInboxThreadId,
} from "@/lib/communication-resident-placeholders";
import {
  threadPassesCommunicationFilters,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import { ResidentDirectChatPane } from "@/components/portal/pro-resident-detail-inbox";
import {
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  collapsePersonInboxThreads,
  loadPersistedInbox,
  inboxThreadMessages,
  inboxThreadSortMs,
  inboxMessageOutbound,
  stagePersistedInboxRows,
  syncPersistedInboxFromServer,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import {
  mergeUnifiedInboxItems,
  parseUnifiedInboxKey,
  unifiedInboxKey,
  unifiedInboxPersonKey,
  type CommunicationListSort,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";
import {
  MANAGER_SMS_CONTACTS_CHANGED_EVENT,
  normalizeManagerSmsConversationsPayload,
  smsConversationDisplayName,
  smsConversationSubtitle,
  smsThreadHasUnread,
  type ManagerSmsContactsChangedDetail,
  type ManagerSmsResidentConversation,
} from "@/lib/manager-sms-messages";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import {
  loadManagerSmsArchivedIds,
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT,
} from "@/lib/manager-sms-archive.client";

const SMS_OPENED_STORAGE_KEY = "axis_manager_sms_opened_v1";
const SMS_HIDDEN_STORAGE_KEY = "axis_manager_sms_hidden_v2";

function previewLine(body: string, max = 80) {
  const t = body.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function smsConversationId(resident: ManagerSmsResidentConversation): string {
  return (
    resident.conversationKey ??
    resident.phone ??
    resident.residentUserId ??
    resident.residentEmail ??
    resident.name
  );
}

function loadSmsOpenedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SMS_OPENED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function loadSmsHiddenIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SMS_HIDDEN_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0));
  } catch {
    return new Set();
  }
}

function iosListTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const dayDiff = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (dayDiff === 0) {
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

/** Desktop shows list + thread together; phones use list-then-thread navigation. */
function inboxUsesDesktopSplit(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 1024px)").matches;
}

export function ManagerUnifiedInbox({
  tabId,
  commBase,
  listSegment: listSegmentProp = "active",
  routeThreadId,
  onRouteThreadChange,
  threadFilters,
  filterContacts,
  listSort = "recent",
  smsUiEnabled = false,
  onSmsUnreadCountChange,
  inboxRef,
  smsRef,
  onThreadOpenChange,
  onThreadSelectedChange,
  searchQuery: searchQueryProp,
  onSearchQueryChange,
  listChrome = "internal",
  onAddConversation,
}: {
  tabId: string;
  commBase: string;
  listSegment?: InboxListSegment;
  /** Deep-linked thread id from `/communication/{segment}/{threadId}`. */
  routeThreadId?: string;
  onRouteThreadChange?: (threadId: string | undefined) => void;
  threadFilters?: CommunicationThreadFilters;
  filterContacts?: InboxScopedContact[];
  /** Conversation list order — default is most recent activity. */
  listSort?: CommunicationListSort;
  /** When false, SMS conversations / rows / panel are hidden (transport unaffected). */
  smsUiEnabled?: boolean;
  onSmsUnreadCountChange?: (unread: number) => void;
  inboxRef?: React.RefObject<ManagerInboxHandle | null>;
  smsRef?: React.RefObject<ManagerSmsPanelHandle | null>;
  onThreadOpenChange?: (open: boolean) => void;
  /** Fires when any conversation row is selected (desktop split or mobile). */
  onThreadSelectedChange?: (selected: boolean) => void;
  /** Controlled search when list chrome is rendered by the parent control stack. */
  searchQuery?: string;
  onSearchQueryChange?: (value: string) => void;
  /** `external` — segment tabs + search live in {@link PortalListControlStack}. */
  listChrome?: "internal" | "external";
  /** Opens the new-message / compose flow when the list is empty on Active. */
  onAddConversation?: () => void;
}) {
  const isClient = useIsClient();
  const [emailThreads, setEmailThreads] = useState<PersistedInboxThread[]>([]);
  const [smsResidents, setSmsResidents] = useState<ManagerSmsResidentConversation[]>([]);
  const [smsOpenedIds, setSmsOpenedIds] = useState<Set<string>>(() => loadSmsOpenedIds());
  const [smsHiddenIds, setSmsHiddenIds] = useState<Set<string>>(() => loadSmsHiddenIds());
  const [smsArchivedIds, setSmsArchivedIds] = useState<Set<string>>(() => loadManagerSmsArchivedIds());
  const [internalQuery, setInternalQuery] = useState("");
  const query = onSearchQueryChange ? (searchQueryProp ?? "") : internalQuery;
  const setQuery = onSearchQueryChange ?? setInternalQuery;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(Boolean(routeThreadId));
  const listSegment = listSegmentProp;
  const appUi = useOptionalAppUi();
  const { userId } = usePortalSession();
  const viewerId = resolveCommunicationViewerId(null, userId);
  const assistantThreadId = viewerId ? propLaneAssistantThreadIdForPortal("manager", viewerId) : null;

  const threadListHref = useCallback(
    () => `${commBase}/${listSegment}`,
    [commBase, listSegment],
  );

  const threadDetailHref = useCallback(
    (threadId: string) => `${commBase}/${listSegment}/${encodeURIComponent(threadId)}`,
    [commBase, listSegment],
  );

  useEffect(() => {
    const syncArchive = () => setSmsArchivedIds(loadManagerSmsArchivedIds());
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, syncArchive as EventListener);
    return () => window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, syncArchive as EventListener);
  }, []);

  useEffect(() => {
    if (!isClient) return;
    setEmailThreads(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []));
    void syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY).then((rows) => {
      setEmailThreads(rows);
    });
  }, [isClient]);

  useEffect(() => {
    const sync = () => setEmailThreads(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []));
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
  }, []);

  useEffect(() => {
    if (!isClient || !viewerId?.trim() || listSegment !== "active") return;
    let staged: PersistedInboxThread[] | null = null;
    setEmailThreads((current) => {
      const hasAssistant = current.some(
        (thread) =>
          isPropLaneAssistantInboxThread(thread) ||
          thread.id === managerAgentNoticeThreadId(viewerId),
      );
      if (hasAssistant) return current;
      const next = [buildManagerAssistantPlaceholderThread(viewerId), ...current];
      staged = next;
      return next;
    });
    if (staged) {
      queueMicrotask(() => stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, staged!));
    }
  }, [isClient, listSegment, viewerId]);

  const loadSms = useCallback(async () => {
    // SMS UI hidden until A2P clears — never fetch SMS conversations. Inbound
    // texts still land as inbox notices and fall through to the unified list
    // (see filterEmailInboxThreads keepSmsLike below); transport is unaffected.
    if (!smsUiEnabled) return;
    try {
      const res = await fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { residents?: ManagerSmsResidentConversation[] };
      const normalized = normalizeManagerSmsConversationsPayload(body);
      setSmsResidents((current) => {
        const server = normalized.residents;
        const serverKeys = new Set(
          server.flatMap((row) =>
            [row.conversationKey, ...(row.memberKeys ?? [])].filter(
              (key): key is string => typeof key === "string" && key.length > 0,
            ),
          ),
        );
        // Keep just-created empty contacts until the server round-trip includes
        // them — otherwise a fast refetch can wipe the optimistic seed and the
        // URL points at a thread that vanished from the list.
        const pendingOptimistic = current.filter((row) => {
          const key = row.conversationKey?.trim();
          if (!key || serverKeys.has(key)) return false;
          if ((row.memberKeys ?? []).some((member) => serverKeys.has(member))) return false;
          return Boolean(row.savedContactName) && (!row.messages || row.messages.length === 0);
        });
        return pendingOptimistic.length > 0 ? [...pendingOptimistic, ...server] : server;
      });
    } catch {
      /* keep prior */
    }
  }, [smsUiEnabled]);

  useEffect(() => {
    // smsUiEnabled is a stable server prop; when off, loadSms no-ops and
    // smsResidents stays its initial [] — no fetch, no polling.
    if (!smsUiEnabled) return;
    void loadSms();
    // Poll for inbound texts, but skip while the tab is backgrounded (no point
    // spending egress on a hidden page) and refetch immediately on refocus so
    // the list is fresh the moment the manager returns.
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadSms();
    };
    const id = window.setInterval(tick, 20_000);
    const onVis = () => {
      if (document.visibilityState === "visible") void loadSms();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [loadSms, smsUiEnabled]);

  useEffect(() => {
    if (!smsUiEnabled) return;
    const refreshContacts = (event: Event) => {
      const detail = (event as CustomEvent<ManagerSmsContactsChangedDetail>).detail;
      const optimistic = detail?.optimisticResident;
      if (optimistic?.conversationKey) {
        setSmsResidents((current) => {
          const key = optimistic.conversationKey!;
          const phone = String(optimistic.phone ?? "").trim();
          let matched = false;
          const next = current.map((row) => {
            const sameKey =
              row.conversationKey === key || (row.memberKeys ?? []).includes(key);
            const samePhone =
              Boolean(phone) &&
              Boolean(row.phone) &&
              String(row.phone).replace(/\D/g, "") === phone.replace(/\D/g, "");
            if (!sameKey && !samePhone) return row;
            matched = true;
            return {
              ...row,
              name: optimistic.name || row.name,
              savedContactName: optimistic.savedContactName ?? row.savedContactName,
            };
          });
          if (matched) return next;
          return [optimistic, ...current];
        });
      }
      void loadSms();
    };
    window.addEventListener(MANAGER_SMS_CONTACTS_CHANGED_EVENT, refreshContacts);
    return () => window.removeEventListener(MANAGER_SMS_CONTACTS_CHANGED_EVENT, refreshContacts);
  }, [loadSms, smsUiEnabled]);

  // Stable identity: passed into ManagerSmsPanel's controlled-open effect, so an
  // inline callback here would change every render and loop the effect forever.
  // Opening a conversation only changes local read state — refresh the opened-id
  // set for the unread badges, but do NOT refetch (the server data is unchanged,
  // and the open SMS panel already reloads on its own; a refetch here was a
  // redundant round-trip on every thread open).
  const handleSmsConversationOpened = useCallback(() => {
    setSmsOpenedIds(loadSmsOpenedIds());
  }, []);

  const filteredEmail = useMemo(() => {
    // When SMS UI is hidden, KEEP SMS-like inbound notices so an inbound text is
    // still visible in the person's conversation instead of vanishing into a
    // hidden SMS panel.
    const base = collapsePersonInboxThreads(
      filterEmailInboxThreads(emailThreads, { keepSmsLike: !smsUiEnabled }),
      { mergeFolders: true },
    );
    const withAssistant = withPinnedPropLaneAssistantThreads(base, "manager", viewerId, listSegment);
    if (!threadFilters || !filterContacts) return withAssistant;
    return withAssistant.filter((t) =>
      isPropLaneAssistantInboxThread(t) ||
      threadPassesCommunicationFilters({
        filters: threadFilters,
        contacts: filterContacts,
        counterpartyEmail: t.email,
      }),
    );
  }, [emailThreads, threadFilters, filterContacts, listSegment, smsUiEnabled, viewerId]);

  const emailListItems = useMemo((): UnifiedInboxListItem[] => {
    const q = query.trim().toLowerCase();
    let rows = filteredEmail;
    if (listSegment === "archived") {
      rows = rows.filter((t) => t.folder === "trash");
    } else if (listSegment === "unread") {
      rows = rows.filter((t) => t.folder !== "trash" && t.folder === "inbox" && t.unread);
    } else {
      rows = rows.filter((t) => t.folder !== "trash");
    }
    if (q) {
      // Search refines the selected segment; it must not leak read rows back
      // into Unread or active rows back into Archived.
      rows = rows.filter((t) => {
        const hay = [t.from, t.email, t.subject, t.body, t.preview].filter(Boolean).join(" ").toLowerCase();
        return hay.includes(q);
      });
    }

    return rows.map((t) => {
      const msgs = inboxThreadMessages(t);
      const lastMsg = msgs[msgs.length - 1];
      const sentSemantics = t.folder === "sent";
      const displayName = sentSemantics ? t.email || "Unknown recipient" : t.from || t.email || "Unknown sender";
      const lastIndex = Math.max(0, msgs.length - 1);
      const lastOutbound = lastMsg
        ? inboxMessageOutbound(lastMsg, lastIndex, t.folder, t)
        : t.folder === "sent";
      return {
        key: unifiedInboxKey("email", t.id),
        channel: "email" as const,
        threadId: t.id,
        // Who this is with, so a text thread with the same person folds in.
        personKey: unifiedInboxPersonKey(t.email),
        personEmail: t.email?.trim() || undefined,
        name: displayName,
        subtitle: isPropLaneAssistantInboxThread(t)
          ? propLaneAssistantListSubtitle(t)
          : t.subject,
        preview: isPropLaneAssistantInboxThread(t)
          ? propLaneAssistantListPreview(t, listSegment)
          : communicationInboxListPreview(lastMsg?.body ?? t.preview ?? "", listSegment, 80),
        previewPrefix: lastOutbound ? "You: " : undefined,
        time: t.time,
        unread: t.folder === "inbox" && t.unread,
        // Sort on the SAME field the row is labelled with. `lastMsg.at` is the
        // raw stamp its writer happened to build; only `thread.time` is
        // normalized (`appendReplyToInboxThread` advances it to the latest
        // reply), so sorting on the message stamp let an unparseable one fall
        // back to the id's creation epoch and never float a reply to the top.
        sortMs: inboxThreadSortMs(t.id, t.time),
      };
    });
  }, [filteredEmail, query, listSegment]);

  // SMS rows (scoped + de-hidden), each tagged with its haystack and
  // last-message direction. Empty unless the SMS UI flag is on.
  const allSmsItems = useMemo((): {
    item: UnifiedInboxListItem;
    lastOutbound: boolean;
    haystack: string;
    archived: boolean;
    unread: boolean;
  }[] => {
    if (!smsUiEnabled) return [];
    const scoped = !threadFilters || !filterContacts
      ? smsResidents
      : smsResidents.filter((resident) =>
          threadPassesCommunicationFilters({
            filters: threadFilters,
            contacts: filterContacts,
            counterpartyEmail: resident.residentEmail,
            propertyLabel: resident.propertyLabel,
            counterpartyRole: resident.counterpartyRole,
          }),
        );

    return scoped
      .map((resident) => {
        const messages = Array.isArray(resident.messages) ? resident.messages : [];
        const lastMessage = messages[messages.length - 1] ?? null;
        const rowId = smsConversationId(resident);
        if (smsHiddenIds.has(rowId)) return null;
        const archived = smsArchivedIds.has(rowId);
        const unread = smsThreadHasUnread(messages, smsOpenedIds);
        const lastOutbound = lastMessage?.direction === "outbound";
        const item: UnifiedInboxListItem = {
          key: unifiedInboxKey("sms", rowId),
          channel: "sms",
          threadId: rowId,
          // Only a resolved address merges. An unknown number carries none, so
          // it stays its own conversation rather than being guessed onto a
          // resident.
          personKey: unifiedInboxPersonKey(resident.residentEmail),
          personEmail: resident.residentEmail?.trim() || undefined,
          // Prefer person name / unit / email; fall back to a readable phone.
          name: smsConversationDisplayName(resident),
          subtitle: smsConversationSubtitle(resident) || undefined,
          preview: communicationInboxListPreview(
            lastMessage ? lastMessage.body : "No messages yet",
            listSegment,
            80,
          ),
          previewPrefix: lastOutbound ? "You: " : undefined,
          time: lastMessage ? iosListTimestamp(lastMessage.createdAt) : "",
          unread,
          sortMs: lastMessage ? Date.parse(lastMessage.createdAt) || 0 : 0,
        };
        // The phone is hidden in the UI but stays in the search index — a
        // manager who types a resident's number must still find the thread.
        const haystack = [
          resident.name,
          resident.phone,
          resident.residentEmail,
          resident.propertyLabel,
          lastMessage?.body,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return { item, lastOutbound, haystack, archived, unread };
      })
      .filter((x): x is { item: UnifiedInboxListItem; lastOutbound: boolean; haystack: string; archived: boolean; unread: boolean } => x !== null);
  }, [filterContacts, smsArchivedIds, smsHiddenIds, smsOpenedIds, smsResidents, threadFilters, smsUiEnabled]);

  const smsListItems = useMemo((): UnifiedInboxListItem[] => {
    const q = query.trim().toLowerCase();
    const items = allSmsItems.filter(({ archived, unread, haystack }) => {
      if (q && !haystack.includes(q)) return false;
      if (listSegment === "archived") return archived;
      if (listSegment === "unread") return !archived && unread;
      return !archived;
    });
    return items.map(({ item }) => item);
  }, [allSmsItems, query, listSegment]);

  const occupiedResidentEmails = useMemo(() => {
    const occupied = new Set<string>();
    for (const row of filteredEmail) {
      if (row.folder === "trash") continue;
      const email = row.email?.trim().toLowerCase();
      if (email) occupied.add(email);
    }
    for (const resident of smsResidents) {
      const messages = Array.isArray(resident.messages) ? resident.messages : [];
      if (messages.length === 0) continue;
      const rowId = smsConversationId(resident);
      if (smsHiddenIds.has(rowId)) continue;
      if (smsArchivedIds.has(rowId)) continue;
      const email = resident.residentEmail?.trim().toLowerCase();
      if (email) occupied.add(email);
    }
    return occupied;
  }, [filteredEmail, smsArchivedIds, smsHiddenIds, smsResidents]);

  const placeholderListItems = useMemo(() => {
    if (!filterContacts || listSegment === "archived" || listSegment === "unread") return [];
    return buildResidentPlaceholderInboxItems({
      contacts: filterContacts,
      filters: threadFilters ?? { propertyIds: [], roles: [], contactIds: [] },
      occupiedEmails: occupiedResidentEmails,
      searchQuery: query,
      listSegment,
    });
  }, [filterContacts, listSegment, occupiedResidentEmails, query, threadFilters]);

  const mergedRows = useMemo(() => {
    const merged = mergeUnifiedInboxItems(
      [...emailListItems, ...smsListItems, ...placeholderListItems],
      listSort,
    );
    return pinPropLaneAssistantUnifiedItems(merged, assistantThreadId);
  }, [assistantThreadId, emailListItems, listSort, placeholderListItems, smsListItems]);

  // SSR and the first client paint must agree — local inbox + contact rows load only after mount.
  const listRows = isClient ? mergedRows : [];

  const bulk = useUnifiedCommunicationBulk({
    mergedRows: listRows,
    listSegment,
    storageKey: MANAGER_INBOX_STORAGE_KEY,
    emailThreads,
    onEmailThreadsChange: setEmailThreads,
    onSmsArchiveChange: () => setSmsArchivedIds(loadManagerSmsArchivedIds()),
    showToast: appUi?.showToast,
    onSelectionCleared: () => {
      setSelectedKey(null);
      setMobileThreadOpen(false);
      onRouteThreadChange?.(undefined);
      clearCommunicationThreadUrl(threadListHref());
    },
  });

  const selection = useMemo(() => (selectedKey ? parseUnifiedInboxKey(selectedKey) : null), [selectedKey]);

  /**
   * The selected row, matched on ANY key it folded in — a merged conversation
   * is reachable by the key of either channel (a deep link minted before the
   * merge still resolves).
   */
  const selectedRow = useMemo(
    () =>
      selectedKey
        ? (mergedRows.find(
            (row) => row.key === selectedKey || (row.memberKeys ?? []).includes(selectedKey),
          ) ?? null)
        : null,
    [mergedRows, selectedKey],
  );

  /**
   * A conversation that spans both channels renders as ONE thread — the direct
   * chat pane, which already speaks email and SMS for a single person — rather
   * than picking one channel's pane and hiding the other half of the history.
   */
  const mergedPersonEmail = useMemo(() => {
    if (!selectedRow || (selectedRow.channels?.length ?? 1) < 2) return null;
    return selectedRow.personEmail?.trim() || null;
  }, [selectedRow]);
  const placeholderContact = useMemo(() => {
    if (!selection || !filterContacts) return null;
    const contactId = parseContactInboxThreadId(selection.threadId);
    if (!contactId) return null;
    return filterContacts.find((contact) => contact.id === contactId) ?? null;
  }, [filterContacts, selection]);

  const refreshAfterDirectSend = useCallback(() => {
    void syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true }).then((rows) => {
      setEmailThreads(rows);
      const contact = placeholderContact;
      if (!contact) return;
      const email = contact.email.trim().toLowerCase();
      const collapsed = collapsePersonInboxThreads(filterEmailInboxThreads(rows, { keepSmsLike: !smsUiEnabled }), {
        mergeFolders: true,
      });
      const thread = collapsed.find((row) => row.email.trim().toLowerCase() === email);
      if (!thread) return;
      const key = unifiedInboxKey("email", thread.id);
      setSelectedKey(key);
      setMobileThreadOpen(true);
      onRouteThreadChange?.(thread.id);
      selectCommunicationThreadUrl(threadDetailHref(thread.id), { replaceExisting: true });
    });
    if (smsUiEnabled) {
      void fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) return;
          const body = (await res.json()) as { residents?: ManagerSmsResidentConversation[] };
          setSmsResidents(normalizeManagerSmsConversationsPayload(body).residents);
        })
        .catch(() => {
          /* keep */
        });
    }
  }, [onRouteThreadChange, placeholderContact, smsUiEnabled, threadDetailHref]);

  const threadOpen = Boolean(selection);

  useEffect(() => {
    onThreadOpenChange?.(threadOpen);
  }, [onThreadOpenChange, threadOpen]);

  useEffect(() => {
    onThreadSelectedChange?.(Boolean(selection));
  }, [onThreadSelectedChange, selection]);

  useEffect(() => {
    setMobileThreadOpen(Boolean(routeThreadId));
  }, [routeThreadId]);

  useEffect(() => {
    if (!isClient || !routeThreadId) return;
    const match = listRows.find((r) => r.threadId === routeThreadId);
    if (match) {
      setSelectedKey(match.key);
      setMobileThreadOpen(true);
    }
  }, [isClient, listRows, routeThreadId]);

  // Toggling the segment is a different result set — clear search; return to list on phones.
  useEffect(() => {
    setQuery("");
    if (!routeThreadId) {
      setMobileThreadOpen(false);
      if (!inboxUsesDesktopSplit()) {
        setSelectedKey(null);
      }
    }
  }, [listSegment, routeThreadId]);

  useEffect(() => {
    if (!isClient) return;
    if (listRows.length === 0) {
      // A deep-linked / just-created thread may land before its SMS row is in
      // the merged list. Keep the pending route alive until the row arrives.
      if (!routeThreadId) {
        setSelectedKey(null);
        setMobileThreadOpen(false);
      }
      return;
    }
    setSelectedKey((cur) => {
      if (routeThreadId) {
        const routed = listRows.find((r) => r.threadId === routeThreadId);
        if (routed) return routed.key;
        // Do not fall through to the first desktop row while the routed thread
        // is still missing — that is the contact-create race.
        if (cur && listRows.some((r) => r.key === cur)) {
          const current = parseUnifiedInboxKey(cur);
          if (current?.threadId === routeThreadId) return cur;
        }
        return null;
      }
      if (cur && listRows.some((r) => r.key === cur)) return cur;
      if (inboxUsesDesktopSplit()) return listRows[0]!.key;
      return null;
    });
  }, [isClient, listRows, routeThreadId]);

  const listPane = (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {listChrome === "internal" ? (
        <div className={PORTAL_INBOX_LIST_TOOLBAR_CLASS}>
          <DestinationNav
            items={[
              { id: "active", label: "Active", href: `${commBase}/active`, dataAttr: "communication-segment-active" },
              {
                id: "archived",
                label: "Archived",
                href: `${commBase}/archived`,
                dataAttr: "communication-segment-archived",
              },
            ]}
            activeId={listSegment}
            ariaLabel="Conversation folders"
            size="toolbar"
            className="mb-2 gap-0.5 rounded-xl border-0 bg-transparent p-0"
          />
          <div className="relative min-w-0">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search contacts or messages"
              className="portal-inbox-search h-9 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
              data-attr="unified-inbox-search"
            />
          </div>
          {listRows.length > 0 ? (
            <p className="hidden px-1 text-[11px] text-muted sm:block">
              {listRows.length} conversation{listRows.length === 1 ? "" : "s"}
              {query.trim() ? ` matching “${query.trim()}”` : ""}
            </p>
          ) : null}
        </div>
      ) : listRows.length > 0 && query.trim() ? (
        <p className="mb-2 hidden px-1 text-[11px] text-muted sm:block">
          {listRows.length} conversation{listRows.length === 1 ? "" : "s"} matching “{query.trim()}”
        </p>
      ) : null}
      <div className={`${INBOX_LIST_SCROLL} min-h-0 flex-1`} data-communication-inbox-list>
        {!isClient ? (
          <div className="min-h-[12rem]" aria-hidden />
        ) : listRows.length === 0 ? (
          query.trim() ? (
            <div className="p-4">
              <PortalInboxEmptyState title={`No messages match “${query.trim()}”.`} />
            </div>
          ) : listSegment === "archived" ? (
            <div className="p-4">
              <PortalInboxEmptyState title="No archived conversations." />
            </div>
          ) : listSegment === "unread" ? (
            <div className="p-4">
              <PortalInboxEmptyState title="No unread conversations." />
            </div>
          ) : onAddConversation ? (
            <InboxConversationListAddRow onClick={onAddConversation} />
          ) : null
        ) : (
          listRows.map((row) => (
            <InboxConversationRow
              key={row.key}
              leading={
                <CommunicationInboxRowCheckbox
                  checked={bulk.selection.selectedIds.has(row.key)}
                  onToggle={() => bulk.selection.toggleSelected(row.key)}
                  label={`Select conversation with ${row.name}`}
                />
              }
              name={row.name}
              subtitle={row.subtitle}
              preview={row.preview}
              previewPrefix={row.previewPrefix}
              time={row.time}
              unread={row.unread}
              selected={selectedKey === row.key}
              onOpen={() => {
                setSelectedKey(row.key);
                setMobileThreadOpen(true);
                onRouteThreadChange?.(row.threadId);
                const href = threadDetailHref(row.threadId);
                if (routeThreadId !== row.threadId) {
                  selectCommunicationThreadUrl(href, { replaceExisting: Boolean(routeThreadId) });
                }
              }}
            />
          ))
        )}
      </div>
      <CommunicationListBulkBar
        count={bulk.selectedCount}
        listSegment={listSegment}
        onArchive={listSegment !== "archived" ? () => void bulk.handleArchive() : undefined}
        onRestore={listSegment === "archived" ? () => void bulk.handleRestore() : undefined}
        onDelete={listSegment === "archived" ? () => void bulk.handleDelete() : undefined}
        onEdit={bulk.canEditContact ? bulk.openEdit : undefined}
        showEdit={bulk.canEditContact}
      />
    </div>
  );

  const directChatEmail = placeholderContact?.email ?? mergedPersonEmail;
  const threadPane = directChatEmail ? (
    <ResidentDirectChatPane
      residentEmail={directChatEmail}
      residentName={placeholderContact?.name ?? selectedRow?.name}
      smsResident={
        smsResidents.find(
          (resident) =>
            resident.residentEmail?.trim().toLowerCase() === directChatEmail.trim().toLowerCase(),
        ) ?? null
      }
      smsUiEnabled={smsUiEnabled}
      onSent={refreshAfterDirectSend}
    />
  ) : selection?.channel === "email" ? (
      <ManagerInbox
        ref={inboxRef}
        tabId={tabId}
        embeddedInCommunication
        externalTitleActions
        suppressCompose
        suppressListPane
        commBase={commBase}
        threadFilters={threadFilters}
        filterContacts={filterContacts}
        smsUiEnabled={smsUiEnabled}
        smsRecipients={smsResidents}
        controlledExpandedId={selection.threadId}
        onControlledExpandedIdChange={(id) => {
          if (!id) {
            setSelectedKey(null);
            setMobileThreadOpen(false);
            onRouteThreadChange?.(undefined);
            clearCommunicationThreadUrl(threadListHref());
            return;
          }
          setSelectedKey(unifiedInboxKey("email", id));
          setMobileThreadOpen(true);
          onRouteThreadChange?.(id);
          const href = threadDetailHref(id);
          if (routeThreadId !== id) {
            selectCommunicationThreadUrl(href, { replaceExisting: Boolean(routeThreadId) });
          }
        }}
      />
    ) : selection?.channel === "sms" ? (
      <ManagerSmsPanel
        ref={smsRef}
        threadFilters={threadFilters}
        filterContacts={filterContacts}
        allowInlineCompose={false}
        suppressListPane
        controlledActiveId={selection.threadId}
        onControlledActiveIdChange={(id) => {
          if (!id) {
            setSelectedKey(null);
            setMobileThreadOpen(false);
            onRouteThreadChange?.(undefined);
            clearCommunicationThreadUrl(threadListHref());
          }
        }}
        onUnreadCountChange={onSmsUnreadCountChange}
        onConversationOpened={handleSmsConversationOpened}
        listSegment={listSegment}
        onArchived={() => {
          setSmsArchivedIds(loadManagerSmsArchivedIds());
          setSelectedKey(null);
          setMobileThreadOpen(false);
          onRouteThreadChange?.(undefined);
          clearCommunicationThreadUrl(threadListHref());
        }}
      />
    ) : (
      <InboxThreadEmpty
        title="Select a conversation"
        hint="Choose a resident on the left to read and reply."
      />
    );

  return (
    <>
      <InboxTwoPane
        heightMode="viewport"
        fillViewport={threadOpen}
        fillParent
        mobileCompact
        className="min-h-0 flex-1 max-md:rounded-xl max-md:shadow-[var(--shadow-sm)]"
        threadOpen={threadOpen}
        list={listPane}
        thread={threadPane}
      />
      <PortalContactDetailsModal
        open={bulk.editOpen}
        onClose={() => bulk.setEditOpen(false)}
        initial={bulk.editInitial}
        onSave={(values) => {
          void bulk.saveEdit(values, "manager").then(() => {
            dispatchManagerSmsContactsChanged();
          });
        }}
        saving={bulk.editSaving}
        error={bulk.editError}
        formId="manager-unified-inbox-contact-edit"
      />
    </>
  );
}
