"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { Button } from "@/components/ui/button";
import { ScopedInboxComposeModal, type ScopedInboxSendPayload } from "@/components/portal/inbox-scoped-compose-modal";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { INBOX_TAB_DEFS, INBOX_LIST_SCROLL, AiDraftReplyCard, InboxBubbleMessage, InboxComposer, InboxConversationRow, InboxReplyChannelPicker, InboxScheduledCard, InboxScheduledThreadList, InboxThreadEmpty, InboxThreadView, InboxTwoPane, PortalInboxEmptyState, PortalInboxMessageTable, type PortalInboxTableRow } from "@/components/portal/portal-inbox-ui";
import {
  buildInboxThreadAssistantContext,
  InboxThreadAssistantStrip,
} from "@/components/portal/inbox-thread-assistant-strip";
import { scheduledItemsForRecipient } from "@/lib/inbox-scheduled-thread";
import {
  PortalInboxSelectionToolbar,
  sendManualScheduledMessageNow,
  useInboxRowSelection,
} from "@/components/portal/portal-inbox-selection";
import { ManagerPortalPageShell, ManagerPortalStatusPills, ManagerPortalFilterRow, PORTAL_FILTER_ACTIONS_MOBILE, PORTAL_HEADER_ACTION_BTN, PORTAL_PAGE_ACTIONS_DESKTOP } from "@/components/portal/portal-metrics";
import { PortalListToolbar } from "@/components/portal/portal-list-toolbar";
import { PORTAL_DETAIL_BTN } from "@/components/portal/portal-data-table";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import { resolveCommunicationInboxThread } from "@/lib/communication-assistant-inbox-list";
import { demoResidentInboxThreads } from "@/data/demo-portal";
import { usePortalSession } from "@/hooks/use-portal-session";
import { isUpcomingScheduledInboxMessage, type ScheduledInboxMessageRecord } from "@/lib/scheduled-inbox-messages";
import { resolvePropLaneUnifiedReplyChannels } from "@/lib/manager-inbox-reply-channels";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import {
  hasInboxReplyChannelSelected,
  resolveAssistantInboxReplyChannels,
} from "@/lib/manager-inbox-reply-channels";
import { sendPropLaneAssistantInboxMessage } from "@/lib/assistant-inbox-reply";

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
  inboxMessageOutbound,
  appendReplyToInboxThread,
  formatInboxStamp,
  collapsePersonInboxThreads,
  inboxThreadCounterpartyEmail,
  type InboxThreadMessage,
} from "@/lib/portal-inbox-storage";
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

/**
 * A send the SERVER refused, carrying the server's own reason on a typed field.
 * Only this class's `reason` is ever shown to the resident: inferring it from
 * `Error.message` echoed unexpected client-side exceptions into a user toast.
 */
class InboxSendRefusal extends Error {
  readonly reason: string | null;
  constructor(reason: string | null) {
    super(reason ?? "inbox send refused");
    this.name = "InboxSendRefusal";
    this.reason = reason;
  }
}

/**
 * What each channel ACTUALLY did. The reply toast is built from this, never from
 * the channels the resident asked for: telling someone their text message went
 * out when the SMS leg failed is the same "shown as delivered when it wasn't"
 * defect as persisting a refused reply.
 */
export type ResidentReplySendOutcome = {
  emailRequested: boolean;
  smsRequested: boolean;
  emailOk: boolean;
  smsOk: boolean;
};

export function residentReplySentToastMessage(outcome: ResidentReplySendOutcome): string {
  const emailDelivered = outcome.emailRequested && outcome.emailOk;
  const smsDelivered = outcome.smsRequested && outcome.smsOk;
  if (!emailDelivered && !smsDelivered) return "Could not send reply.";
  const emailFailed = outcome.emailRequested && !outcome.emailOk;
  const smsFailed = outcome.smsRequested && !outcome.smsOk;
  if (smsFailed) return "Reply sent via email. Text message failed.";
  if (emailFailed) return "Reply sent via text. Email failed.";
  if (emailDelivered && smsDelivered) return "Reply sent via email and text.";
  if (smsDelivered) return "Reply sent via text.";
  return "Reply sent.";
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
  const [replyDraft, setReplyDraft] = useState("");
  const [replySending, setReplySending] = useState(false);
  const [replyViaEmail, setReplyViaEmail] = useState(true);
  const [replyViaSms, setReplyViaSms] = useState(false);
  const [replyViaProplane, setReplyViaProplane] = useState(false);
  const [autoSend, setAutoSend] = useState(false);
  const [replyAttachments, setReplyAttachments] = useState<InboxComposerAttachment[]>([]);
  const [aiDraftText, setAiDraftText] = useState("");
  const [aiDrafting, setAiDrafting] = useState(false);
  const [aiDraftError, setAiDraftError] = useState<string | null>(null);
  const [approvingAiDraft, setApprovingAiDraft] = useState(false);
  const [smsConfigured, setSmsConfigured] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeDraft, setComposeDraft] = useState<ResidentComposePrefill | null>(null);
  const [composeScheduleLater, setComposeScheduleLater] = useState(false);
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
    setReplyDraft("");
    setAiDraftText("");
    setAiDraftError(null);
    setAiDrafting(false);
    setApprovingAiDraft(false);
    if (!embeddedInCommunication) {
      setReplyViaEmail(true);
      setReplyViaSms(false);
    }
    setReplyAttachments((prev) => {
      prev.forEach(revokeInboxAttachmentPreview);
      return [];
    });
  }, [embeddedInCommunication, expandedId]);

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
    return filterEmailInboxThreads(local);
  }, [embeddedInCommunication, local]);

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

  const emptyTrash = useCallback(() => {
    const trashItems = local.filter((t) => t.folder === "trash");
    if (trashItems.length === 0) {
      showToast("Archive is already empty.");
      return;
    }
    if (!window.confirm(`Delete all ${trashItems.length} trash message${trashItems.length === 1 ? "" : "s"}? This cannot be undone.`)) return;
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

  const openScheduleForThread = useCallback(
    (thread: InboxThread) => {
      const email = (inboxThreadCounterpartyEmail(thread) || thread.email).trim().toLowerCase();
      if (!email) {
        showToast("Choose your property manager.");
        return;
      }
      void loadEligibleContacts();
      const contact = eligibleContacts.find((c) => c.email.trim().toLowerCase() === email);
      const subjectBase = thread.subject?.trim() || "";
      setComposeDraft({
        subject: subjectBase && !/^re:/i.test(subjectBase) ? `Re: ${subjectBase}` : subjectBase,
        body: "",
        recipientEmail: email,
        managerUserId: contact?.id?.replace(/^mgr-/, ""),
      });
      setComposeScheduleLater(true);
      setComposeOpen(true);
    },
    [eligibleContacts, loadEligibleContacts, showToast],
  );

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
    (p: ScopedInboxSendPayload) => {
      setComposeOpen(false);
      setComposeDraft(null);
      const senderName = p.senderName.trim() || "Resident";
      const senderEmail = session.email?.trim().toLowerCase() || p.senderEmail;

      void (async () => {
        try {
          if (p.scheduleLater && p.sendAt) {
            const recipientEmail = p.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean)[0];
            if (!recipientEmail) {
              showToast("Choose your property manager.");
              return;
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
              return;
            }
            showToast("Message scheduled.");
            void reloadScheduledMessages();
            if (!embeddedInCommunication) {
              navigate("/resident/communication/email/schedule");
            }
            return;
          }

          const directEmails = p.directRecipientEmailLine.split(";").map((e) => e.trim()).filter(Boolean);
          const primaryRecipient =
            directEmails.length === 1 && p.broadcastCategories.length === 0 ? directEmails[0]! : null;
          let optimisticId: string | null = null;
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
              return;
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
        } catch {
          persistInboxRef.current = true;
          showToast("Message could not be sent.");
        }
      })();
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
      const assistantThread = isPropLaneAssistantInboxThread(thread);
      const replyToEmail = resolveResidentReplyRecipientEmail(thread.email, eligibleContacts);
      const portalRecipient =
        assistantThread || !replyToEmail.includes("@")
          ? null
          : { toEmails: [replyToEmail.trim().toLowerCase()] };
      const proplaneAllowed = Boolean(
        channels.proplane && (assistantThread || portalRecipient),
      );
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
          if (!emailOk && !smsOk) {
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
      return { emailRequested: channels.email, smsRequested: channels.sms, emailOk, smsOk };
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

  const bulkDeleteForever = () => {
    if (!window.confirm(`Delete ${threadSelection.selectedIds.size} message(s) permanently?`)) return;
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

  const activeIsAssistantThread = Boolean(
    activeThread && isPropLaneAssistantInboxThread(activeThread),
  );
  const activeProplaneAvailable = Boolean(activeThread);
  const showReplyChannelPicker = Boolean(activeThread);

  useEffect(() => {
    if (activeIsAssistantThread) {
      const next = resolveAssistantInboxReplyChannels({
        emailAvailable: true,
        smsAvailable: activeSmsAvailable,
      });
      setReplyViaProplane(next.viaProplane);
      setReplyViaEmail(next.viaEmail);
      setReplyViaSms(next.viaSms);
      return;
    }
    if (!embeddedInCommunication) return;
    const unified = resolvePropLaneUnifiedReplyChannels({
      emailAvailable: true,
      smsAvailable: activeSmsAvailable,
    });
    setReplyViaProplane(false);
    setReplyViaEmail(unified.viaEmail);
    setReplyViaSms(unified.viaSms);
  }, [activeIsAssistantThread, activeSmsAvailable, embeddedInCommunication, expandedId]);

  const autoMarkReadAttemptedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!activeThread || activeThread.folder !== "inbox" || !activeThread.unread) return;
    if (autoMarkReadAttemptedRef.current.has(activeThread.id)) return;
    autoMarkReadAttemptedRef.current.add(activeThread.id);
    markReadSilent(activeThread.id);
  }, [activeThread?.id, activeThread?.folder, activeThread?.unread, markReadSilent]);

  useEffect(() => {
    setReplyDraft("");
  }, [expandedId]);

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
      const outbound = inboxMessageOutbound(m, i, activeFolder, activeThread);
      const delivery =
        m.delivery ?? (pendingRoot && i === 0 && outbound ? ("sending" as const) : undefined);
      return {
        id: m.id,
        author: m.from,
        body: m.body,
        at: m.at,
        direction: outbound ? "outbound" : "inbound",
        delivery,
        channel: "email",
        attachments: m.attachments,
      } satisfies InboxBubbleMessage;
    });
  }, [activeThread, activeFolder, pendingSendingThreadIds]);

  // Scheduled messages the resident has queued to this conversation's manager —
  // shown inline as compact cards. Residents may cancel or send now, but not
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

  const sendResidentScheduledNow = useCallback(
    async (id: string) => {
      setScheduledBusyId(id);
      try {
        await sendManualScheduledMessageNow(id, { asResident: true });
        showToast("Message sent.");
        void reloadScheduledMessages();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not send message.");
      } finally {
        setScheduledBusyId(null);
      }
    },
    [reloadScheduledMessages, showToast],
  );

  const residentScheduledCards =
    activeThread && activeThread.folder !== "trash" && !embeddedInCommunication ? (
      <div className="space-y-2 pt-1">
        {threadScheduledItems.length > 0 ? (
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
                source={item.source}
                editable={false}
                busy={scheduledBusyId === item.id}
                recipient={activeThread.email}
                sendAt={item.sendAt}
                onCancel={() => void cancelResidentScheduled(item.id)}
                onSendNow={() => void sendResidentScheduledNow(item.id)}
              />
            ))}
          </InboxScheduledThreadList>
        ) : null}
        {tabId !== "trash" ? (
          <Button
            type="button"
            variant="outline"
            className="h-8 min-h-0 w-full rounded-full px-3 text-[12px]"
            data-attr="resident-inbox-schedule-another"
            onClick={() => openScheduleForThread(activeThread)}
          >
            Schedule a message
          </Button>
        ) : null}
      </div>
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

  const replyChannelPicker = (
    <InboxReplyChannelPicker
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

  const sendActiveReply = useCallback(async (textOverride?: string) => {
    if (!activeThread) return;
    const text = (textOverride ?? replyDraft).trim();
    const attachmentUrls = replyAttachments
      .filter((a) => a.uploadUrl && !a.uploading && !a.error)
      .map((a) => a.uploadUrl!);
    if (!text && attachmentUrls.length === 0) return;
    const viaProplane = replyViaProplane && activeProplaneAvailable;
    const viaEmail = activeIsAssistantThread
      ? replyViaEmail
      : replyViaEmail || !activeSmsAvailable;
    const viaSms = replyViaSms && activeSmsAvailable;
    if (!hasInboxReplyChannelSelected({ viaEmail, viaSms, viaProplane })) {
      showToast("Choose PropLane, Email, SMS, or a combination.");
      return;
    }
    if (replyAttachments.some((a) => a.uploading)) {
      showToast("Wait for attachments to finish uploading.");
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
      if (textOverride) {
        setAiDraftText("");
        setAiDraftError(null);
      } else {
        setReplyDraft("");
      }
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
    activeIsAssistantThread,
    activeProplaneAvailable,
    activeSmsAvailable,
    activeThread,
    handleReply,
    replyAttachments,
    replyDraft,
    replyViaEmail,
    replyViaProplane,
    replyViaSms,
    showToast,
  ]);

  const requestResidentAiDraft = useCallback(async () => {
    if (!activeThread || isDemoModeActive()) return;
    setAiDrafting(true);
    setAiDraftError(null);
    try {
      const res = await fetch("/api/portal/resident-inbox-draft-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ threadId: activeThread.id }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        skip?: boolean;
        draft?: { text?: string };
        error?: string;
      };
      if (data.ok && data.draft?.text) {
        setAiDraftText(data.draft.text);
      } else if (!data.ok && data.error) {
        setAiDraftError(data.error);
      } else if (data.ok && data.skip) {
        setAiDraftError("Nothing to draft from this thread yet.");
      }
    } catch {
      setAiDraftError("Could not draft reply.");
    } finally {
      setAiDrafting(false);
    }
  }, [activeThread]);

  const approveResidentAiDraft = useCallback(async () => {
    const text = aiDraftText.trim();
    if (!text) return;
    setApprovingAiDraft(true);
    try {
      await sendActiveReply(text);
    } finally {
      setApprovingAiDraft(false);
    }
  }, [aiDraftText, sendActiveReply]);

  const discardResidentAiDraft = useCallback(() => {
    setAiDraftText("");
    setAiDraftError(null);
  }, []);

  const autoSentAiDraftRef = useRef<string | null>(null);

  useEffect(() => {
    autoSentAiDraftRef.current = null;
  }, [activeThread?.id]);

  useEffect(() => {
    if (!autoSend || !aiDraftText.trim() || !activeThread) return;
    if (aiDrafting || approvingAiDraft || replySending) return;
    const key = `${activeThread.id}:${aiDraftText.trim()}`;
    if (autoSentAiDraftRef.current === key) return;
    autoSentAiDraftRef.current = key;
    void approveResidentAiDraft().then(() => {
      /* sent or failed in sendActiveReply */
    });
  }, [
    activeThread,
    aiDraftText,
    aiDrafting,
    approvingAiDraft,
    approveResidentAiDraft,
    autoSend,
    replySending,
  ]);

  const showResidentAiDraftUi = Boolean(
    activeThread &&
      activeThread.folder !== "trash" &&
      tabId !== "trash" &&
      ((activeThread.messages ?? []).length > 0 || Boolean(activeThread.body?.trim())),
  );

  const activeThreadComposer = useMemo(() => {
    if (!activeThread || activeThread.folder === "trash" || tabId === "trash") return undefined;
    return (
      <>
        {showResidentAiDraftUi ? (
          <AiDraftReplyCard
            drafting={aiDrafting}
            draft={aiDraftText.trim() ? aiDraftText : undefined}
            onDraftChange={setAiDraftText}
            error={aiDraftError ?? undefined}
            approving={approvingAiDraft || replySending}
            onApprove={() => void approveResidentAiDraft()}
            onDiscard={discardResidentAiDraft}
            onGenerate={() => void requestResidentAiDraft()}
            generateLabel="Draft with AI"
            channelControl={showReplyChannelPicker ? replyChannelPicker : undefined}
            autoSend={autoSend}
            onAutoSendChange={setAutoSend}
            maxLength={
              !embeddedInCommunication && replyViaSms && !replyViaEmail ? 1600 : undefined
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
        />
        <InboxComposer
          value={replyDraft}
          onChange={setReplyDraft}
          onSubmit={() => void sendActiveReply()}
          sending={replySending}
          disabled={
            !hasInboxReplyChannelSelected({
              viaEmail: activeIsAssistantThread
                ? replyViaEmail
                : replyViaEmail || !activeSmsAvailable,
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
          channelControl={showReplyChannelPicker ? replyChannelPicker : undefined}
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
          autoSend={autoSend}
          onAutoSendChange={setAutoSend}
        />
      </>
    );
  }, [
    activeIsAssistantThread,
    activeIsSent,
    activeProplaneAvailable,
    activeSmsAvailable,
    activeThread,
    aiDraftError,
    aiDraftText,
    aiDrafting,
    approvingAiDraft,
    autoSend,
    discardResidentAiDraft,
    embeddedInCommunication,
    approveResidentAiDraft,
    pickReplyAttachments,
    replyAttachments,
    replyChannelPicker,
    replyDraft,
    replySending,
    replyViaEmail,
    replyViaProplane,
    replyViaSms,
    requestResidentAiDraft,
    sendActiveReply,
    showReplyChannelPicker,
    showResidentAiDraftUi,
    tabId,
  ]);

  useEffect(() => {
    if (!autoSend) return;
    if (activeIsAssistantThread) {
      if (!replyViaProplane) setReplyViaProplane(true);
      return;
    }
    if (!replyViaEmail && !replyViaSms) {
      setReplyViaEmail(true);
      if (activeSmsAvailable) setReplyViaSms(true);
    }
  }, [activeIsAssistantThread, activeSmsAvailable, autoSend, replyViaEmail, replyViaProplane, replyViaSms]);

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
          setComposeScheduleLater(false);
        }}
        onSend={handleComposeSend}
        portal="resident"
        senderName="Resident"
        senderEmail={session.email?.trim().toLowerCase() || "resident@example.com"}
        liveContacts={eligibleContacts}
        initialDraft={composeDraft}
        initialScheduleLater={composeScheduleLater}
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
              title={
                activeIsSent
                  ? activeThread.email || "Unknown recipient"
                  : activeThread.from || activeThread.email || "Unknown sender"
              }
              subtitle={activeThread.subject || (activeIsSent ? undefined : activeThread.email)}
              messages={activeBubbles}
              afterMessages={residentScheduledCards}
              threadKey={activeThread.id}
              onBack={() => setExpandedId(null)}
              headerActions={
                embeddedInCommunication
                  ? undefined
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
                  const sentSemantics = tabId === "sent";
                  const recipientLabel = thread.email || "Unknown recipient";
                  const displayName = sentSemantics ? recipientLabel : thread.from || thread.email || "Unknown sender";
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
                      leading={
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 rounded border-border accent-primary"
                          checked={threadSelection.selectedIds.has(thread.id)}
                          onChange={() => threadSelection.toggleSelected(thread.id)}
                          onClick={(e) => e.stopPropagation()}
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
                title={
                  activeIsSent
                    ? activeThread.email || "Unknown recipient"
                    : activeThread.from || activeThread.email || "Unknown sender"
                }
                subtitle={activeThread.subject || (activeIsSent ? undefined : activeThread.email)}
                messages={activeBubbles}
                afterMessages={residentScheduledCards}
                threadKey={activeThread.id}
                onBack={() => setExpandedId(null)}
                headerActions={
                  embeddedInCommunication
                    ? undefined
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
      title="Inbox"
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
          <ManagerPortalStatusPills
            activeTone="primary"
            tabs={tabs}
            activeId={tabId}
            onChange={(id) => navigate(`/resident/communication/email/`)}
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
