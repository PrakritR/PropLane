"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerPortalPageShell, ManagerPortalStatusPills, ManagerPortalFilterRow, PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { ScopedInboxComposeModal, type ScopedInboxSendPayload } from "@/components/portal/inbox-scoped-compose-modal";
import {
  buildInboxThreadAssistantContext,
  InboxThreadAssistantStrip,
} from "@/components/portal/inbox-thread-assistant-strip";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { useInboxAiDraftAutoSend } from "@/hooks/use-inbox-ai-draft-auto-send";
import { useManagerCommunicationDeliverVia } from "@/hooks/use-manager-communication-deliver-via";
import { appendPortalMessageToAdminInbox } from "@/lib/demo-admin-partner-inbox";
import {
  MANAGER_INBOX_STORAGE_KEY,
  PORTAL_INBOX_CHANGED_EVENT,
  deleteInboxThreadIds,
  invalidatePersistedInboxCache,
  loadPersistedInbox,
  persistInbox,
  persistInboxAwait,
  runInboxMutation,
  stagePersistedInboxRows,
  syncPersistedInboxFromServer,
  upsertPersistedInboxRows,
  inboxThreadMessages,
  inboxThreadSortMs,
  appendReplyToInboxThread,
  collapsePersonInboxThreads,
  inboxThreadManagerReplyPending,
  resolveCollapsedInboxThread,
  inboxThreadCounterpartyEmail,
  formatInboxStamp,
  type InboxAiDraft,
  type InboxThreadMessage,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { buildOptimisticSentThread, markThreadMessageDelivery } from "@/lib/inbox-message-timeline";
import {
  INBOX_MAX_ATTACHMENTS,
  attachmentMetaFromUrls,
  createPendingInboxAttachment,
  revokeInboxAttachmentPreview,
  uploadInboxAttachment,
  type InboxComposerAttachment,
} from "@/lib/inbox-attachments";
import {
  INBOX_TAB_DEFS,
  INBOX_LIST_SCROLL,
  AiDraftReplyCard,
  InboxComposer,
  InboxReplyChannelPicker,
  InboxConversationRow,
  InboxScheduledCard,
  InboxScheduledThreadList,
  InboxThreadEmpty,
  InboxThreadView,
  PORTAL_INBOX_LIST_TOOLBAR_CLASS,
  InboxTwoPane,
  PortalInboxEmptyState,
  inboxTabEmptyCopy,
  type InboxBubbleMessage,
} from "./portal-inbox-ui";
import {
  useInboxRowSelection,
  sendManualScheduledMessageNow,
  sendAutomationScheduledMessageNow,
} from "@/components/portal/portal-inbox-selection";
import { ManagerInboxSchedulePanel } from "@/components/portal/manager-inbox-schedule-panel";
import {
  patchScheduledMessage,
  useScheduledPaymentMessages,
} from "@/components/portal/payment-schedule-ui";
import { scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import { readPortalApiError } from "@/lib/portal-api-error";
import { MANAGER_APPLICATIONS_EVENT } from "@/lib/manager-applications-storage";
import {
  inboxThreadHasEmail,
  resolveManagerInboxReplyChannels,
  resolveManagerInboxSmsTarget,
} from "@/lib/manager-inbox-reply-channels";
import { buildManagerInboxLiveContacts } from "@/lib/manager-inbox-contacts";
import {
  isUpcomingScheduledInboxMessage,
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import {
  threadPassesCommunicationFilters,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import {
  InboxSendRefusal,
  inboxReplySentToastMessage,
} from "@/lib/inbox-reply-outcome";
import {
  MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE,
  MANUAL_SMS_UNKNOWN_MESSAGE,
  isManualSmsOutcomeUnknown,
  resolveManualSmsAttempt,
  type ManualSmsAttempt,
} from "@/lib/sms/manual-send-attempt";

type InboxThread = {
  id: string;
  folder: "inbox" | "sent" | "trash";
  previousFolder?: "inbox" | "sent";
  from: string;
  email: string;
  subject: string;
  preview: string;
  body: string;
  time: string;
  unread: boolean;
  messages?: InboxThreadMessage[];
  aiDraft?: InboxAiDraft;
};

function threadEligibleForAiDraft(thread: InboxThread): boolean {
  return inboxThreadManagerReplyPending(thread);
}

/** Search deliberately skips the trash folder; say so rather than letting a
 *  manager conclude a trashed message no longer exists. Re-clicking the pill of
 *  the tab you are already on does not change `tabId`, so "open the Trash tab"
 *  is not a way out when Trash is already the active tab — name the step that
 *  actually applies from where the reader is standing. */
function searchSkipsTrashNote(tabId: string) {
  return tabId === "trash"
    ? "Trash isn’t searched; clear the search to browse it."
    : "Trash isn’t searched; clear the search, then open the Trash tab.";
}

function previewLine(body: string, max = 100) {
  const t = body.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

function countThreads(threads: InboxThread[], scheduleCount: number) {
  return {
    unopened: threads.filter((t) => t.folder === "inbox" && t.unread).length,
    opened: threads.filter((t) => t.folder === "inbox" && !t.unread).length,
    schedule: scheduleCount,
    sent: threads.filter((t) => t.folder === "sent").length,
    trash: threads.filter((t) => t.folder === "trash").length,
  };
}

export type ManagerInboxHandle = {
  openCompose: () => void;
  deleteAllTrash: () => void;
  reloadInbox: () => void;
  reloadInboxAsync: () => Promise<InboxThread[]>;
  findThreadForRecipient: (email: string) => string | null;
  stageOptimisticSentThread: (thread: PersistedInboxThread) => void;
  clearPendingSend: (threadId: string) => void;
};

export const ManagerInbox = forwardRef<
  ManagerInboxHandle,
  {
    tabId: string;
    embeddedInCommunication?: boolean;
    commBase?: string;
    externalTitleActions?: boolean;
    /** When true, Communication shell owns New message — do not render compose here. */
    suppressCompose?: boolean;
    threadFilters?: CommunicationThreadFilters;
    filterContacts?: InboxScopedContact[];
    onTabCountsChange?: (counts: ReturnType<typeof countThreads>) => void;
    /** When true, only the open thread pane is rendered (unified Communication list lives elsewhere). */
    suppressListPane?: boolean;
    /** Controlled selection for unified Communication. */
    controlledExpandedId?: string | null;
    onControlledExpandedIdChange?: (id: string | null) => void;
    smsUiEnabled?: boolean;
    smsRecipients?: ManagerSmsResidentConversation[];
    /** Let the portal page scroll the thread instead of a nested pane (resident profile). */
    pageScroll?: boolean;
    /** Scope threads to one resident email (Residents detail Communication tab). */
    filterResidentEmail?: string;
    /** Rendered when suppressListPane is set and no thread matches filterResidentEmail. */
    emptyThreadFallback?: React.ReactNode;
    /** Resident profile Communication — opens compose modal. */
    onNewMessage?: () => void;
    /** Bumps when a parent modal schedules/cancels for the filtered resident. */
    scheduledRefreshKey?: number;
  }
>(function ManagerInbox(
  {
    tabId,
    embeddedInCommunication = false,
    commBase,
    externalTitleActions = false,
    suppressCompose = false,
    threadFilters,
    filterContacts,
    onTabCountsChange,
    suppressListPane = false,
    controlledExpandedId,
    onControlledExpandedIdChange,
    smsUiEnabled = false,
    pageScroll = false,
    smsRecipients = [],
    filterResidentEmail,
    emptyThreadFallback,
    onNewMessage,
    scheduledRefreshKey = 0,
  },
  ref,
) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const portalBase = usePaidPortalBasePath();
  const inboxBase = embeddedInCommunication && commBase ? `${commBase}/inbox` : `${portalBase}/inbox`;
  const { messages: scheduledMessages, reload: reloadAutomationScheduled } = useScheduledPaymentMessages({
    includeHidden: false,
  });
  const [manualScheduledMessages, setManualScheduledMessages] = useState<ScheduledInboxMessageRecord[]>([]);

  const reloadManualScheduled = useCallback(async () => {
    if (isDemoModeActive()) return;
    const res = await fetch("/api/portal/scheduled-inbox-messages", { credentials: "include", cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
    setManualScheduledMessages(Array.isArray(body.messages) ? body.messages : []);
  }, []);

  useEffect(() => {
    void reloadManualScheduled();
  }, [reloadManualScheduled]);

  const scheduleCount = useMemo(() => {
    const upcoming = (status: string, sendAt: string) =>
      status === "scheduled" && isUpcomingScheduledInboxMessage(sendAt, status);
    return (
      manualScheduledMessages.filter((m) => upcoming(m.status, m.sendAt)).length +
      scheduledMessages.filter((m) => upcoming(m.status, m.sendAt)).length
    );
  }, [manualScheduledMessages, scheduledMessages]);
  const { userId } = useManagerUserId();
  const [smsCanSend, setSmsCanSend] = useState(false);
  /** Work-number replies stay live when canSend even if the global SMS comm UI flag is off. */
  const smsOutboundEnabled = smsUiEnabled || smsCanSend;

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/manager/messaging-number", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        setSmsCanSend((body as { canSend?: boolean }).canSend === true);
      })
      .catch(() => {
        if (!cancelled) setSmsCanSend(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [local, setLocal] = useState<InboxThread[]>(() => loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []) as InboxThread[]);
  const localRef = useRef(local);
  const replySmsAttemptRef = useRef<ManualSmsAttempt | null>(null);
  useEffect(() => {
    localRef.current = local;
  }, [local]);
  const [pendingSendingThreadIds, setPendingSendingThreadIds] = useState<Set<string>>(() => new Set());
  const [inboxSynced, setInboxSynced] = useState(false);
  const persistInboxRef = useRef(true);
  const [internalExpandedId, setInternalExpandedId] = useState<string | null>(null);
  const expandedId = controlledExpandedId !== undefined ? controlledExpandedId : internalExpandedId;
  const setExpandedId = useCallback(
    (id: string | null | ((prev: string | null) => string | null)) => {
      const resolve = (prev: string | null) => (typeof id === "function" ? id(prev) : id);
      if (controlledExpandedId !== undefined) {
        onControlledExpandedIdChange?.(resolve(controlledExpandedId));
      } else {
        setInternalExpandedId(resolve);
      }
    },
    [controlledExpandedId, onControlledExpandedIdChange],
  );
  const [composeOpen, setComposeOpen] = useState(false);
  const [contactTick, setContactTick] = useState(0);
  const [query, setQuery] = useState("");
  // Threads marked read while viewing "Unopened" stay listed until the tab is
  // switched or the page is refreshed; they only move to "Opened" on reset.
  const [retainedIds, setRetainedIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    persistInboxRef.current = false;
    void syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY).then((rows) => {
      setLocal(rows as InboxThread[]);
      setInboxSynced(true);
      persistInboxRef.current = true;
    });
  }, []);

  useEffect(() => {
    const bump = () => setContactTick((n) => n + 1);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, bump);
    window.addEventListener("axis-pro-relationships", bump);
    window.addEventListener("axis:manager-vendors", bump);
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, bump);
      window.removeEventListener("axis-pro-relationships", bump);
      window.removeEventListener("axis:manager-vendors", bump);
    };
  }, []);

  const liveContacts = useMemo((): InboxScopedContact[] => {
    void contactTick;
    return buildManagerInboxLiveContacts(userId);
  }, [userId, contactTick]);

  useEffect(() => {
    const sync = (evt?: Event) => {
      if (evt && evt.type === PORTAL_INBOX_CHANGED_EVENT) {
        const ce = evt as CustomEvent<{ key?: string }>;
        if (ce.detail?.key && ce.detail.key !== MANAGER_INBOX_STORAGE_KEY) return;
      }
      setLocal(loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []) as InboxThread[]);
    };
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => {
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!inboxSynced || !persistInboxRef.current) return;
    persistInbox(MANAGER_INBOX_STORAGE_KEY, local);
  }, [local, inboxSynced]);

  const residentEmailNorm = filterResidentEmail?.trim().toLowerCase() ?? "";
  const embeddedResidentChat = Boolean(residentEmailNorm);

  const emailThreads = useMemo(() => {
    const base = embeddedInCommunication ? filterEmailInboxThreads(local) : local;
    const scoped =
      !threadFilters || !filterContacts
        ? base
        : base.filter((t) =>
            threadPassesCommunicationFilters({
              filters: threadFilters,
              contacts: filterContacts,
              counterpartyEmail: t.email,
            }),
          );
    const residentScoped = residentEmailNorm
      ? scoped.filter((t) => t.email.trim().toLowerCase() === residentEmailNorm)
      : scoped;
    return collapsePersonInboxThreads(residentScoped, { mergeFolders: embeddedInCommunication });
  }, [embeddedInCommunication, local, threadFilters, filterContacts, residentEmailNorm]);

  const counts = useMemo(() => countThreads(emailThreads, scheduleCount), [emailThreads, scheduleCount]);
  const tabs = useMemo(
    () => [
      ...INBOX_TAB_DEFS.map(({ id, label }) => ({ id, label, count: counts[id as keyof typeof counts] })),
    ],
    [counts],
  );

  useEffect(() => {
    if (embeddedInCommunication) onTabCountsChange?.(counts);
  }, [counts, embeddedInCommunication, onTabCountsChange]);

  // Resident-scoped chat (Residents → detail → Communication) has no list pane to
  // pick from, so this effect IS the selection: it opens the newest conversation
  // that belongs to the active view. `tabId` is the archived toggle here —
  // "trash" is the archived view and must select an ARCHIVED thread, every other
  // tab a live one; selecting across the two would show a live conversation under
  // "Archived". The tab-change reset below must not run in this mode or it
  // clobbers this in the same commit — see the comment there.
  useEffect(() => {
    if (!residentEmailNorm || controlledExpandedId !== undefined) return;
    const candidates = emailThreads.filter((t) =>
      tabId === "trash" ? t.folder === "trash" : t.folder !== "trash",
    );
    if (candidates.length === 0) {
      setInternalExpandedId(null);
      return;
    }
    const best = [...candidates].sort((a, b) => threadTimestamp(b) - threadTimestamp(a))[0];
    if (best) setInternalExpandedId(best.id);
  }, [residentEmailNorm, emailThreads, controlledExpandedId, tabId]);

  function threadTimestamp(t: InboxThread): number {
    return inboxThreadSortMs(t.id, t.time);
  }

  /**
   * Relevance score for message search: sender name/email matches rank above
   * subject matches, which rank above body matches. 0 = no match.
   */
  function searchScore(t: InboxThread, q: string): number {
    const has = (s: string | undefined) => Boolean(s && s.toLowerCase().includes(q));
    if (has(t.from) || has(t.email)) return 3;
    if (has(t.subject)) return 2;
    if (has(t.body) || has(t.preview)) return 1;
    return 0;
  }

  const searchQuery = query.trim().toLowerCase();
  const searchActive = searchQuery.length > 0;

  const rowsForTab = useMemo(() => {
    // Search mode: match across every folder except trash (a resident's or
    // applicant's messages regardless of read state), best matches first,
    // newest first within the same relevance.
    if (searchActive) {
      return emailThreads
        .filter((t) => t.folder !== "trash")
        .map((t) => ({ t, score: searchScore(t, searchQuery) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || threadTimestamp(b.t) - threadTimestamp(a.t))
        .map((x) => x.t);
    }

    let filtered: InboxThread[];
    if (tabId === "unopened")
      filtered = emailThreads.filter((t) => t.folder === "inbox" && (t.unread || retainedIds.has(t.id)));
    else if (tabId === "opened") filtered = emailThreads.filter((t) => t.folder === "inbox" && !t.unread);
    else if (tabId === "sent") filtered = emailThreads.filter((t) => t.folder === "sent");
    else if (tabId === "trash") filtered = emailThreads.filter((t) => t.folder === "trash");
    else filtered = [];

    return [...filtered].sort((a, b) => threadTimestamp(b) - threadTimestamp(a));
  }, [emailThreads, tabId, retainedIds, searchActive, searchQuery]);

  // Returning to Unopened (or refreshing) shows the true unread set. Search
  // spans folders and overrides the tab, so picking a tab also ends the search
  // rather than leaving the pill highlighted over an unchanged result list.
  useEffect(() => {
    setRetainedIds(new Set());
    setQuery("");
    // Switching folders closes the open thread — its row no longer belongs to
    // the visible list, so keeping it selected would strand the right pane.
    // In CONTROLLED mode (unified Communication), the parent owns selection and
    // already clears it on tab change; clearing here would ALSO fire on mount —
    // when the parent has just selected a thread and mounted this pane — and
    // immediately wipe that selection back to "Select a conversation".
    // In RESIDENT-SCOPED mode the auto-select effect above owns selection and has
    // already picked the right thread for the new tab in THIS commit; this effect
    // is declared later so its `null` would win and nothing would ever open
    // (clicking "Archived (1)" landed on a blank pane). There is no list to strand
    // in that mode either — the pane is the whole surface.
    if (controlledExpandedId === undefined && !embeddedResidentChat) setExpandedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const threadRowIds = useMemo(() => rowsForTab.map((t) => t.id), [rowsForTab]);
  const threadSelection = useInboxRowSelection(threadRowIds);

  // Mark an unread inbox thread read without a toast — used when a thread is
  // opened in the two-pane view (kept listed under Unopened until refresh via
  // `retainedIds`, matching the explicit "Mark read" behaviour).
  const markReadSilent = (id: string) => {
    setLocal((prev) => prev.map((t) => (t.id === id && t.folder === "inbox" ? { ...t, unread: false } : t)));
    setRetainedIds((prev) => new Set(prev).add(id));
  };

  const markRead = (id: string) => {
    markReadSilent(id);
    showToast("Marked as read. Moves to Opened after refresh.");
  };

  const isUnreadInboxThread = (id: string) => {
    const thread = local.find((t) => t.id === id);
    return Boolean(thread && thread.folder === "inbox" && thread.unread);
  };

  const moveToTrash = (id: string) => {
    void runInboxMutation(async () => {
      persistInboxRef.current = false;
      try {
        const prev = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []) as InboxThread[];
        const target = prev.find((t) => t.id === id);
        if (!target || target.folder === "trash" || (target.folder !== "inbox" && target.folder !== "sent")) return;
        const updated: InboxThread = {
          ...target,
          folder: "trash",
          previousFolder: target.folder,
          unread: false,
        };
        const next = prev.map((t) => (t.id === id ? updated : t));
        stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, next);
        setLocal(next);
        setExpandedId((e) => (e === id ? null : e));
        const ok = await upsertPersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, [updated], next);
        if (!ok) {
          stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, prev);
          setLocal(prev);
          showToast("Could not move message to trash.");
          return;
        }
        showToast("Moved to trash.");
      } finally {
        persistInboxRef.current = true;
      }
    });
  };

  function inferPreviousFolder(t: InboxThread): "inbox" | "sent" {
    if (t.previousFolder) return t.previousFolder;
    if (/^(sent_|msg_|welcome_)/.test(t.id)) return "sent";
    return "inbox";
  }

  const restoreFromTrash = (id: string) => {
    void runInboxMutation(async () => {
      persistInboxRef.current = false;
      try {
        const prev = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []) as InboxThread[];
        const target = prev.find((t) => t.id === id && t.folder === "trash");
        if (!target) return;
        const dest = inferPreviousFolder(target);
        const updated: InboxThread = { ...target, folder: dest, previousFolder: undefined, unread: false };
        const next = prev.map((t) => (t.id === id ? updated : t));
        stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, next);
        setLocal(next);
        setExpandedId((e) => (e === id ? null : e));
        const ok = await upsertPersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, [updated], next);
        if (!ok) {
          stagePersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, prev);
          setLocal(prev);
          showToast("Could not restore message.");
          return;
        }
        showToast("Restored.");
      } finally {
        persistInboxRef.current = true;
      }
    });
  };

  const deleteForever = (id: string) => {
    void (async () => {
      invalidatePersistedInboxCache(MANAGER_INBOX_STORAGE_KEY);
      const ok = await deleteInboxThreadIds([id]);
      if (!ok) {
        showToast("Could not delete message.");
        return;
      }
      const next = local.filter((t) => t.id !== id);
      persistInboxRef.current = false;
      setLocal(next);
      setExpandedId((e) => (e === id ? null : e));
      await persistInboxAwait(MANAGER_INBOX_STORAGE_KEY, next);
      const deletedIds = new Set([id]);
      const synced = await syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true, excludeIds: deletedIds });
      setLocal((synced as InboxThread[]).filter((t) => !deletedIds.has(t.id)));
      persistInboxRef.current = true;
      showToast("Message deleted.");
    })();
  };

  const deleteAllTrash = useCallback(() => {
    const trashItems = local.filter((t) => t.folder === "trash");
    if (trashItems.length === 0) {
      showToast("Trash is already empty.");
      return;
    }
    if (!window.confirm(`Delete all ${trashItems.length} trash message${trashItems.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
    void (async () => {
      invalidatePersistedInboxCache(MANAGER_INBOX_STORAGE_KEY);
      const ids = trashItems.map((item) => item.id).filter(Boolean);
      if (ids.length === 0) return;
      const ok = await deleteInboxThreadIds(ids);
      if (!ok) {
        showToast("Could not clear trash.");
        return;
      }
      const next = local.filter((t) => t.folder !== "trash");
      persistInboxRef.current = false;
      setLocal(next);
      setExpandedId(null);
      await persistInboxAwait(MANAGER_INBOX_STORAGE_KEY, next);
      const deletedIds = new Set(ids);
      const synced = await syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true, excludeIds: deletedIds });
      setLocal((synced as InboxThread[]).filter((t) => !deletedIds.has(t.id)));
      persistInboxRef.current = true;
      showToast("Trash cleared.");
    })().catch(() => showToast("Could not clear trash."));
  }, [local, showToast]);

  const reloadInbox = useCallback(() => {
    invalidatePersistedInboxCache(MANAGER_INBOX_STORAGE_KEY);
    void syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true }).then((rows) => {
      setLocal(rows as InboxThread[]);
    });
  }, []);

  const reloadInboxAsync = useCallback(async () => {
    invalidatePersistedInboxCache(MANAGER_INBOX_STORAGE_KEY);
    const rows = await syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, { force: true });
    setLocal(rows as InboxThread[]);
    return rows as InboxThread[];
  }, []);

  const findThreadForRecipient = useCallback((email: string) => {
    const norm = email.trim().toLowerCase();
    const collapsed = collapsePersonInboxThreads(localRef.current, { mergeFolders: true });
    return collapsed.find((t) => inboxThreadCounterpartyEmail(t) === norm)?.id ?? null;
  }, []);

  const stageOptimisticSentThread = useCallback((thread: PersistedInboxThread) => {
    setPendingSendingThreadIds((prev) => new Set(prev).add(thread.id));
    const next = [thread as InboxThread, ...localRef.current];
    persistInboxRef.current = false;
    setLocal(next);
    setExpandedId(thread.id);
  }, [setExpandedId]);

  const clearPendingSend = useCallback((threadId: string) => {
    setPendingSendingThreadIds((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      openCompose: () => {
        if (!suppressCompose) setComposeOpen(true);
      },
      deleteAllTrash,
      reloadInbox,
      reloadInboxAsync,
      findThreadForRecipient,
      stageOptimisticSentThread,
      clearPendingSend,
    }),
    [
      clearPendingSend,
      deleteAllTrash,
      findThreadForRecipient,
      reloadInbox,
      reloadInboxAsync,
      stageOptimisticSentThread,
      suppressCompose,
    ],
  );

  const handleReply = useCallback(
    async (
      rowId: string,
      text: string,
      channels: { email: boolean; sms: boolean },
      attachmentUrls: string[] = [],
    ) => {
      const thread = localRef.current.find((t) => t.id === rowId);
      if (!thread) return;
      const emailAllowed = channels.email && inboxThreadHasEmail(thread.email);
      const smsAllowed =
        channels.sms &&
        Boolean(resolveManagerInboxSmsTarget(thread, smsRecipients, smsOutboundEnabled)?.phone?.trim());
      if (!emailAllowed && !smsAllowed) {
        throw new InboxSendRefusal(
          channels.email && !inboxThreadHasEmail(thread.email)
            ? "This conversation has no email address. Send via SMS instead."
            : null,
        );
      }

      const replyId = `reply-${Date.now().toString(36)}`;
      const attachmentMeta = attachmentMetaFromUrls(attachmentUrls);
      const reply: InboxThreadMessage = {
        id: replyId,
        from: "Property manager",
        body: text,
        at: formatInboxStamp(new Date()),
        outbound: true,
        delivery: "sending",
        attachments: attachmentMeta.length ? attachmentMeta : undefined,
      };
      persistInboxRef.current = false;
      setLocal((current) =>
        current.map((row) =>
          row.id === thread.id
            ? { ...appendReplyToInboxThread(row, reply), aiDraft: undefined }
            : row,
        ),
      );

      const rollbackReply = () => {
        setLocal((current) =>
          current.map((row) => {
            if (row.id !== thread.id) return row;
            const messages = (row.messages ?? []).filter(
              (message) => message.id !== replyId,
            );
            if (messages.length === (thread.messages ?? []).length) {
              return {
                ...row,
                messages,
                preview: thread.preview,
                time: thread.time,
                unread: thread.unread,
                aiDraft: thread.aiDraft,
              };
            }
            const last = messages[messages.length - 1];
            return {
              ...row,
              messages,
              preview: last
                ? last.body.slice(0, 100).replace(/\n/g, " ")
                : thread.preview,
              time: last?.at ?? thread.time,
            };
          }),
        );
      };

      const subject = thread.subject.startsWith("Re:")
        ? thread.subject
        : `Re: ${thread.subject}`;
      let emailOk = false;
      let smsOk = false;
      let smsUnknown = false;
      let failureMessage = "";
      try {
        if (emailAllowed) {
          try {
            const res = await fetch("/api/portal/send-inbox-message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                threadId: thread.id,
                fromName: "Property manager",
                subject,
                text,
                toEmails: [thread.email],
                deliverToPortalInbox: true,
                senderPortal: "manager",
                attachmentUrls: attachmentUrls.length
                  ? attachmentUrls
                  : undefined,
              }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
            };
            emailOk = res.ok && data.ok === true;
            if (!emailOk) failureMessage = data.error?.trim() ?? "";
          } catch {
            failureMessage = "";
          }
        }

        if (smsAllowed) {
          const smsTarget = resolveManagerInboxSmsTarget(
            thread,
            smsRecipients,
            smsOutboundEnabled,
          );
          if (!smsTarget?.phone?.trim()) {
            failureMessage ||= "No phone is available for this conversation.";
          } else {
            const attemptSignature = JSON.stringify([
              thread.id,
              smsTarget.phone.trim(),
              smsTarget.residentUserId ?? null,
              smsTarget.conversationKey ?? null,
              text,
            ]);
            const attempt = resolveManualSmsAttempt(
              replySmsAttemptRef.current,
              attemptSignature,
              1,
            );
            replySmsAttemptRef.current = attempt;
            try {
              const res = await fetch("/api/manager/sms-conversations", {
                method: "POST",
                credentials: "include",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": attempt.idempotencyKeys[0]!,
                },
                body: JSON.stringify({
                  toPhone: smsTarget.phone.trim(),
                  text,
                  residentUserId: smsTarget.residentUserId ?? undefined,
                  conversationKey: smsTarget.conversationKey ?? null,
                }),
              });
              const data = (await res.json().catch(() => ({}))) as {
                error?: string;
                code?: string;
                status?: string;
              };
              smsOk = res.ok;
              smsUnknown = !smsOk && isManualSmsOutcomeUnknown(data);
              if (smsOk) {
                replySmsAttemptRef.current = null;
              } else if (smsUnknown) {
                failureMessage = MANUAL_SMS_UNKNOWN_MESSAGE;
              } else {
                failureMessage = data.error?.trim() || failureMessage;
              }
            } catch {
              smsUnknown = true;
              failureMessage = MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE;
            }
          }
        }

        if (!emailOk && !smsOk) {
          rollbackReply();
          throw new InboxSendRefusal(failureMessage || null);
        }

        const currentRows = localRef.current;
        const currentThread = currentRows.find((row) => row.id === thread.id);
        if (currentThread) {
          const withReply = (currentThread.messages ?? []).some(
            (message) => message.id === replyId,
          )
            ? currentThread
            : appendReplyToInboxThread(currentThread, reply);
          const delivered = {
            ...markThreadMessageDelivery(withReply, replyId, undefined),
            aiDraft: undefined,
          };
          const persisted = currentRows.map((row) =>
            row.id === thread.id ? delivered : row,
          );
          setLocal(persisted);
          await upsertPersistedInboxRows(
            MANAGER_INBOX_STORAGE_KEY,
            [delivered],
            persisted,
          ).catch(() => false);
        }
      } finally {
        persistInboxRef.current = true;
      }
      void syncPersistedInboxFromServer(MANAGER_INBOX_STORAGE_KEY, {
        force: true,
      }).catch(() => {});
      return {
        emailRequested: emailAllowed,
        smsRequested: smsAllowed,
        emailOk,
        smsOk,
        smsUnknown,
      };
    },
    [smsRecipients, smsOutboundEnabled],
  );

  const handleComposeSend = useCallback(
    (p: ScopedInboxSendPayload) => {
      if (p.includesAxisAdmin && isDemoModeActive()) {
        appendPortalMessageToAdminInbox({
          role: "manager",
          name: p.senderName,
          email: p.senderEmail,
          topic: p.subject.trim(),
          body: p.body.trim(),
        });
      }
      setComposeOpen(false);

      void (async () => {
        try {
          if (p.scheduleLater && p.sendAt) {
            const directEmails = p.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean);
            const schedulePayloads: Record<string, unknown>[] = [];
            for (const category of p.broadcastCategories) {
              schedulePayloads.push({
                subject: p.subject.trim(),
                body: p.body.trim(),
                sendAt: p.sendAt,
                broadcastCategories: [category],
                deliverViaEmail: p.deliverViaEmail !== false,
                deliverViaSms: p.deliverViaSms === true,
                senderPortal: "manager",
              });
            }
            for (const email of directEmails) {
              schedulePayloads.push({
                subject: p.subject.trim(),
                body: p.body.trim(),
                sendAt: p.sendAt,
                recipientEmail: email,
                recipientName: email,
                deliverViaEmail: p.deliverViaEmail !== false,
                deliverViaSms: p.deliverViaSms === true,
                senderPortal: "manager",
              });
            }
            if (schedulePayloads.length === 0) {
              showToast("Add at least one recipient to schedule.");
              return;
            }
            const results = await Promise.all(
              schedulePayloads.map((payload) =>
                fetch("/api/portal/scheduled-inbox-messages", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  credentials: "include",
                  body: JSON.stringify(payload),
                }),
              ),
            );
            if (results.some((res) => !res.ok)) {
              showToast("Some messages could not be scheduled.");
              return;
            }
            showToast(
              schedulePayloads.length === 1 ? "Message scheduled." : `${schedulePayloads.length} messages scheduled.`,
            );
            navigate(`${inboxBase}/schedule`);
            return;
          }

          const directEmails = p.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean);
          const primaryRecipient =
            directEmails.length === 1 && p.broadcastCategories.length === 0 ? directEmails[0]! : null;
          let optimisticId: string | null = null;

          if (primaryRecipient) {
            const optimistic = buildOptimisticSentThread({
              recipientEmail: primaryRecipient,
              subject: p.subject.trim(),
              body: p.body.trim(),
              senderLabel: p.senderName,
            });
            optimisticId = optimistic.id;
            stageOptimisticSentThread(optimistic);
          }

          const res = await fetch("/api/portal/send-inbox-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              fromName: p.senderName,
              fromEmail: p.senderEmail,
              toEmails: p.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean),
              toBroadcast: p.broadcastCategories,
              subject: p.subject.trim(),
              text: p.body.trim(),
              deliverToPortalInbox: true,
              deliverViaEmail: p.deliverViaEmail !== false,
              deliverViaSms: p.deliverViaSms === true,
              eventCategory: "messages",
              senderPortal: "manager",
            }),
          });
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
          if (!res.ok || !data.ok) {
            if (optimisticId) clearPendingSend(optimisticId);
            showToast("Message could not be sent.");
            return;
          }
          if (optimisticId) clearPendingSend(optimisticId);
          await reloadInboxAsync();
          const threadId = primaryRecipient ? findThreadForRecipient(primaryRecipient) : null;
          showToast(
            p.includesAxisAdmin && !p.includesDirectoryRecipients
              ? "Message sent to PropLane admin."
              : p.deliverViaSms
                ? "Message sent via inbox, email, and text."
                : "Message sent.",
          );
          if (threadId) {
            setExpandedId(threadId);
          }
          if (!embeddedInCommunication) {
            navigate(`${inboxBase}/sent`);
          }
        } catch {
          showToast("Message could not be sent.");
        }
      })();
    },
    [
      clearPendingSend,
      embeddedInCommunication,
      findThreadForRecipient,
      inboxBase,
      navigate,
      reloadInboxAsync,
      setExpandedId,
      showToast,
      stageOptimisticSentThread,
    ],
  );

  // ---- Open conversation (right pane) ----------------------------------
  const [replyDraft, setReplyDraft] = useState("");
  const [replyAttachments, setReplyAttachments] = useState<InboxComposerAttachment[]>([]);
  const [replySending, setReplySending] = useState(false);
  const [replyViaEmail, setReplyViaEmail] = useState(true);
  const [replyViaSms, setReplyViaSms] = useState(false);
  const [aiDraftViaEmail, setAiDraftViaEmail] = useState(true);
  const [aiDraftViaSms, setAiDraftViaSms] = useState(false);
  const [approvingDraft, setApprovingDraft] = useState(false);
  const { enabled: aiAutoSend, setEnabled: setAiAutoSend } = useInboxAiDraftAutoSend();
  const { channelsFor } = useManagerCommunicationDeliverVia();
  const autoSentDraftRef = useRef<string | null>(null);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [discardedDraftIds, setDiscardedDraftIds] = useState<Set<string>>(() => new Set());
  const [draftingIds, setDraftingIds] = useState<Set<string>>(() => new Set());
  const draftAttemptedRef = useRef<Set<string>>(new Set());

  const activeThread = useMemo(
    () => resolveCollapsedInboxThread(expandedId, emailThreads, local),
    [expandedId, emailThreads, local],
  );

  // Opening a thread in the unified Communication list marks it read (dot clears).
  useEffect(() => {
    if (!activeThread || activeThread.folder !== "inbox" || !activeThread.unread) return;
    markReadSilent(activeThread.id);
  }, [activeThread?.id]);

  // A fresh draft per conversation.
  useEffect(() => {
    setReplyDraft("");
    setReplyAttachments((prev) => {
      prev.forEach(revokeInboxAttachmentPreview);
      return [];
    });
  }, [expandedId]);

  const activeEmailAvailable = useMemo(
    () => Boolean(activeThread && inboxThreadHasEmail(activeThread.email)),
    [activeThread],
  );

  const activeSmsTarget = useMemo(
    () =>
      activeThread
        ? resolveManagerInboxSmsTarget(activeThread, smsRecipients, smsOutboundEnabled)
        : null,
    [activeThread, smsRecipients, smsOutboundEnabled],
  );
  const activeSmsAvailable = Boolean(activeSmsTarget?.phone?.trim());

  useEffect(() => {
    const preferred = channelsFor("inbox_default");
    const next = resolveManagerInboxReplyChannels({
      emailAvailable: activeEmailAvailable,
      smsAvailable: activeSmsAvailable,
      preferred,
    });
    setReplyViaEmail(next.viaEmail);
    setReplyViaSms(next.viaSms);
    setAiDraftViaEmail(next.viaEmail);
    setAiDraftViaSms(next.viaSms);
  }, [expandedId, channelsFor, activeEmailAvailable, activeSmsAvailable]);

  const activeIsSent = activeThread?.folder === "sent";
  const activeFolder = activeThread
    ? activeThread.folder === "trash"
      ? inferPreviousFolder(activeThread)
      : activeThread.folder
    : "inbox";

  const activeBubbles = useMemo((): InboxBubbleMessage[] => {
    if (!activeThread) return [];
    const pendingRoot = pendingSendingThreadIds.has(activeThread.id);
    return inboxThreadMessages(activeThread).map((m, i) => {
      // Root direction follows the folder (a Sent thread we authored). Appended
      // messages default to outbound (a reply we sent), but a new message
      // delivered into this person-thread carries an explicit direction so an
      // inbound turn on our inbox copy renders inbound rather than as our reply.
      const outbound = m.outbound ?? (i === 0 ? activeFolder === "sent" : true);
      const delivery =
        m.delivery ?? (pendingRoot && i === 0 && outbound ? ("sending" as const) : undefined);
      return {
        id: m.id,
        author: m.from,
        body: m.body,
        at: m.at,
        direction: outbound ? "outbound" : "inbound",
        delivery,
        // Email is the only live channel today; the tag makes the thread
        // omnichannel-ready so SMS/WhatsApp/Gmail can join the same person-thread.
        channel: "email",
        attachments: m.attachments,
      } satisfies InboxBubbleMessage;
    });
  }, [activeThread, activeFolder, pendingSendingThreadIds]);

  // ---- Scheduled / automated messages, INLINE in the person's thread --------
  // The old standalone Schedule table is gone; upcoming messages to this person
  // render as "Scheduled · sends <when>" cards at the tail of their conversation,
  // cancelable / send-now / editable in place.
  const [scheduledBusyId, setScheduledBusyId] = useState<string | null>(null);

  const threadScheduledItems = useMemo(
    () =>
      activeThread
        ? scheduledItemsForRecipient(activeThread.email, manualScheduledMessages, scheduledMessages)
        : [],
    [activeThread, manualScheduledMessages, scheduledMessages],
  );

  const reloadScheduled = useCallback(() => {
    void reloadManualScheduled();
    void reloadAutomationScheduled();
  }, [reloadManualScheduled, reloadAutomationScheduled]);

  useEffect(() => {
    if (!scheduledRefreshKey) return;
    reloadScheduled();
  }, [scheduledRefreshKey, reloadScheduled]);

  const cancelScheduledItem = useCallback(
    async (item: { id: string; source: "manual" | "automation" }) => {
      setScheduledBusyId(item.id);
      try {
        if (item.source === "manual") {
          const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(item.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ cancelled: true }),
          });
          if (!res.ok) throw new Error(await readPortalApiError(res, "Could not cancel send."));
        } else {
          await patchScheduledMessage(item.id, { cancelled: true });
        }
        showToast("Scheduled send cancelled.");
        reloadScheduled();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not cancel send.");
      } finally {
        setScheduledBusyId(null);
      }
    },
    [reloadScheduled, showToast],
  );

  const sendScheduledItemNow = useCallback(
    async (item: { id: string; source: "manual" | "automation" }) => {
      setScheduledBusyId(item.id);
      try {
        if (item.source === "manual") await sendManualScheduledMessageNow(item.id);
        else await sendAutomationScheduledMessageNow(item.id);
        showToast("Message sent.");
        reloadScheduled();
        reloadInbox();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not send message.");
      } finally {
        setScheduledBusyId(null);
      }
    },
    [reloadScheduled, reloadInbox, showToast],
  );

  const saveScheduledEdit = useCallback(
    async (
      item: { id: string; source: "manual" | "automation" },
      next: { subject: string; body: string; deliverViaEmail?: boolean; deliverViaSms?: boolean },
    ) => {
      // Rejects on failure so the inline editor stays open with the draft text.
      // The card renders the message inline, so there is deliberately no toast.
      try {
        if (item.source === "manual") {
          const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(item.id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              subject: next.subject,
              body: next.body,
              ...(next.deliverViaEmail !== undefined ? { deliverViaEmail: next.deliverViaEmail } : {}),
              ...(next.deliverViaSms !== undefined ? { deliverViaSms: next.deliverViaSms } : {}),
            }),
          });
          if (!res.ok) throw new Error(await readPortalApiError(res, "Could not save changes."));
        } else {
          await patchScheduledMessage(item.id, { customSubject: next.subject, customBody: next.body });
        }
      } catch (e) {
        throw new Error(e instanceof Error && e.message ? e.message : "Could not save changes.");
      }
      showToast("Scheduled message updated.");
      reloadScheduled();
    },
    [reloadScheduled, showToast],
  );

  const openThread = useCallback(
    (thread: InboxThread) => {
      setExpandedId(thread.id);
      // Opening an unread inbox message reads it (natural inbox behaviour).
      if (thread.folder === "inbox" && thread.unread) markReadSilent(thread.id);
    },
    // markReadSilent only closes over stable state setters.
    [],
  );

  const pickReplyAttachments = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      const room = INBOX_MAX_ATTACHMENTS - replyAttachments.length;
      if (room <= 0) {
        showToast(`You can attach up to ${INBOX_MAX_ATTACHMENTS} files.`);
        return;
      }
      const batch = Array.from(files).slice(0, room);
      for (const file of batch) {
        const pending = createPendingInboxAttachment(file);
        setReplyAttachments((prev) => [...prev, pending]);
        void uploadInboxAttachment(file)
          .then((url) => {
            setReplyAttachments((prev) =>
              prev.map((a) => (a.id === pending.id ? { ...a, uploadUrl: url, uploading: false } : a)),
            );
          })
          .catch((e) => {
            setReplyAttachments((prev) =>
              prev.map((a) =>
                a.id === pending.id
                  ? { ...a, uploading: false, error: e instanceof Error ? e.message : "Upload failed" }
                  : a,
              ),
            );
          });
      }
    },
    [replyAttachments.length, showToast],
  );

  const removeReplyAttachment = useCallback((id: string) => {
    setReplyAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) revokeInboxAttachmentPreview(target);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const sendActiveReply = useCallback(async () => {
    if (!activeThread) return;
    const text = replyDraft.trim();
    const attachmentUrls = replyAttachments
      .filter((a) => a.uploadUrl && !a.uploading && !a.error)
      .map((a) => a.uploadUrl!);
    if (!text && attachmentUrls.length === 0) return;
    if (!replyViaEmail && !replyViaSms) {
      showToast("Choose Email, SMS, or both.");
      return;
    }
    if (replyAttachments.some((a) => a.uploading)) {
      showToast("Wait for uploads to finish.");
      return;
    }
    setReplySending(true);
    try {
      const outcome = await handleReply(activeThread.id, text, { email: replyViaEmail, sms: replyViaSms }, attachmentUrls);
      if (!outcome) return;
      setReplyDraft("");
      setReplyAttachments((prev) => {
        prev.forEach(revokeInboxAttachmentPreview);
        return [];
      });
      showToast(inboxReplySentToastMessage(outcome));
    } catch (error) {
      showToast(
        error instanceof InboxSendRefusal
          ? (error.reason ?? "Could not send reply.")
          : "Could not send reply.",
      );
    } finally {
      setReplySending(false);
    }
  }, [
    activeThread,
    replyDraft,
    replyAttachments,
    replyViaEmail,
    replyViaSms,
    handleReply,
    showToast,
  ]);

  const requestInboxAiDraft = useCallback(async (threadId: string, force = false) => {
    if (isDemoModeActive()) return;
    setDraftingIds((prev) => {
      if (prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.add(threadId);
      return next;
    });
    try {
      const res = await fetch("/api/portal/inbox-draft-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ threadId, force }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        skip?: boolean;
        draft?: InboxAiDraft;
        error?: string;
      };
      if (data.ok && data.draft) {
        // Persist after deriving the next snapshot, never from a React state
        // updater. `persistInbox` dispatches the shared inbox-change event, so
        // calling it while React is rendering this updater synchronously asks
        // every inbox observer to update during another component's render.
        const next = localRef.current.map((thread) =>
          thread.id === threadId ? { ...thread, aiDraft: data.draft } : thread,
        );
        setLocal(next);
        // The existing `local` persistence effect runs after this update has
        // committed. Persisting here dispatches the inbox-change event while
        // React may still be rendering this state transition.
        setDraftErrors((prev) => {
          const next = { ...prev };
          delete next[threadId];
          return next;
        });
      } else if (data.ok && data.skip) {
        setDraftErrors((prev) => {
          const next = { ...prev };
          delete next[threadId];
          return next;
        });
      } else if (!data.ok && data.error) {
        setDraftErrors((prev) => ({ ...prev, [threadId]: data.error ?? "Could not draft reply." }));
      }
    } catch {
      setDraftErrors((prev) => ({ ...prev, [threadId]: "Could not draft reply." }));
    } finally {
      setDraftingIds((prev) => {
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
  }, []);

  // Auto-draft every incoming resident thread that still needs a manager reply.
  useEffect(() => {
    if (!inboxSynced || isDemoModeActive()) return;
    for (const thread of local) {
      if (!threadEligibleForAiDraft(thread)) continue;
      if (thread.aiDraft?.status === "pending_approval") continue;
      if (discardedDraftIds.has(thread.id)) continue;
      if (draftAttemptedRef.current.has(thread.id)) continue;
      draftAttemptedRef.current.add(thread.id);
      void requestInboxAiDraft(thread.id);
    }
  }, [discardedDraftIds, inboxSynced, local, requestInboxAiDraft]);

  const smsRecipientEmails = useMemo(() => {
    if (!smsUiEnabled) return new Set<string>();
    return new Set(
      smsRecipients
        .filter((r) => r.phone?.trim() && r.residentEmail?.trim())
        .map((r) => (r.residentEmail ?? "").trim().toLowerCase()),
    );
  }, [smsRecipients, smsUiEnabled]);

  const discardActiveDraft = useCallback(async () => {
    if (!activeThread?.aiDraft) return;
    const updated: InboxThread = { ...activeThread, aiDraft: undefined };
    const next = local.map((t) => (t.id === activeThread.id ? updated : t));
    setDiscardedDraftIds((prev) => new Set(prev).add(activeThread.id));
    persistInboxRef.current = false;
    setLocal(next);
    await upsertPersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, [updated], next);
    persistInboxRef.current = true;
  }, [activeThread, local]);

  const approveActiveDraft = useCallback(async () => {
    if (!activeThread?.aiDraft?.text?.trim()) return;
    // Resolve against live availability so auto-send (and a stale picker
    // state right after opening a phone-only thread) still picks SMS when
    // email is impossible — never toast "choose a channel" and stick the
    // auto-send latch forever.
    const channels = resolveManagerInboxReplyChannels({
      emailAvailable: activeEmailAvailable,
      smsAvailable: activeSmsAvailable,
      preferred: { viaEmail: aiDraftViaEmail, viaSms: aiDraftViaSms },
    });
    if (!channels.viaEmail && !channels.viaSms) {
      showToast("Choose Email, SMS, or both.");
      return false;
    }
    setApprovingDraft(true);
    try {
      const outcome = await handleReply(activeThread.id, activeThread.aiDraft.text.trim(), {
        email: channels.viaEmail,
        sms: channels.viaSms,
      });
      if (outcome) showToast(inboxReplySentToastMessage(outcome));
      return true;
    } catch (error) {
      autoSentDraftRef.current = null;
      showToast(
        error instanceof InboxSendRefusal
          ? (error.reason ?? "Could not send reply.")
          : "Could not send reply.",
      );
      return false;
    } finally {
      setApprovingDraft(false);
    }
  }, [activeEmailAvailable, activeSmsAvailable, activeThread, aiDraftViaEmail, aiDraftViaSms, handleReply, showToast]);

  useEffect(() => {
    if (!activeThread?.aiDraft?.text || activeThread.aiDraft.status !== "pending_approval") return;
    const preferred = channelsFor("inbox_default");
    const next = resolveManagerInboxReplyChannels({
      emailAvailable: activeEmailAvailable,
      smsAvailable: activeSmsAvailable,
      preferred,
    });
    setAiDraftViaEmail(next.viaEmail);
    setAiDraftViaSms(next.viaSms);
  }, [
    activeThread?.aiDraft?.text,
    activeThread?.aiDraft?.status,
    activeThread?.id,
    activeEmailAvailable,
    activeSmsAvailable,
    channelsFor,
  ]);

  useEffect(() => {
    autoSentDraftRef.current = null;
  }, [activeThread?.id]);

  useEffect(() => {
    if (!aiAutoSend || !activeThread?.aiDraft?.text) return;
    if (activeThread.aiDraft.status !== "pending_approval") return;
    if (approvingDraft || draftingIds.has(activeThread.id)) return;
    if (!activeEmailAvailable && !activeSmsAvailable) return;
    const key = `${activeThread.id}:${activeThread.aiDraft.text}`;
    if (autoSentDraftRef.current === key) return;
    autoSentDraftRef.current = key;
    void approveActiveDraft().then((sent) => {
      if (!sent) autoSentDraftRef.current = null;
    });
  }, [
    aiAutoSend,
    activeThread?.id,
    activeThread?.aiDraft?.text,
    activeThread?.aiDraft?.status,
    activeEmailAvailable,
    activeSmsAvailable,
    approvingDraft,
    draftingIds,
    approveActiveDraft,
  ]);

  const replyChannelPicker = (
    <InboxReplyChannelPicker
      viaEmail={replyViaEmail}
      viaSms={replyViaSms}
      onViaEmailChange={setReplyViaEmail}
      onViaSmsChange={setReplyViaSms}
      emailAvailable={activeEmailAvailable}
      smsAvailable={activeSmsAvailable}
    />
  );

  const aiDraftChannelPicker = (
    <InboxReplyChannelPicker
      viaEmail={aiDraftViaEmail}
      viaSms={aiDraftViaSms}
      onViaEmailChange={setAiDraftViaEmail}
      onViaSmsChange={setAiDraftViaSms}
      emailAvailable={activeEmailAvailable}
      smsAvailable={activeSmsAvailable}
    />
  );

  const editActiveDraft = useCallback(() => {
    if (!activeThread?.aiDraft?.text) return;
    setReplyDraft(activeThread.aiDraft.text);
    setReplyViaEmail(aiDraftViaEmail);
    setReplyViaSms(aiDraftViaSms && activeSmsAvailable);
  }, [activeSmsAvailable, activeThread, aiDraftViaEmail, aiDraftViaSms]);

  const showAiDraftUi = Boolean(
    activeThread &&
      activeThread.folder === "inbox" &&
      ((activeThread.messages ?? []).length > 0 || Boolean(activeThread.body?.trim())),
  );

  const emptyCopy = inboxTabEmptyCopy(tabId);

  const bulkMarkRead = () => {
    const eligible = [...threadSelection.selectedIds].filter(isUnreadInboxThread);
    if (eligible.length === 0) {
      showToast("Nothing to mark read. The selection has no unread inbox messages.");
      return;
    }
    for (const id of eligible) markRead(id);
    threadSelection.clearSelection();
  };

  const bulkMoveToTrash = () => {
    for (const id of threadSelection.selectedIds) moveToTrash(id);
    threadSelection.clearSelection();
  };

  const bulkRestoreFromTrash = () => {
    for (const id of threadSelection.selectedIds) restoreFromTrash(id);
    threadSelection.clearSelection();
  };

  const bulkDeleteForever = () => {
    if (!window.confirm(`Delete ${threadSelection.selectedIds.size} message(s) permanently?`)) return;
    for (const id of threadSelection.selectedIds) deleteForever(id);
    threadSelection.clearSelection();
  };

  // Rendered next to the tab pills when Inbox owns its own page shell, and at
  // the top of the body when Communication owns it. Both are required: the real
  // manager portal only ever mounts the embedded branch (/portal/inbox/*
  // redirects to Communication), so a filter-row-only search box would render
  // on /demo and nowhere else.
  const searchBox = (
    <div className="relative min-w-0 flex-1 sm:max-w-xs">
      <svg
        viewBox="0 0 24 24"
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="m21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search messages…"
        aria-label="Search messages by sender, subject, or content"
        data-attr="inbox-message-search"
        className="portal-inbox-search h-9 w-full rounded-full border border-border bg-card pl-9 pr-8 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted/70 focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
      />
      {searchActive ? (
        <button
          type="button"
          onClick={() => setQuery("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-foreground/5 hover:text-foreground"
        >
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
    </div>
  );

  const rowCheckbox = (thread: InboxThread) => (
    <input
      type="checkbox"
      className="h-4 w-4 shrink-0 rounded border-border accent-primary"
      checked={threadSelection.selectedIds.has(thread.id)}
      onChange={() => threadSelection.toggleSelected(thread.id)}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Select message ${thread.subject}`}
    />
  );

  const bulkButtons = (
    <>
      {searchActive || tabId === "unopened" ? (
        <Button type="button" variant="outline" className="min-h-0 rounded-full px-3 py-1.5 text-xs" onClick={bulkMarkRead}>
          Mark read
        </Button>
      ) : null}
      {searchActive || tabId === "unopened" || tabId === "opened" || tabId === "sent" ? (
        <Button type="button" variant="outline" className="min-h-0 rounded-full px-3 py-1.5 text-xs" onClick={bulkMoveToTrash}>
          Trash
        </Button>
      ) : null}
      {!searchActive && tabId === "trash" ? (
        <>
          <Button type="button" variant="outline" className="min-h-0 rounded-full px-3 py-1.5 text-xs" onClick={bulkRestoreFromTrash}>
            Restore
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-0 rounded-full border-rose-200 px-3 py-1.5 text-xs text-rose-700 hover:bg-[var(--status-overdue-bg)]"
            onClick={bulkDeleteForever}
          >
            Delete
          </Button>
        </>
      ) : null}
      <Button type="button" variant="outline" className="min-h-0 rounded-full px-3 py-1.5 text-xs" onClick={threadSelection.clearSelection}>
        Clear
      </Button>
    </>
  );

  const hasSelection = threadSelection.selectedIds.size > 0;

  const listPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={PORTAL_INBOX_LIST_TOOLBAR_CLASS}>
        {searchBox}
        {searchActive ? (
          <p className="px-1 text-[11px] leading-snug text-muted">
            {rowsForTab.length} message{rowsForTab.length === 1 ? "" : "s"} matching{" "}
            <span className="font-medium text-foreground">“{query.trim()}”</span>, best first.{" "}
            {searchSkipsTrashNote(tabId)}
          </p>
        ) : null}
        {rowsForTab.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2 px-1">
            <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border accent-primary"
                checked={threadSelection.allSelected}
                onChange={() => threadSelection.toggleSelectAll()}
                aria-label="Select all messages"
              />
              {hasSelection ? `${threadSelection.selectedIds.size} selected` : "Select all"}
            </label>
            {hasSelection ? <div className="flex flex-wrap items-center gap-1.5">{bulkButtons}</div> : null}
          </div>
        ) : null}
      </div>
      <div className={INBOX_LIST_SCROLL}>
        {rowsForTab.length === 0 ? (
          <div className="p-4">
            <PortalInboxEmptyState title={searchActive ? `No messages match “${query.trim()}”.` : emptyCopy} />
          </div>
        ) : (
          rowsForTab.map((thread) => {
            const sentSemantics = searchActive ? thread.folder === "sent" : tabId === "sent";
            const recipientLabel = thread.email || "Unknown recipient";
            const displayName = sentSemantics
              ? searchActive
                ? `To: ${recipientLabel}`
                : recipientLabel
              : thread.from || thread.email || "Unknown sender";
            const msgs = inboxThreadMessages(thread);
            const lastMsg = msgs[msgs.length - 1];
            const folder = thread.folder === "trash" ? inferPreviousFolder(thread) : thread.folder;
            const lastOutbound = lastMsg?.outbound ?? (msgs.length > 1 ? true : folder === "sent");
            return (
              <InboxConversationRow
                key={thread.id}
                name={displayName}
                subtitle={thread.subject}
                preview={previewLine(lastMsg?.body ?? thread.preview ?? "", 80)}
                previewPrefix={lastOutbound ? "You: " : undefined}
                time={thread.time}
                unread={thread.folder === "inbox" && thread.unread}
                selected={expandedId === thread.id}
                onOpen={() => openThread(thread)}
                leading={rowCheckbox(thread)}
              />
            );
          })
        )}
      </div>
    </div>
  );

  const threadHeaderActions = activeThread ? (
    activeThread.folder === "trash" ? (
      <>
        <Button
          type="button"
          variant="outline"
          className="min-h-0 rounded-full px-3 py-1.5 text-xs"
          onClick={() => restoreFromTrash(activeThread.id)}
        >
          Restore
        </Button>
        <Button
          type="button"
          variant="outline"
          className="min-h-0 rounded-full border-rose-200 px-3 py-1.5 text-xs text-rose-700 hover:bg-[var(--status-overdue-bg)]"
          onClick={() => deleteForever(activeThread.id)}
        >
          Delete
        </Button>
      </>
    ) : (
      <>
        {embeddedResidentChat && onNewMessage ? (
          <Button
            type="button"
            variant="primary"
            className="min-h-0 rounded-full px-3 py-1.5 text-xs"
            data-attr="resident-detail-new-message"
            onClick={onNewMessage}
          >
            New message
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          className="min-h-0 rounded-full px-3 py-1.5 text-xs"
          data-attr="inbox-thread-archive"
          onClick={() => moveToTrash(activeThread.id)}
        >
          Archive
        </Button>
      </>
    )
  ) : null;

  const scheduledCards =
    activeThread &&
    activeThread.folder !== "trash" &&
    threadScheduledItems.length > 0 ? (
      <InboxScheduledThreadList
        count={threadScheduledItems.length}
        nextSendLabel={threadScheduledItems[0]?.sendLabel}
      >
        {threadScheduledItems.map((item) => (
          <InboxScheduledCard
            key={item.id}
            sendLabel={item.sendLabel}
            subject={item.subject}
            body={item.body}
            meta={item.meta}
            channel={item.channel}
            deliverViaEmail={item.deliverViaEmail}
            deliverViaSms={item.deliverViaSms}
            emailAvailable={activeEmailAvailable}
            smsAvailable={activeSmsAvailable}
            channelEditable={item.source === "manual" && item.editable}
            source={item.source}
            editable={item.editable}
            busy={scheduledBusyId === item.id}
            onCancel={() => void cancelScheduledItem(item)}
            onSendNow={() => void sendScheduledItemNow(item)}
            onSaveEdit={item.editable ? (next) => saveScheduledEdit(item, next) : undefined}
          />
        ))}
      </InboxScheduledThreadList>
    ) : null;

  const threadPane = activeThread ? (
    <InboxThreadView
      title={
        activeIsSent
          ? activeThread.email || "Unknown recipient"
          : activeThread.from || activeThread.email || "Unknown sender"
      }
      avatarName={
        activeIsSent
          ? activeThread.email || undefined
          : activeThread.from || activeThread.email || undefined
      }
      subtitle={activeThread.subject || (activeIsSent ? undefined : activeThread.email)}
      messages={activeBubbles}
      threadKey={activeThread.id}
      onBack={embeddedResidentChat ? undefined : () => setExpandedId(null)}
      hideIdentityHeader={embeddedResidentChat}
      headerActions={threadHeaderActions}
      emptyLabel="No messages in this conversation."
      scrollMode={embeddedResidentChat ? "pane" : pageScroll ? "page" : "pane"}
      composer={
        activeThread.folder === "trash" ? undefined : (
          <>
            {scheduledCards ? (
              <div
                className="shrink-0 border-t border-border bg-card/90 px-2 py-2 md:px-3"
                data-attr="inbox-thread-scheduled-pin"
              >
                {scheduledCards}
              </div>
            ) : null}
            {showAiDraftUi ? (
              <AiDraftReplyCard
                drafting={draftingIds.has(activeThread.id) && !activeThread.aiDraft?.text}
                draft={
                  activeThread.aiDraft?.status === "pending_approval" ? activeThread.aiDraft.text : undefined
                }
                error={draftErrors[activeThread.id]}
                approving={approvingDraft}
                onApprove={() => void approveActiveDraft()}
                onEdit={editActiveDraft}
                onDiscard={() => void discardActiveDraft()}
                channelControl={aiDraftChannelPicker}
                autoSend={aiAutoSend}
                onAutoSendChange={setAiAutoSend}
                onGenerate={
                  threadEligibleForAiDraft(activeThread) &&
                  activeThread.aiDraft?.status !== "pending_approval"
                    ? () => {
                        draftAttemptedRef.current.delete(activeThread.id);
                        void requestInboxAiDraft(activeThread.id, true);
                      }
                    : undefined
                }
              />
            ) : null}
            <InboxThreadAssistantStrip
              contextHint={buildInboxThreadAssistantContext({
                subject: activeThread.subject,
                email: activeThread.email,
                from: activeThread.from,
                sentSemantics: activeIsSent,
              })}
              storageScopeKey={
                embeddedResidentChat
                  ? `resident-detail-${activeThread.email.trim().toLowerCase()}`
                  : "Communication thread"
              }
            />
            <InboxComposer
              value={replyDraft}
              onChange={setReplyDraft}
              onSubmit={() => void sendActiveReply()}
              sending={replySending}
              placeholder="Write a reply…"
              maxLength={replyViaSms && !replyViaEmail ? 1600 : undefined}
              dataAttr="inbox-reply"
              channelControl={replyChannelPicker}
              attachments={replyAttachments}
              onAttachmentsPick={pickReplyAttachments}
              onAttachmentRemove={removeReplyAttachment}
              maxAttachments={INBOX_MAX_ATTACHMENTS}
            />
          </>
        )
      }
    />
  ) : emptyThreadFallback && suppressListPane ? (
    emptyThreadFallback
  ) : (
    <InboxThreadEmpty />
  );

  const inboxBody = (
    <>
      {embeddedInCommunication && !externalTitleActions ? (
        <PortalSectionActionRow className="mb-4">
          {tabId === "trash" ? (
            <Button
              type="button"
              variant="outline"
              className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`}
              onClick={deleteAllTrash}
            >
              Delete all trash
            </Button>
          ) : null}
          <Button
            type="button"
            variant="primary"
            className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`}
            data-attr="inbox-new-message"
            onClick={() => setComposeOpen(true)}
          >
            New message
          </Button>
        </PortalSectionActionRow>
      ) : null}

      {!suppressCompose ? (
        <ScopedInboxComposeModal
          open={composeOpen}
          onClose={() => setComposeOpen(false)}
          onSend={handleComposeSend}
          portal="manager"
          senderName="Property manager"
          senderEmail="manager@example.com"
          liveContacts={liveContacts}
        />
      ) : null}

      {tabId === "schedule" && !searchActive ? (
        <ManagerInboxSchedulePanel
          portalBase={portalBase}
          smsUiEnabled={smsUiEnabled}
          smsRecipientEmails={smsRecipientEmails}
        />
      ) : suppressListPane ? (
        <div
          className={`${
            embeddedResidentChat || !pageScroll
              ? "flex h-full min-h-0 flex-1 flex-col overflow-hidden"
              : "flex flex-col"
          }`}
        >
          {threadPane}
        </div>
      ) : (
        <InboxTwoPane threadOpen={Boolean(activeThread)} list={listPane} thread={threadPane} />
      )}
    </>
  );

  if (embeddedInCommunication) {
    return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">{inboxBody}</div>;
  }

  return (
    <ManagerPortalPageShell
      title="Inbox"
      titleAside={
        <>
          {tabId === "trash" ? (
            <Button
              type="button"
              variant="outline"
              className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)]`}
              onClick={deleteAllTrash}
            >
              Delete all trash
            </Button>
          ) : null}
          <Button type="button" variant="primary" className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`} data-attr="inbox-new-message" onClick={() => setComposeOpen(true)}>
            New message
          </Button>
        </>
      }
      filterRow={
        <ManagerPortalFilterRow>
          <ManagerPortalStatusPills
            tabs={tabs}
            activeId={tabId}
            onChange={(id) => navigate(`${inboxBase}/${id}`)}
          />
        </ManagerPortalFilterRow>
      }
    >
      {inboxBody}
    </ManagerPortalPageShell>
  );
});
