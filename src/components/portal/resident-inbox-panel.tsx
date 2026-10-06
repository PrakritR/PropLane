"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, Mail, MailOpen, MessageSquare, Phone, Trash2 } from "lucide-react";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { useSearchParams } from "next/navigation";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { Button } from "@/components/ui/button";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import { ScopedInboxComposeModal, type ScopedInboxSendPayload } from "@/components/portal/inbox-scoped-compose-modal";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { INBOX_TAB_DEFS, INBOX_LIST_SCROLL, INBOX_THREAD_ICON_BTN, INBOX_THREAD_ICON_BTN_DANGER, InboxBubbleMessage, InboxComposer, InboxConversationRow, InboxScheduledCard, InboxScheduledThreadList, InboxThreadEmpty, InboxThreadView, InboxTwoPane, PortalInboxEmptyState, PortalInboxMessageTable, type PortalInboxTableRow } from "@/components/portal/portal-inbox-ui";
import { InboxComposerChannelMenu, InboxComposerScheduleMenu } from "@/components/portal/inbox-composer-tools";
import { defaultScheduleSendAtLocal } from "@/components/portal/portal-message-compose-fields";
import { useResidentManagerContacts } from "@/hooks/use-resident-manager-contacts";
import { matchResidentManagerContact, resolveResidentThreadManager } from "@/lib/resident-communication-manager";
import { scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import {
  PortalInboxSelectionToolbar,
  sendManualScheduledMessageNow,
  useInboxRowSelection,
} from "@/components/portal/portal-inbox-selection";
import { ManagerPortalPageShell, ManagerPortalFilterRow, PORTAL_FILTER_ACTIONS_MOBILE, PORTAL_HEADER_ACTION_BTN, PORTAL_PAGE_ACTIONS_DESKTOP } from "@/components/portal/portal-metrics";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalListToolbar } from "@/components/portal/portal-list-toolbar";
import { PORTAL_DETAIL_BTN } from "@/components/portal/portal-data-table";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import { resolveCommunicationInboxThread } from "@/lib/communication-assistant-inbox-list";
import { demoResidentInboxThreads } from "@/data/demo-portal";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isUpcomingScheduledInboxMessage, type ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import {
  hasInboxReplyChannelSelected,
  resolveCommunicationPersonThreadReplyChannels,
} from "@/lib/manager-inbox-reply-channels";
import { sendPropLaneAssistantInboxMessage } from "@/lib/assistant-inbox-reply";
import {
  InboxSendRefusal,
  inboxReplySentToastMessage as residentReplySentToastMessage,
  type InboxReplySendOutcome as ResidentReplySendOutcome,
} from "@/lib/inbox-reply-outcome";

export { residentReplySentToastMessage };
export type { ResidentReplySendOutcome };

function resolveResidentReplyRecipientEmail(threadEmail: string, contacts: InboxScopedContact[]): string {
  const normalized = threadEmail.trim().toLowerCase();
  if (contacts.some((contact) => contact.email.trim().toLowerCase() === normalized)) return normalized;
  const manager = contacts.find((contact) => contact.role === "manager");
  return manager?.email.trim().toLowerCase() ?? normalized;
}
import {
  buildOptimisticSentThread,
  markThreadMessageDelivery,
} from "@/lib/inbox-message-timeline";
import {
  PORTAL_INBOX_CHANGED_EVENT,
  type PersistedInboxThread,
  deleteInboxThreadIds,
  invalidatePersistedInboxCache,
  inboxMutationInFlight,
  persistInbox,
  persistInboxAwait,
  loadPersistedInbox,
  RESIDENT_INBOX_STORAGE_KEY,
  runInboxMutation,
  stagePersistedInboxRows,
  syncPersistedInboxFromServer,
  upsertPersistedInboxRows,
  inboxThreadMessages,
  lastInboundChannelOf,
  inboxMessageOutbound,
  appendReplyToInboxThread,
  formatInboxStamp,
  collapsePersonInboxThreads,
  inboxThreadCounterpartyEmail,
  type InboxThreadMessage,
} from "@/lib/portal-inbox-storage";
import { inboxEmailBubbleFields } from "@/lib/inbox-email-display";
import { inboxThreadLastTurnDirection, inboxTurnDirection } from "@/lib/inbox-turn-direction";
import {
  consumeResidentComposePrefill,
  type ResidentComposePrefill,
} from "@/lib/resident-compose-prefill";
import { residentListingManagerMessageDraft } from "@/lib/resident-manager-message-draft";
import {
  INBOX_MAX_ATTACHMENTS,
  attachmentMetaFromUrls,
  createPendingInboxAttachment,
  revokeInboxAttachmentPreview,
  uploadInboxAttachment,
  type InboxComposerAttachment,
} from "@/lib/inbox-attachments";

type InboxThread = PersistedInboxThread;

/** Stable seed when localStorage is empty (matches demo-portal resident inbox seeds). */
export const RESIDENT_INBOX_THREAD_FALLBACK: PersistedInboxThread[] = demoResidentInboxThreads.map((t) => ({
  id: t.id,
  folder: "inbox" as const,
  from: t.from,
  email: t.email,
  subject: t.subject,
  preview: t.preview,
  body: t.body,
  time: t.when,
  unread: t.unread,
}));

function countThreads(threads: InboxThread[]) {
  return {
    unopened: threads.filter((t) => t.folder === "inbox" && t.unread).length,
    opened: threads.filter((t) => t.folder === "inbox" && !t.unread).length,
    sent: threads.filter((t) => t.folder === "sent").length,
    trash: threads.filter((t) => t.folder === "trash").length,
  };
}

function scheduledToRows(list: ScheduledInboxMessageRecord[]): PortalInboxTableRow[] {
  return list.map((message) => ({
    id: message.id,
    name: message.recipientName || message.recipientEmail,
    email: message.recipientEmail,
    subject: message.subject,
    whenLabel: formatPacificDateTime(message.sendAt),
    read: message.status !== "scheduled",
    selectable: message.status === "scheduled" || message.status === "cancelled",
  }));
}

function previewLine(body: string, max = 100) {
  const t = body.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

export type ResidentInboxPanelHandle = {
  openCompose: (draft?: ResidentComposePrefill) => void;
  emptyTrash: () => void;
  findThreadForRecipient: (email: string) => string | null;
};

export type ResidentInboxTabCounts = {
  unopened: number;
  opened: number;
  schedule: number;
  sent: number;
  trash: number;
};

export const ResidentInboxPanel = forwardRef<
  ResidentInboxPanelHandle,
  {
    tabId: string;
    embeddedInCommunication?: boolean;
    externalTitleActions?: boolean;
    onTabCountsChange?: (counts: ResidentInboxTabCounts) => void;
    suppressListPane?: boolean;
    controlledExpandedId?: string | null;
    onControlledExpandedIdChange?: (id: string | null) => void;
    /** Let #portal-main-content scroll the thread (native-safe; matches manager embedded chat). */
    pageScroll?: boolean;
    smsUiEnabled?: boolean;
  }
>(function ResidentInboxPanel(
  {
    tabId,
    embeddedInCommunication = false,
    externalTitleActions = false,
    onTabCountsChange,
    suppressListPane = false,
    controlledExpandedId,
    onControlledExpandedIdChange,
    pageScroll = false,
    smsUiEnabled = false,
  },
  ref,
) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const session = usePortalSession();
  const navigate = usePortalNavigate();
  const searchParams = useSearchParams();
  const [local, setLocal] = useState<InboxThread[]>(
    () => loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK) as InboxThread[],
  );
  const localRef = useRef(local);
  useEffect(() => {
    localRef.current = local;
  }, [local]);
  const [pendingSendingThreadIds, setPendingSendingThreadIds] = useState<Set<string>>(() => new Set());
  const [persistReady, setPersistReady] = useState(false);
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
  const [replyDraft, setReplyDraftState] = useState("");
  const replyDraftRef = useRef("");
  const [replyFocusSignal] = useState(0);
  const updateReplyDraft = useCallback((next: string) => {
    replyDraftRef.current = next;
    setReplyDraftState(next);
  }, []);
  const [replySending, setReplySending] = useState(false);
  const [replyViaEmail, setReplyViaEmail] = useState(true);
  const [replyViaSms, setReplyViaSms] = useState(false);
  const [replyViaProplane, setReplyViaProplane] = useState(false);
  // Schedule for later (the clock tool beside the channel menu), same as the manager's composer.
  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduleSendAt, setScheduleSendAt] = useState(() => defaultScheduleSendAtLocal());
  const [replyAttachments, setReplyAttachments] = useState<InboxComposerAttachment[]>([]);
  const [smsConfigured, setSmsConfigured] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ResidentComposePrefill | null>(null);
  // Threads marked read while viewing "Unopened" stay listed until the tab is
  // switched or the page is refreshed; they only move to "Opened" on reset.
  const [retainedIds, setRetainedIds] = useState<Set<string>>(() => new Set());
  // Individually-selectable recipients (this resident's own manager[s] + co-managers),
  // scoped server-side by /api/portal/inbox-eligible-contacts.
  const [eligibleContacts, setEligibleContacts] = useState<InboxScopedContact[]>([]);
  const [scheduledMessages, setScheduledMessages] = useState<ScheduledInboxMessageRecord[]>([]);
  const [scheduledLoading, setScheduledLoading] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    updateReplyDraft("");
    setScheduleLater(false);
    if (!embeddedInCommunication) {
      setReplyViaEmail(true);
      setReplyViaSms(false);
    }
    setReplyAttachments((prev) => {
      prev.forEach(revokeInboxAttachmentPreview);
      return [];
    });
  }, [embeddedInCommunication, expandedId, updateReplyDraft]);

  useEffect(() => {
    if (!smsUiEnabled || isDemoModeActive()) return;
    void fetch("/api/resident/sms-conversations", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => setSmsConfigured(Boolean(body?.smsConfigured)))
      .catch(() => setSmsConfigured(false));
  }, [smsUiEnabled]);

  const reloadScheduledMessages = useCallback(async () => {
    if (isDemoModeActive()) return;
    setScheduledLoading(true);
    try {
      const res = await fetch("/api/portal/scheduled-inbox-messages?as=resident", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: ScheduledInboxMessageRecord[] };
      setScheduledMessages(Array.isArray(data.messages) ? data.messages : []);
    } finally {
      setScheduledLoading(false);
    }
  }, []);

  const loadEligibleContacts = useCallback(async () => {
    if (isDemoModeActive()) return;
    try {
      const res = await fetch("/api/portal/inbox-eligible-contacts?portal=resident", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { contacts?: InboxScopedContact[] };
      setEligibleContacts(Array.isArray(data.contacts) ? data.contacts : []);
    } catch {
      setEligibleContacts([]);
    }
  }, []);

  useEffect(() => {
    if (!embeddedInCommunication || isDemoModeActive()) return;
    void loadEligibleContacts();
  }, [embeddedInCommunication, loadEligibleContacts]);

  useEffect(() => {
    if (!composeOpen || isDemoModeActive()) return;
    void loadEligibleContacts();
  }, [composeOpen, loadEligibleContacts]);

  useEffect(() => {
    const prefill = consumeResidentComposePrefill();
    if (prefill) {
      setComposeDraft(prefill);
      setComposeOpen(true);
      return;
    }
    // `useSearchParams()` is typed `ReadonlyURLSearchParams | null` and really
    // does hand back null (a render outside a Suspense boundary, and any test
    // that mounts this panel without a router). An unguarded `.get` throws in a
    // passive effect, which takes the whole panel down rather than just skipping
    // the compose deep-link this effect exists to honour.
    const propertyId = searchParams?.get("propertyId")?.trim() ?? "";
    if (searchParams?.get("compose") !== "1" || !propertyId) return;
    setComposeDraft(residentListingManagerMessageDraft(propertyId));
    setComposeOpen(true);
  }, [searchParams]);

  useEffect(() => {
    if (tabId !== "schedule" && !embeddedInCommunication) return;
    void reloadScheduledMessages();
  }, [embeddedInCommunication, reloadScheduledMessages, tabId]);

  useEffect(() => {
    persistInboxRef.current = false;
    void syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY).then((rows) => {
      if (!inboxMutationInFlight()) {
        setLocal(rows as InboxThread[]);
      }
      setPersistReady(true);
      if (!inboxMutationInFlight()) {
        persistInboxRef.current = true;
      }
    });
  }, []);

  useEffect(() => {
    const sync = (evt?: Event) => {
      if (evt && evt.type === PORTAL_INBOX_CHANGED_EVENT) {
        const ce = evt as CustomEvent<{ key?: string }>;
        if (ce.detail?.key && ce.detail.key !== RESIDENT_INBOX_STORAGE_KEY) return;
      }
      setLocal(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK) as InboxThread[]);
    };
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => {
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    };
  }, []);

  useEffect(() => {
    if (!persistReady || !persistInboxRef.current) return;
    persistInbox(RESIDENT_INBOX_STORAGE_KEY, local);
  }, [local, persistReady]);

  const scheduledRows = useMemo(
    () =>
      scheduledMessages
        .filter((message) => isUpcomingScheduledInboxMessage(message.sendAt, message.status))
        .sort((a, b) => a.sendAt.localeCompare(b.sendAt)),
    [scheduledMessages],
  );

  const scheduleSelectableIds = useMemo(
    () =>
      scheduledRows
        .filter((m) => m.status === "scheduled" || m.status === "cancelled")
        .map((m) => m.id),
    [scheduledRows],
  );
  const scheduleSelection = useInboxRowSelection(scheduleSelectableIds);

  const selectedScheduledRows = useMemo(
    () => scheduledRows.filter((m) => scheduleSelection.selectedIds.has(m.id)),
    [scheduledRows, scheduleSelection.selectedIds],
  );

  const counts = useMemo(() => countThreads(local), [local]);

  const emailThreads = useMemo(() => {
    if (!embeddedInCommunication) return local;
    return filterEmailInboxThreads(local, { keepSmsLike: !smsUiEnabled });
  }, [embeddedInCommunication, local, smsUiEnabled]);

  const emailCounts = useMemo(() => countThreads(emailThreads), [emailThreads]);

  const tabs = useMemo(
    () => [
      ...INBOX_TAB_DEFS.map(({ id, label }) => ({
        id,
        label,
        count: id === "schedule" ? scheduledRows.length : emailCounts[id as keyof typeof emailCounts],
      })),
    ],
    [emailCounts, scheduledRows.length],
  );

  const tabCountsForParent = useMemo<ResidentInboxTabCounts>(
    () => ({
      unopened: emailCounts.unopened,
      opened: emailCounts.opened,
      schedule: scheduledRows.length,
      sent: emailCounts.sent,
      trash: emailCounts.trash,
    }),
    [emailCounts, scheduledRows.length],
  );

  useEffect(() => {
    if (embeddedInCommunication) onTabCountsChange?.(tabCountsForParent);
  }, [embeddedInCommunication, onTabCountsChange, tabCountsForParent]);

  const baseRowsForTab = useMemo(() => {
    if (tabId === "all") return emailThreads.filter((t) => t.folder !== "trash");
    if (tabId === "unopened")
      return emailThreads.filter((t) => t.folder === "inbox" && (t.unread || retainedIds.has(t.id)));
    if (tabId === "opened") return emailThreads.filter((t) => t.folder === "inbox" && !t.unread);
    if (tabId === "sent") return emailThreads.filter((t) => t.folder === "sent");
    if (tabId === "trash") return emailThreads.filter((t) => t.folder === "trash");
    return [];
  }, [emailThreads, tabId, retainedIds]);

  const rowsForTab = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return baseRowsForTab;
    return baseRowsForTab.filter((t) =>
      [t.from, t.email, t.subject, t.body, t.preview].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [baseRowsForTab, searchQuery]);

  // Returning to Unopened (or refreshing) shows the true unread set.
  useEffect(() => {
    setRetainedIds(new Set());
  }, [tabId]);

  const threadRowIds = useMemo(() => rowsForTab.map((t) => t.id), [rowsForTab]);
  const threadSelection = useInboxRowSelection(threadRowIds);

  const scheduledBodyById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const message of scheduledRows) m[message.id] = message.body;
    return m;
  }, [scheduledRows]);

  const toggleScheduledCancelled = useCallback(
    async (id: string, cancelled: boolean) => {
      try {
        const res = await fetch(`/api/portal/scheduled-inbox-messages/${encodeURIComponent(id)}?as=resident`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ cancelled, senderPortal: "resident" }),
        });
        if (!res.ok) throw new Error("Could not update scheduled message.");
        showToast(cancelled ? "Scheduled message cancelled." : "Scheduled message restored.");
        void reloadScheduledMessages();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not update scheduled message.");
      }
    },
    [reloadScheduledMessages, showToast],
  );

  /**
   * Persist a read/unread flip.
   *
   * This used to be `setLocal` only, so the flag lived in React state and
   * nothing ever reached the server: reading a thread cleared the badge until
   * the next reload, when the row came back unread. That is why the resident
   * unread count only ever grew. Mirrors `moveToTrash` — stage locally, write
   * through, roll back if the write fails.
   *
   * `notify` is supplied only by the user-initiated flips, and its toast is
   * decided by the OUTCOME: announcing success up-front left "Marked as read"
   * on screen while the rollback put the unread dot straight back. The silent
   * auto-mark-read path passes nothing and stays silent.
   */
  const persistUnreadFlag = useCallback(
    (id: string, unread: boolean, notify?: { success: string; failure: string }) => {
      void runInboxMutation(async () => {
        persistInboxRef.current = false;
        try {
          const prev = loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK) as InboxThread[];
          const target = prev.find((t) => t.id === id);
          if (!target || target.folder !== "inbox") {
            if (notify) showToast(notify.failure);
            return;
          }
          if (target.unread === unread) {
            if (notify) showToast(notify.success);
            return;
          }
          const updated: InboxThread = { ...target, unread };
          const next = prev.map((t) => (t.id === id ? updated : t));
          stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, next);
          setLocal(next);
          const ok = await upsertPersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, [updated], next);
          if (!ok) {
            stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, prev);
            setLocal(prev);
            if (notify) showToast(notify.failure);
            return;
          }
          if (notify) showToast(notify.success);
        } finally {
          persistInboxRef.current = true;
        }
      });
    },
    [showToast],
  );

  const markRead = (id: string) => {
    setRetainedIds((prev) => new Set(prev).add(id));
    persistUnreadFlag(id, false, {
      success: "Marked as read. Moves to Opened after refresh.",
      failure: "Could not mark message as read.",
    });
  };

  const markReadSilent = useCallback(
    (id: string) => {
      setRetainedIds((prev) => new Set(prev).add(id));
      persistUnreadFlag(id, false);
    },
    [persistUnreadFlag],
  );

  const markUnread = useCallback(
    (id: string) => {
      persistUnreadFlag(id, true, {
        success: "Marked as unread.",
        failure: "Could not mark message as unread.",
      });
    },
    [persistUnreadFlag],
  );

  function inferPreviousFolder(t: InboxThread): "inbox" | "sent" {
    if (t.previousFolder) return t.previousFolder;
    if (/^(sent_|msg_|welcome_)/.test(t.id)) return "sent";
    return "inbox";
  }

  const moveToTrash = useCallback(
    (id: string) => {
      void runInboxMutation(async () => {
        persistInboxRef.current = false;
        try {
          const prev = loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK) as InboxThread[];
          const target = prev.find((t) => t.id === id);
          if (!target || target.folder === "trash" || (target.folder !== "inbox" && target.folder !== "sent")) return;
          const updated: InboxThread = {
            ...target,
            folder: "trash",
            previousFolder: target.folder,
            unread: false,
          };
          const next = prev.map((t) => (t.id === id ? updated : t));
          stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, next);
          setLocal(next);
          setExpandedId(null);
          const ok = await upsertPersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, [updated], next);
          if (!ok) {
            stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, prev);
            setLocal(prev);
            showToast("Could not move message to trash.");
            return;
          }
          showToast("Moved to trash.");
        } finally {
          persistInboxRef.current = true;
        }
      });
    },
    [showToast],
  );

  const restoreFromTrash = useCallback(
    (id: string) => {
      void runInboxMutation(async () => {
        persistInboxRef.current = false;
        try {
          const prev = loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, RESIDENT_INBOX_THREAD_FALLBACK) as InboxThread[];
          const target = prev.find((t) => t.id === id && t.folder === "trash");
          if (!target) return;
          const dest = inferPreviousFolder(target);
          const updated: InboxThread = {
            ...target,
            folder: dest,
            previousFolder: undefined,
            unread: dest === "inbox" ? target.unread : false,
          };
          const next = prev.map((t) => (t.id === id ? updated : t));
          stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, next);
          setLocal(next);
          setExpandedId(null);
          const ok = await upsertPersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, [updated], next);
          if (!ok) {
            stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, prev);
            setLocal(prev);
            showToast("Could not restore message.");
            return;
          }
          showToast("Restored.");
        } finally {
          persistInboxRef.current = true;
        }
      });
    },
    [showToast],
  );

  const deleteForever = useCallback(
    (id: string) => {
      void (async () => {
        invalidatePersistedInboxCache(RESIDENT_INBOX_STORAGE_KEY);
        const ok = await deleteInboxThreadIds([id]);
        if (!ok) {
          showToast("Could not delete message.");
          return;
        }
        const next = local.filter((t) => t.id !== id);
        persistInboxRef.current = false;
        setLocal(next);
        setExpandedId(null);
        await persistInboxAwait(RESIDENT_INBOX_STORAGE_KEY, next);
        const deletedIds = new Set([id]);
        const synced = await syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY, { force: true, excludeIds: deletedIds });
        setLocal((synced as InboxThread[]).filter((t) => !deletedIds.has(t.id)));
        persistInboxRef.current = true;
        showToast("Deleted permanently.");
      })();
    },
    [local, showToast],
  );

  const emptyTrash = useCallback(async () => {
    const trashItems = local.filter((t) => t.folder === "trash");
    if (trashItems.length === 0) {
      showToast("Archive is already empty.");
      return;
    }
    if (!(await confirm({ description: `Delete all ${trashItems.length} trash message${trashItems.length === 1 ? "" : "s"}? This cannot be undone.` }))) return;
    void (async () => {
      invalidatePersistedInboxCache(RESIDENT_INBOX_STORAGE_KEY);
      const ids = trashItems.map((t) => t.id).filter(Boolean);
      const ok = await deleteInboxThreadIds(ids);
      if (!ok) {
        showToast("Could not empty trash.");
        return;
      }
      const next = local.filter((t) => t.folder !== "trash");
      persistInboxRef.current = false;
      setLocal(next);
      setExpandedId(null);
      await persistInboxAwait(RESIDENT_INBOX_STORAGE_KEY, next);
      const deletedIds = new Set(ids);
      const synced = await syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY, { force: true, excludeIds: deletedIds });
      setLocal((synced as InboxThread[]).filter((t) => !deletedIds.has(t.id)));
      persistInboxRef.current = true;
      showToast("Archive cleared.");
    })().catch(() => showToast("Could not empty trash."));
  }, [local, showToast]);

  const findThreadForRecipient = useCallback((email: string) => {
    const norm = email.trim().toLowerCase();
    const collapsed = collapsePersonInboxThreads(localRef.current, { mergeFolders: true });
    return collapsed.find((t) => inboxThreadCounterpartyEmail(t) === norm)?.id ?? null;
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      openCompose: (draft?: ResidentComposePrefill) => {
        if (draft) setComposeDraft(draft);
        setComposeOpen(true);
      },
      emptyTrash,
      findThreadForRecipient,
    }),
    [emptyTrash, findThreadForRecipient],
  );

  const handleComposeSend = useCallback(
    async (p: ScopedInboxSendPayload): Promise<boolean> => {
      const senderName = p.senderName.trim() || "Resident";
      const senderEmail = session.email?.trim().toLowerCase() || p.senderEmail;
      let optimisticId: string | null = null;

      try {
          if (p.scheduleLater && p.sendAt) {
            const recipientEmail = p.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean)[0];
            if (!recipientEmail) {
              showToast("Choose your property manager.");
              return false;
            }
            const contact = eligibleContacts.find((c) => c.email.trim().toLowerCase() === recipientEmail);
            const res = await fetch("/api/portal/scheduled-inbox-messages", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                subject: p.subject.trim(),
                body: p.body.trim(),
                sendAt: p.sendAt,
                recipientEmail,
                recipientName: contact?.name?.trim() || recipientEmail,
                senderPortal: "resident",
              }),
            });
            const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            if (!res.ok || !data.ok) {
              showToast(data.error ?? "Could not schedule message.");
              return false;
            }
            showToast("Message scheduled.");
            void reloadScheduledMessages();
            if (!embeddedInCommunication) {
              navigate("/resident/communication/email/schedule");
            }
            setComposeOpen(false);
            setComposeDraft(null);
            return true;
          }

          const directEmails = p.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean);
          const primaryRecipient =
            directEmails.length === 1 && p.broadcastCategories.length === 0 ? directEmails[0]! : null;
          let propertyThreadId: string | undefined;

          if (primaryRecipient) {
            const optimistic = buildOptimisticSentThread({
              recipientEmail: primaryRecipient,
              subject: p.subject.trim(),
              body: p.body.trim(),
              senderLabel: senderName,
            });
            optimisticId = optimistic.id;
            setPendingSendingThreadIds((prev) => new Set(prev).add(optimistic.id));
            persistInboxRef.current = false;
            setLocal((cur) => [optimistic as InboxThread, ...cur]);
            setExpandedId(optimistic.id);
          }

          if (p.includesDirectoryRecipients) {
            const res = await fetch("/api/portal/send-inbox-message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                fromName: senderName,
                fromEmail: senderEmail,
                toEmails: p.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean),
                toBroadcast: p.broadcastCategories,
                subject: p.subject.trim(),
                text: p.body.trim(),
                deliverToPortalInbox: true,
                eventCategory: "messages",
                senderPortal: "resident",
                propertyId: p.propertyId,
                propertyTitle: p.propertyTitle,
                managerUserId: p.managerUserId,
                sendId: p.sendId,
              }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
              propertyThreadId?: string;
            };
            if (!res.ok || !data.ok) {
              if (optimisticId) {
                setPendingSendingThreadIds((prev) => {
                  const next = new Set(prev);
                  next.delete(optimisticId!);
                  return next;
                });
                // Take the optimistic conversation back out. Clearing only the
                // "sending" flag left a refused message sitting in the list as a
                // delivered thread; re-arm persistence on the way out so the
                // inbox does not stop saving for the rest of the session.
                setLocal((cur) => cur.filter((t) => t.id !== optimisticId));
                setExpandedId(null);
                persistInboxRef.current = true;
              }
              showToast(data.error ?? "Message could not be sent.");
              return false;
            }
            propertyThreadId = data.propertyThreadId?.trim() || undefined;
          }
          if (optimisticId) {
            setPendingSendingThreadIds((prev) => {
              const next = new Set(prev);
              next.delete(optimisticId!);
              return next;
            });
          }
          invalidatePersistedInboxCache(RESIDENT_INBOX_STORAGE_KEY);
          const rows = await syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY, { force: true });
          setLocal(rows as InboxThread[]);
          persistInboxRef.current = true;
          showToast("Message sent.");
          if (embeddedInCommunication) {
            if (propertyThreadId) {
              setExpandedId(propertyThreadId);
            } else if (primaryRecipient) {
              const threadId = findThreadForRecipient(primaryRecipient);
              if (threadId) setExpandedId(threadId);
            }
          } else {
            navigate("/resident/communication/email/sent");
          }
          setComposeOpen(false);
          setComposeDraft(null);
          return true;
      } catch {
        if (optimisticId) {
          const failedOptimisticId = optimisticId;
          setPendingSendingThreadIds((prev) => {
            const next = new Set(prev);
            next.delete(failedOptimisticId);
            return next;
          });
          setLocal((cur) => cur.filter((thread) => thread.id !== failedOptimisticId));
          setExpandedId((current) => current === failedOptimisticId ? null : current);
        }
        persistInboxRef.current = true;
        showToast("Message could not be sent.");
        return false;
      }
    },
    [eligibleContacts, embeddedInCommunication, findThreadForRecipient, navigate, reloadScheduledMessages, session.email, setExpandedId, showToast],
  );

  const activeSmsAvailable = smsUiEnabled && smsConfigured;

  const handleReply = useCallback(
    async (
      row: PortalInboxTableRow,
      text: string,
      channels: { email: boolean; sms: boolean; proplane?: boolean },
      attachmentUrls: string[] = [],
    ) => {
      const thread = localRef.current.find((t) => t.id === row.id);
      if (!thread) return;
      const replyToEmail = resolveResidentReplyRecipientEmail(thread.email, eligibleContacts);
      const portalRecipient = !replyToEmail.includes("@")
        ? null
        : { toEmails: [replyToEmail.trim().toLowerCase()] };
      const proplaneAllowed = Boolean(channels.proplane && portalRecipient);
      if (!proplaneAllowed && !channels.email && !channels.sms) throw new InboxSendRefusal(null);
      const replyId = `reply-${Date.now().toString(36)}`;
      const attachmentMeta = attachmentMetaFromUrls(attachmentUrls);
      const reply: InboxThreadMessage = {
        id: replyId,
        from: "Resident",
        body: text,
        at: formatInboxStamp(new Date()),
        outbound: true,
        delivery: "sending",
        attachments: attachmentMeta.length ? attachmentMeta : undefined,
      };
      const updated = appendReplyToInboxThread(thread, reply);
      // Show the bubble immediately, but keep it LOCAL: persisting before the
      // server accepts is what made a refused send look delivered — the row
      // reached the thread store, so the conversation list previewed it as
      // "You: …" and a reload showed it as an ordinary sent message. Nothing is
      // written until a channel actually succeeds.
      persistInboxRef.current = false;
      setLocal((cur) => cur.map((t) => (t.id === thread.id ? updated : t)));
      // Take back ONLY this reply, off whatever the thread looks like now. A
      // whole-row restore would discard an inbound message that landed in the
      // same thread mid-send — the lost update this change exists to prevent.
      const rollbackReply = () => {
        setLocal((cur) =>
          cur.map((t) => {
            if (t.id !== thread.id) return t;
            const messages = (t.messages ?? []).filter((m) => m.id !== replyId);
            // Nothing else moved in this thread, so restore every field the
            // optimistic append touched — messages, preview, time AND unread.
            // Leaving `time` advanced would keep a refused send floating the
            // thread to the top of a list that sorts on it, stamped with an
            // activity that never happened.
            if (messages.length === (thread.messages ?? []).length) {
              return {
                ...t,
                messages,
                preview: thread.preview,
                time: thread.time,
                unread: thread.unread,
              };
            }
            const last = messages[messages.length - 1];
            return {
              ...t,
              messages,
              preview: last ? last.body.slice(0, 100).replace(/\n/g, " ") : thread.preview,
              time: last?.at ?? thread.time,
            };
          }),
        );
      };
      const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;
      // These record what a channel ACTUALLY did, never what was requested — the
      // caller's toast reads them, and once either is true the reply IS
      // delivered, so no later error may withdraw the bubble or report a failure.
      let emailOk = false;
      let smsOk = false;
      let proplaneOk = false;
      let failureMessage = "";
      // One window, one exit contract: the "sending" bubble and the disabled
      // persist flag can never outlive this call, including when a fetch REJECTS
      // (offline, aborted, DNS) rather than answering.
      try {
        try {
          if (proplaneAllowed) {
            const result = await sendPropLaneAssistantInboxMessage({
              threadId: thread.id,
              subject,
              text,
              fromName: "Resident",
              senderPortal: "resident",
              attachmentUrls,
              toEmails: portalRecipient?.toEmails,
            });
            proplaneOk = result.ok;
            if (!result.ok) {
              failureMessage = result.error ?? "";
              throw new InboxSendRefusal(failureMessage.trim() || null);
            }
          }
          if (channels.email) {
            const res = await fetch("/api/portal/send-inbox-message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                threadId: thread.id,
                subject,
                text,
                toEmails: [replyToEmail],
                deliverToPortalInbox: true,
                deliverViaEmail: true,
                deliverViaSms: false,
                senderPortal: "resident",
                attachmentUrls: attachmentUrls.length ? attachmentUrls : undefined,
              }),
            });
            const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            emailOk = res.ok && data.ok === true;
            if (!emailOk) {
              failureMessage = data.error ?? "";
              throw new InboxSendRefusal(failureMessage.trim() || null);
            }
          }
          if (channels.sms && activeSmsAvailable) {
            const res = await fetch("/api/portal/send-inbox-message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                threadId: thread.id,
                subject,
                text,
                toEmails: [replyToEmail],
                deliverToPortalInbox: false,
                deliverViaEmail: false,
                deliverViaSms: true,
                senderPortal: "resident",
                attachmentUrls: attachmentUrls.length ? attachmentUrls : undefined,
              }),
            });
            const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            smsOk = res.ok && data.ok === true;
            if (!smsOk && !emailOk) {
              failureMessage = data.error ?? "";
              throw new InboxSendRefusal(failureMessage.trim() || null);
            }
          }
          if (!emailOk && !smsOk && !proplaneOk) throw new InboxSendRefusal(failureMessage.trim() || null);
        } catch (e) {
          if (!emailOk && !smsOk && !proplaneOk) {
            rollbackReply();
            throw e;
          }
          // Delivered on another channel, so this cannot be reported as a failed
          // send — but a client-side fault here would otherwise vanish entirely.
          console.warn("[resident-inbox] reply send error after delivery", e);
        }

        // Delivered on at least one channel — only now may it enter the store,
        // merged onto the CURRENT row so a mid-send arrival survives. Everything
        // from here is bookkeeping over a message that WAS sent, so a failure
        // must never reach the resident as a failed send: the explicit upsert is
        // the write we trust, and the forced sync below runs unconditionally as
        // the reconciliation.
        const currentRows = localRef.current;
        const currentThread = currentRows.find((t) => t.id === thread.id);
        if (currentThread) {
          const withReply = (currentThread.messages ?? []).some((m) => m.id === replyId)
            ? currentThread
            : appendReplyToInboxThread(currentThread, reply);
          const delivered = markThreadMessageDelivery(withReply, replyId, undefined);
          const persisted = currentRows.map((t) => (t.id === thread.id ? delivered : t));
          setLocal(persisted);
          await upsertPersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, [delivered], persisted).catch(() => false);
        }
      } finally {
        persistInboxRef.current = true;
      }
      void syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY, { force: true }).catch(() => {});
      return {
        emailRequested: channels.email,
        smsRequested: channels.sms,
        proplaneRequested: proplaneAllowed,
        emailOk,
        smsOk,
        proplaneOk,
      };
    },
    [activeSmsAvailable, eligibleContacts],
  );

  const threadActionBtn = embeddedInCommunication ? "min-h-0 rounded-full px-3 py-1.5 text-xs" : PORTAL_DETAIL_BTN;

  const renderExtraActions = useCallback(
    (row: PortalInboxTableRow) => {
      if (embeddedInCommunication) return null;
      if (tabId === "schedule") {
        const message = scheduledRows.find((item) => item.id === row.id);
        const cancelled = message?.status === "cancelled";
        if (message?.status === "sending") {
          return <span className="text-xs font-medium text-amber-700">Sending / needs review</span>;
        }
        return (
          <>
            {message?.status === "scheduled" ? (
              <Button
                type="button"
                variant="outline"
                className={PORTAL_DETAIL_BTN}
                onClick={() => {
                  void (async () => {
                    try {
                      await sendManualScheduledMessageNow(row.id, { asResident: true });
                      showToast("Message sent.");
                      void reloadScheduledMessages();
                    } catch (e) {
                      showToast(e instanceof Error ? e.message : "Could not send message.");
                    }
                  })();
                }}
              >
                Send now
              </Button>
            ) : null}
            <Button
              type="button"
              variant={cancelled ? "outline" : "danger"}
              className={PORTAL_DETAIL_BTN}
              onClick={() => toggleScheduledCancelled(row.id, !cancelled)}
            >
              {cancelled ? "Restore" : "Cancel send"}
            </Button>
          </>
        );
      }
      if (tabId === "trash") {
        return (
          <>
            <Button type="button" variant="outline" className={PORTAL_DETAIL_BTN} onClick={() => restoreFromTrash(row.id)}>
              Restore
            </Button>
            <Button
              type="button"
              variant="danger"
              className={PORTAL_DETAIL_BTN}
              onClick={() => deleteForever(row.id)}
            >
              Delete forever
            </Button>
          </>
        );
      }
      if (tabId === "opened" || tabId === "all") {
        return (
          <>
            {tabId === "opened" ? (
              <Button type="button" variant="outline" className={threadActionBtn} onClick={() => markUnread(row.id)}>
                Mark unread
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              className={threadActionBtn}
              data-attr="inbox-thread-archive"
              onClick={() => moveToTrash(row.id)}
            >
              Archive
            </Button>
          </>
        );
      }
      return (
        <Button
          type="button"
          variant="outline"
          className={threadActionBtn}
          data-attr="inbox-thread-archive"
          onClick={() => moveToTrash(row.id)}
        >
          Archive
        </Button>
      );
    },
    [tabId, scheduledRows, toggleScheduledCancelled, moveToTrash, restoreFromTrash, deleteForever, markUnread, reloadScheduledMessages, showToast, embeddedInCommunication, threadActionBtn],
  );

  const bulkScheduleSendNow = async () => {
    const targets = selectedScheduledRows.filter((m) => m.status === "scheduled");
    if (targets.length === 0) return;
    setBulkBusy(true);
    try {
      let ok = 0;
      for (const message of targets) {
        try {
          await sendManualScheduledMessageNow(message.id, { asResident: true });
          ok += 1;
        } catch {
          /* continue */
        }
      }
      showToast(ok === 1 ? "Message sent." : `Sent ${ok} messages.`);
      scheduleSelection.clearSelection();
      void reloadScheduledMessages();
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkScheduleCancel = async () => {
    const targets = selectedScheduledRows.filter((m) => m.status === "scheduled");
    for (const message of targets) {
      await toggleScheduledCancelled(message.id, true);
    }
    scheduleSelection.clearSelection();
  };

  const bulkScheduleRestore = async () => {
    const targets = selectedScheduledRows.filter((m) => m.status === "cancelled");
    for (const message of targets) {
      await toggleScheduledCancelled(message.id, false);
    }
    scheduleSelection.clearSelection();
  };

  const bulkMarkRead = () => {
    for (const id of threadSelection.selectedIds) markRead(id);
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

  const bulkDeleteForever = async () => {
    if (!(await confirm({ description: `Delete ${threadSelection.selectedIds.size} message(s) permanently?` }))) return;
    for (const id of threadSelection.selectedIds) deleteForever(id);
    threadSelection.clearSelection();
  };

  const bulkMarkUnread = () => {
    for (const id of threadSelection.selectedIds) markUnread(id);
    threadSelection.clearSelection();
  };

  const activeThread = useMemo(
    () =>
      resolveCommunicationInboxThread(
        expandedId,
        emailThreads,
        local,
        "resident",
        session.userId,
      ),
    [expandedId, emailThreads, local, session.userId],
  );

  const activeProplaneAvailable = Boolean(activeThread);
  const showReplyChannelPicker = Boolean(activeThread);

  // The manager this conversation is with: name, home and how to reach them.
  // A resident can hold conversations with several managers, so this is
  // resolved per thread, never once for the page.
  const managerContacts = useResidentManagerContacts();
  const activeManager = useMemo(
    () => (activeThread ? resolveResidentThreadManager(activeThread, managerContacts) : null),
    [activeThread, managerContacts],
  );
  const activeManagerContact = useMemo(
    () => (activeThread ? matchResidentManagerContact(activeThread.email, managerContacts) : undefined),
    [activeThread, managerContacts],
  );

  /**
   * The embedded thread's icon actions, the manager's row shape: reach the
   * manager (text / email), mark unread, archive. An archived conversation
   * offers restore and delete instead.
   */
  const embeddedThreadHeaderActions = useMemo(() => {
    if (!activeThread) return undefined;
    if (activeThread.folder === "trash") {
      return (
        <>
          <button
            type="button"
            className={INBOX_THREAD_ICON_BTN}
            aria-label="Restore conversation"
            title="Restore"
            data-attr="inbox-thread-restore"
            onClick={() => restoreFromTrash(activeThread.id)}
          >
            <ArchiveRestore className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            className={INBOX_THREAD_ICON_BTN_DANGER}
            aria-label="Delete conversation"
            title="Delete"
            data-attr="inbox-thread-delete"
            onClick={() => deleteForever(activeThread.id)}
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </>
      );
    }
    const managerPhone = activeManager?.workPhone?.trim() || activeManagerContact?.phone?.trim() || null;
    const managerEmail = activeManagerContact?.email?.trim() || null;
    // A text-only conversation is derived and read-only: reach the manager by
    // text, nothing to mark unread or archive.
    if (activeThread.smsOnly) {
      return managerPhone ? (
        <a
          href={`sms:${managerPhone}`}
          className={INBOX_THREAD_ICON_BTN}
          aria-label="Text your property manager"
          title="Text your property manager"
          data-attr="inbox-thread-text-manager"
        >
          <Phone className="h-4 w-4" aria-hidden />
        </a>
      ) : undefined;
    }
    return (
      <>
        {managerPhone ? (
          <a
            href={`sms:${managerPhone}`}
            className={INBOX_THREAD_ICON_BTN}
            aria-label="Text your property manager"
            title="Text your property manager"
            data-attr="inbox-thread-text-manager"
          >
            <Phone className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
        {managerEmail ? (
          <a
            href={`mailto:${managerEmail}`}
            className={INBOX_THREAD_ICON_BTN}
            aria-label="Email your property manager"
            title="Email your property manager"
            data-attr="inbox-thread-email-manager"
          >
            <Mail className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
        <button
          type="button"
          className={INBOX_THREAD_ICON_BTN}
          aria-label="Mark unread"
          title="Mark unread"
          data-attr="inbox-thread-mark-unread"
          disabled={activeThread.folder !== "inbox" || activeThread.unread}
          onClick={() => markUnread(activeThread.id)}
        >
          <MailOpen className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          className={INBOX_THREAD_ICON_BTN}
          aria-label="Archive conversation"
          title="Archive"
          data-attr="inbox-thread-archive"
          onClick={() => moveToTrash(activeThread.id)}
        >
          <Archive className="h-4 w-4" aria-hidden />
        </button>
      </>
    );
  }, [activeThread, activeManager, activeManagerContact, restoreFromTrash, deleteForever, moveToTrash, markUnread]);

  useEffect(() => {
    if (!embeddedInCommunication) return;
    const person = resolveCommunicationPersonThreadReplyChannels({
      emailAvailable: true,
      smsAvailable: activeSmsAvailable,
      lastInboundChannel: activeThread ? lastInboundChannelOf(activeThread) : null,
    });
    setReplyViaProplane(person.viaProplane);
    setReplyViaEmail(person.viaEmail);
    setReplyViaSms(person.viaSms);
  }, [activeSmsAvailable, activeThread, embeddedInCommunication, expandedId]);

  const autoMarkReadAttemptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!activeThread || activeThread.folder !== "inbox" || !activeThread.unread) return;
    if (autoMarkReadAttemptedRef.current.has(activeThread.id)) return;
    autoMarkReadAttemptedRef.current.add(activeThread.id);
    markReadSilent(activeThread.id);
  }, [activeThread?.id, activeThread?.folder, activeThread?.unread, markReadSilent]);

  useEffect(() => {
    updateReplyDraft("");
  }, [expandedId, updateReplyDraft]);

  // The avatar and title are the MANAGER's, whichever side sent the last turn.
  const activeThreadAvatarName = activeManager?.name;
  // "Property manager · Cascade Lofts · work@email" — the manager's header
  // line (Resident · House, Room · email) turned around: who they are to the
  // resident, the home it is about, and the address they write from.
  const activeThreadSubtitle = activeManager
    ? [
        activeManager.workspaceName ?? "Property manager",
        activeManager.homeLabel,
        // A text-only conversation has no address: the work number is how to reach them.
        activeThread?.smsOnly ? formatSmsPhoneLabel(activeManager.workPhone) : activeManager.email,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const activeFolder = activeThread
    ? activeThread.folder === "trash"
      ? inferPreviousFolder(activeThread)
      : activeThread.folder
    : "inbox";

  const activeBubbles = useMemo((): InboxBubbleMessage[] => {
    if (!activeThread) return [];
    const pendingRoot = pendingSendingThreadIds.has(activeThread.id);
    let lastShownSubject = "";
    return inboxThreadMessages(activeThread).map((m, i) => {
      const direction = inboxTurnDirection(activeThread, m, i, activeFolder);
      const delivery =
        m.delivery ?? (pendingRoot && i === 0 && direction === "outbound" ? ("sending" as const) : undefined);
      const fields = inboxEmailBubbleFields(
        {
          body: m.body,
          subject: m.subject ?? (i === 0 ? activeThread.subject : undefined),
          channel: m.channel,
        },
        lastShownSubject,
      );
      lastShownSubject = fields.lastShownSubject;
      return {
        id: m.id,
        automated: m.automated,
        eventTitle: m.subject,
        author: m.from,
        body: fields.body,
        at: m.at,
        direction,
        delivery,
        channel: m.channel,
        houseLabel: m.houseLabel,
        ...(fields.subject ? { subject: fields.subject } : {}),
        attachments: m.attachments,
      } satisfies InboxBubbleMessage;
    });
  }, [activeThread, activeFolder, pendingSendingThreadIds]);

  // Scheduled messages the resident has queued to this conversation's manager —
  // shown inline as compact cards. Residents may cancel, but not
  // edit content (the resident scheduled-message route only patches status).
  const [scheduledBusyId, setScheduledBusyId] = useState<string | null>(null);

  const threadScheduledItems = useMemo(
    () => (activeThread ? scheduledItemsForRecipient(activeThread.email, scheduledMessages, []) : []),
    [activeThread, scheduledMessages],
  );

  const cancelResidentScheduled = useCallback(
    async (id: string) => {
      setScheduledBusyId(id);
      try {
        await toggleScheduledCancelled(id, true);
      } finally {
        setScheduledBusyId(null);
      }
    },
    [toggleScheduledCancelled],
  );

  const residentScheduledCards =
    activeThread && activeThread.folder !== "trash" && threadScheduledItems.length > 0 ? (
          <InboxScheduledThreadList
            placement="bar"
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
                deliverViaInbox={item.deliverViaInbox}
                deliverViaEmail={item.deliverViaEmail}
                deliverViaSms={item.deliverViaSms}
                source={item.source}
                editable={false}
                busy={scheduledBusyId === item.id}
                recipient={activeThread.email}
                sendAt={item.sendAt}
                onCancel={() => { if (item.deliveryStatus !== "sending") void cancelResidentScheduled(item.id); }}
              />
            ))}
          </InboxScheduledThreadList>
    ) : null;

  const openThread = useCallback(
    (thread: InboxThread) => {
      setExpandedId(thread.id);
      if (thread.folder === "inbox" && thread.unread) markReadSilent(thread.id);
    },
    [markReadSilent],
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

  // One channel control per decision: the reply row's menu — In-app · Email ·
  // Text, as the manager's thread has it.
  const replyChannelMenu = (
    <InboxComposerChannelMenu
      viaEmail={replyViaEmail}
      viaSms={replyViaSms}
      viaProplane={replyViaProplane}
      onViaProplaneChange={setReplyViaProplane}
      onViaEmailChange={setReplyViaEmail}
      onViaSmsChange={setReplyViaSms}
      emailAvailable
      smsAvailable={activeSmsAvailable}
      proplaneAvailable={activeProplaneAvailable}
    />
  );

  const sendActiveReply = useCallback(async () => {
    if (!activeThread || activeThread.smsOnly) return;
    const text = replyDraft.trim();
    const attachmentUrls = replyAttachments
      .filter((a) => a.uploadUrl && !a.uploading && !a.error)
      .map((a) => a.uploadUrl!);
    if (!text && attachmentUrls.length === 0) return;
    const viaProplane = replyViaProplane && activeProplaneAvailable;
    const viaEmail = replyViaEmail || !activeSmsAvailable;
    const viaSms = replyViaSms && activeSmsAvailable;
    if (!hasInboxReplyChannelSelected({ viaEmail, viaSms, viaProplane })) {
      showToast("Choose In-app, Email, Text, or a combination.");
      return;
    }
    if (replyAttachments.some((a) => a.uploading)) {
      showToast("Wait for attachments to finish uploading.");
      return;
    }

    // The clock is on: this same press SCHEDULES the reply rather than sending
    // it, so there is one send button and no second way to fire the message.
    if (scheduleLater) {
      if (attachmentUrls.length > 0) {
        showToast("Scheduled replies do not support attachments yet. Remove them or send now.");
        return;
      }
      const sendAt = new Date(scheduleSendAt);
      if (Number.isNaN(sendAt.getTime())) {
        showToast("Choose a valid send date and time.");
        return;
      }
      if (sendAt.getTime() < Date.now() - 60_000) {
        showToast("Send time must be in the future.");
        return;
      }
      const recipientEmail = resolveResidentReplyRecipientEmail(activeThread.email, eligibleContacts)
        .trim()
        .toLowerCase();
      if (!recipientEmail.includes("@")) {
        showToast("Choose your property manager.");
        return;
      }
      setReplySending(true);
      try {
        const res = await fetch("/api/portal/scheduled-inbox-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            senderPortal: "resident",
            subject: activeThread.subject || `Message for ${activeManager?.name ?? recipientEmail}`,
            body: text,
            sendAt: sendAt.toISOString(),
            recipientEmail,
            recipientName: activeManager?.name ?? recipientEmail,
            deliverViaInbox: viaProplane,
            deliverViaEmail: viaEmail,
            deliverViaSms: viaSms,
          }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          showToast(payload?.error ?? "Could not schedule message.");
          return;
        }
        // Clear the reply only on success, so a refused schedule never loses
        // what the resident typed.
        updateReplyDraft("");
        setScheduleLater(false);
        showToast("Message scheduled.");
        void reloadScheduledMessages();
      } catch {
        showToast("Could not schedule message.");
      } finally {
        setReplySending(false);
      }
      return;
    }

    setReplySending(true);
    try {
      const outcome = await handleReply(
        {
          id: activeThread.id,
          name: activeThread.from,
          email: activeThread.email,
          subject: activeThread.subject,
          whenLabel: activeThread.time,
          read: !activeThread.unread,
        },
        text,
        { email: viaEmail, sms: viaSms, proplane: viaProplane },
        attachmentUrls,
      );
      if (!outcome) {
        showToast("Could not send reply.");
        return;
      }
      updateReplyDraft("");
      setReplyAttachments((prev) => {
        prev.forEach(revokeInboxAttachmentPreview);
        return [];
      });
      showToast(residentReplySentToastMessage(outcome));
    } catch (e) {
      // Say WHY when the server told us — "you can only message people connected
      // to your account" is actionable; "could not send" reads as a glitch worth
      // retrying. The draft stays in the box either way.
      const reason = e instanceof InboxSendRefusal ? e.reason : null;
      showToast(reason ?? "Could not send reply.");
    } finally {
      setReplySending(false);
    }
  }, [
    activeManager,
    activeProplaneAvailable,
    activeSmsAvailable,
    activeThread,
    eligibleContacts,
    handleReply,
    reloadScheduledMessages,
    replyAttachments,
    replyDraft,
    replyViaEmail,
    replyViaProplane,
    replyViaSms,
    scheduleLater,
    scheduleSendAt,
    showToast,
    updateReplyDraft,
  ]);

  // The resident's reply row is the manager's minus every assistant tool: no ✦
  // draft, no Ask PropLane, no Auto-send. Attachment, the clock, the channel
  // menu and Send — that is all.
  const activeThreadComposer = useMemo(() => {
    if (!activeThread || activeThread.folder === "trash" || tabId === "trash") return undefined;
    // A text-only conversation has no in-app send: the composer is replaced by
    // one action that opens the resident's own texting app to the work number.
    if (activeThread.smsOnly) {
      const workPhone = activeManager?.workPhone?.trim();
      if (!workPhone) return undefined;
      return (
        <div className="shrink-0 border-t border-border p-3">
          <a
            href={`sms:${workPhone}`}
            className="flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:opacity-90"
            data-attr="resident-inbox-text-manager"
          >
            <MessageSquare className="h-4 w-4 shrink-0" aria-hidden />
            Text {formatSmsPhoneLabel(workPhone) ?? workPhone}
          </a>
        </div>
      );
    }
    return (
      <InboxComposer
        value={replyDraft}
        onChange={updateReplyDraft}
        onSubmit={() => void sendActiveReply()}
        sending={replySending}
        disabled={
          !hasInboxReplyChannelSelected({
            viaEmail: replyViaEmail || !activeSmsAvailable,
            viaSms: replyViaSms && activeSmsAvailable,
            viaProplane: replyViaProplane && activeProplaneAvailable,
          })
        }
        placeholder={
          !embeddedInCommunication && replyViaSms && !replyViaEmail
            ? "Text message"
            : "Write a reply…"
        }
        maxLength={
          !embeddedInCommunication && replyViaSms && !replyViaEmail ? 1600 : undefined
        }
        dataAttr="resident-inbox-reply"
        focusSignal={replyFocusSignal}
        hint={
          scheduleLater
            ? `Send schedules this reply for ${new Date(scheduleSendAt).toLocaleString("en-US", {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })}.`
            : undefined
        }
        trailingControls={
          <>
            <InboxComposerScheduleMenu
              scheduleLater={scheduleLater}
              onScheduleLaterChange={setScheduleLater}
              sendAt={scheduleSendAt}
              onSendAtChange={setScheduleSendAt}
            />
            {showReplyChannelPicker ? replyChannelMenu : null}
          </>
        }
        attachments={replyAttachments}
        onAttachmentsPick={pickReplyAttachments}
        onAttachmentRemove={(id) => {
          setReplyAttachments((prev) => {
            const target = prev.find((a) => a.id === id);
            if (target) revokeInboxAttachmentPreview(target);
            return prev.filter((a) => a.id !== id);
          });
        }}
        maxAttachments={INBOX_MAX_ATTACHMENTS}
      />
    );
  }, [
    activeManager,
    activeProplaneAvailable,
    activeSmsAvailable,
    activeThread,
    embeddedInCommunication,
    pickReplyAttachments,
    replyAttachments,
    replyChannelMenu,
    replyDraft,
    replyFocusSignal,
    replySending,
    replyViaEmail,
    replyViaProplane,
    replyViaSms,
    scheduleLater,
    scheduleSendAt,
    sendActiveReply,
    showReplyChannelPicker,
    tabId,
    updateReplyDraft,
  ]);

  const emptyCopy =
    tabId === "trash"
      ? "No trash messages yet."
      : tabId === "schedule"
        ? scheduledLoading
          ? "Loading scheduled messages…"
          : "No scheduled messages yet."
        : tabId === "sent"
          ? "No sent messages yet."
          : tabId === "opened"
            ? "No opened messages yet."
            : "No messages yet.";

  const inboxBody = (
    <>
      {embeddedInCommunication && !externalTitleActions ? (
        <div className="mb-4 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="primary" className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`} onClick={() => setComposeOpen(true)}>
            New message
          </Button>
        </div>
      ) : null}
      <ScopedInboxComposeModal
        open={composeOpen}
        onClose={() => {
          setComposeOpen(false);
          setComposeDraft(null);
        }}
        onSend={handleComposeSend}
        portal="resident"
        senderName="Resident"
        senderEmail={session.email?.trim().toLowerCase() || "resident@example.com"}
        liveContacts={eligibleContacts}
        initialDraft={composeDraft}
      />

      {tabId !== "schedule" && !suppressListPane ? (
        <PortalListToolbar
          search={{
            value: searchQuery,
            onChange: setSearchQuery,
            placeholder: "Search messages",
            dataAttr: "resident-inbox-search",
          }}
        />
      ) : null}

      {tabId === "schedule" ? (
        scheduledRows.length === 0 ? (
          <PortalInboxEmptyState title={emptyCopy} />
        ) : (
          <div className="space-y-3">
            <PortalInboxSelectionToolbar count={scheduleSelection.selectedIds.size} onClear={scheduleSelection.clearSelection}>
              <Button type="button" variant="primary" className="rounded-full" disabled={bulkBusy} onClick={() => bulkScheduleSendNow()}>
                Send now
              </Button>
              <Button type="button" variant="outline" className="rounded-full" disabled={bulkBusy} onClick={() => bulkScheduleCancel()}>
                Cancel send
              </Button>
              <Button type="button" variant="outline" className="rounded-full" disabled={bulkBusy} onClick={() => bulkScheduleRestore()}>
                Restore send
              </Button>
            </PortalInboxSelectionToolbar>
            <PortalInboxMessageTable
              rows={scheduledToRows(scheduledRows)}
              layout="schedule"
              primaryPartyHeader="Recipient"
              getDetailBody={(row) => scheduledBodyById[row.id]}
              onReply={undefined}
              expandedId={expandedId}
              onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
              renderExtraActions={renderExtraActions}
              selection={{
                selectedIds: scheduleSelection.selectedIds,
                onToggleSelected: scheduleSelection.toggleSelected,
                onToggleSelectAll: scheduleSelection.toggleSelectAll,
                allSelected: scheduleSelection.allSelected,
                selectableCount: scheduleSelectableIds.length,
              }}
            />
          </div>
        )
      ) : suppressListPane ? (
        <div className={pageScroll ? "flex flex-col" : "flex h-full min-h-0 flex-1 flex-col overflow-hidden"}>
          {activeThread ? (
            <InboxThreadView
              scrollMode={pageScroll ? "page" : "pane"}
              title={activeManager?.name ?? "Property manager"}
              avatarName={activeThreadAvatarName}
              subtitle={activeThreadSubtitle}
              messages={activeBubbles}
              underHeader={residentScheduledCards}
              threadKey={activeThread.id}
              onBack={() => setExpandedId(null)}
              headerActions={
                embeddedInCommunication
                  ? embeddedThreadHeaderActions
                  : renderExtraActions({
                      id: activeThread.id,
                      name: activeThread.from,
                      email: activeThread.email,
                      subject: activeThread.subject,
                      whenLabel: activeThread.time,
                      read: !activeThread.unread,
                    })
              }
              emptyLabel="No messages in this conversation."
              composer={activeThreadComposer}
            />
          ) : (
            <InboxThreadEmpty />
          )}
        </div>
      ) : rowsForTab.length === 0 ? (
        <PortalInboxEmptyState title={emptyCopy} />
      ) : (
        <InboxTwoPane
          threadOpen={Boolean(activeThread)}
          list={
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 space-y-2 border-b border-border p-2.5">
                <PortalInboxSelectionToolbar count={threadSelection.selectedIds.size} onClear={threadSelection.clearSelection}>
                  {tabId === "unopened" ? (
                    <>
                      <Button type="button" variant="outline" className="rounded-full" onClick={bulkMarkRead}>
                        Mark read
                      </Button>
                      <Button type="button" variant="outline" className="rounded-full" onClick={bulkMoveToTrash}>
                        Archive
                      </Button>
                    </>
                  ) : null}
                  {tabId === "opened" ? (
                    <>
                      <Button type="button" variant="outline" className="rounded-full" onClick={bulkMarkUnread}>
                        Mark unread
                      </Button>
                      <Button type="button" variant="outline" className="rounded-full" onClick={bulkMoveToTrash}>
                        Archive
                      </Button>
                    </>
                  ) : null}
                  {tabId === "sent" ? (
                    <Button type="button" variant="outline" className="rounded-full" onClick={bulkMoveToTrash}>
                      Archive
                    </Button>
                  ) : null}
                  {tabId === "trash" ? (
                    <>
                      <Button type="button" variant="outline" className="rounded-full" onClick={bulkRestoreFromTrash}>
                        Restore
                      </Button>
                      <Button type="button" variant="outline" className="rounded-full text-rose-700" onClick={bulkDeleteForever}>
                        Delete forever
                      </Button>
                    </>
                  ) : null}
                </PortalInboxSelectionToolbar>
              </div>
              <div className={INBOX_LIST_SCROLL}>
                {rowsForTab.map((thread) => {
                  // Every row names the manager (or workspace) it is with, never the generic "Property manager" / "Resident" label.
                  const rowManagerName = resolveResidentThreadManager(thread, managerContacts).name;
                  const displayName = rowManagerName;
                  const msgs = inboxThreadMessages(thread);
                  const lastMsg = msgs[msgs.length - 1];
                  return (
                    <InboxConversationRow
                      key={thread.id}
                      name={displayName}
                      subtitle={thread.subject}
                      preview={previewLine(lastMsg?.body ?? thread.preview ?? "", 80)}
                      previewPrefix={inboxThreadLastTurnDirection(thread) === "outbound" ? "You: " : undefined}
                      time={thread.time}
                      unread={thread.folder === "inbox" && thread.unread}
                      selected={expandedId === thread.id}
                      onOpen={() => openThread(thread)}
                      leading={
                        <RowSelectCheckbox
                          checked={threadSelection.selectedIds.has(thread.id)}
                          onChange={() => threadSelection.toggleSelected(thread.id)}
                          aria-label={`Select message ${thread.subject}`}
                        />
                      }
                    />
                  );
                })}
              </div>
            </div>
          }
          thread={
            activeThread ? (
              <InboxThreadView
                scrollMode={pageScroll ? "page" : "pane"}
                title={activeManager?.name ?? "Property manager"}
                avatarName={activeThreadAvatarName}
                subtitle={activeThreadSubtitle}
                messages={activeBubbles}
                underHeader={residentScheduledCards}
                threadKey={activeThread.id}
                onBack={() => setExpandedId(null)}
                headerActions={
                  embeddedInCommunication
                    ? embeddedThreadHeaderActions
                    : renderExtraActions({
                        id: activeThread.id,
                        name: activeThread.from,
                        email: activeThread.email,
                        subject: activeThread.subject,
                        whenLabel: activeThread.time,
                        read: !activeThread.unread,
                      })
                }
                emptyLabel="No messages in this conversation."
                composer={activeThreadComposer}
              />
            ) : (
              <InboxThreadEmpty />
            )
          }
        />
      )}
    </>
  );

  if (embeddedInCommunication) {
    return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">{inboxBody}</div>;
  }

  return (
    <ManagerPortalPageShell
      title="Communication"
      titleAside={
        <>
          <Button type="button" variant="primary" className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`} onClick={() => setComposeOpen(true)}>
            New message
          </Button>
          {tabId === "trash" && counts.trash > 0 ? (
            <div className={PORTAL_PAGE_ACTIONS_DESKTOP}>
              <Button
                type="button"
                variant="outline"
                className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} text-[var(--status-overdue-fg)]`}
                onClick={emptyTrash}
              >
                Empty archive
              </Button>
            </div>
          ) : null}
        </>
      }
      filterRow={
        <ManagerPortalFilterRow>
          <LocalDestinationNav
            appearance="command"
            items={tabs.map((tab) => ({
              id: tab.id,
              label: tab.label,
              count: tab.count,
            }))}
            activeId={tabId}
            onChange={() => navigate(`/resident/communication/email/`)}
            ariaLabel="Inbox folders"
          />
          {tabId === "trash" && counts.trash > 0 ? (
            <div className={PORTAL_FILTER_ACTIONS_MOBILE}>
              <Button type="button" variant="outline" className={PORTAL_HEADER_ACTION_BTN} onClick={emptyTrash}>
                Empty
              </Button>
            </div>
          ) : null}
        </ManagerPortalFilterRow>
      }
    >
      {inboxBody}
    </ManagerPortalPageShell>
  );
});
