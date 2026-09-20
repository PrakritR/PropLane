"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { usePortalSession } from "@/hooks/use-portal-session";
import { Button } from "@/components/ui/button";
import { ScopedInboxComposeModal, type ScopedInboxSendPayload } from "@/components/portal/inbox-scoped-compose-modal";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { appendPortalMessageToAdminInbox } from "@/lib/demo-admin-partner-inbox";
import { Archive, ArchiveRestore, MailOpen, Trash2 } from "lucide-react";
import { INBOX_THREAD_ICON_BTN, INBOX_THREAD_ICON_BTN_DANGER, INBOX_TAB_DEFS, InboxBubbleMessage, InboxComposer, InboxThreadEmpty, InboxThreadView, PortalInboxEmptyState, PortalInboxMessageTable, inboxTabEmptyCopy, type PortalInboxTableRow } from "@/components/portal/portal-inbox-ui";
import {
  PortalInboxSelectionToolbar,
  useInboxRowSelection,
} from "@/components/portal/portal-inbox-selection";
import { ManagerPortalPageShell, ManagerPortalStatusPills, ManagerPortalFilterRow, PORTAL_FILTER_ACTIONS_MOBILE, PORTAL_HEADER_ACTION_BTN, PORTAL_PAGE_ACTIONS_DESKTOP } from "@/components/portal/portal-metrics";
import { PortalListToolbar } from "@/components/portal/portal-list-toolbar";
import { PORTAL_DETAIL_BTN } from "@/components/portal/portal-data-table";
import { buildInboxThreadAssistantContext, InboxThreadAssistantStrip } from "@/components/portal/inbox-thread-assistant-strip";
import { InboxComposerAiMenu, InboxComposerChannelMenu } from "@/components/portal/inbox-composer-tools";
import { INBOX_MAX_ATTACHMENTS, attachmentMetaFromUrls, createPendingInboxAttachment, uploadInboxAttachment, type InboxComposerAttachment } from "@/lib/inbox-attachments";
import { markThreadMessageDelivery } from "@/lib/inbox-message-timeline";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import {
  appendReplyToInboxThread,
  deleteInboxThreadIds,
  inboxMutationInFlight,
  inboxThreadMessages,
  inboxMessageOutbound,
  invalidatePersistedInboxCache,
  loadPersistedInbox,
  PORTAL_INBOX_CHANGED_EVENT,
  runInboxMutation,
  stagePersistedInboxRows,
  syncPersistedInboxFromServer,
  syncPersistedInboxFromServerWithStatus,
  upsertPersistedInboxRows,
  VENDOR_INBOX_STORAGE_KEY,
  inboxThreadSortMs,
  formatInboxStamp,
  type InboxThreadMessage,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { portalSessionViewerId } from "@/lib/auth/portal-session-gate";
import { observeCommunicationInitialViewer, retryStaleCommunicationSource } from "@/lib/communication-initial-load";
import { inboxEmailBubbleFields } from "@/lib/inbox-email-display";
import { inboxTurnDirection, isConversationWithPropLaneAssistant } from "@/lib/inbox-turn-direction";
import {
  InboxSendRefusal,
  inboxReplySentToastMessage,
} from "@/lib/inbox-reply-outcome";
import { resolvePropLaneUnifiedReplyChannels } from "@/lib/manager-inbox-reply-channels";

type InboxThread = PersistedInboxThread;

const VENDOR_INBOX_FALLBACK: PersistedInboxThread[] = [];

function toRows(list: InboxThread[]): PortalInboxTableRow[] {
  // Display semantics come from the ROW's own folder, not the active tab — the
  // unified "all" list mixes inbox (show sender) and sent (show recipient) rows.
  return list.map((t) => {
    const isSent = t.folder === "sent";
    return {
      id: t.id,
      name: isSent ? t.email || "Unknown recipient" : t.from,
      email: isSent ? (t.from ? `From ${t.from}` : "") : t.email,
      subject: t.subject,
      whenLabel: t.time,
      read: !t.unread,
    };
  });
}

function countThreads(threads: InboxThread[]) {
  return {
    unopened: threads.filter((t) => t.folder === "inbox" && t.unread).length,
    opened: threads.filter((t) => t.folder === "inbox" && !t.unread).length,
    sent: threads.filter((t) => t.folder === "sent").length,
    trash: threads.filter((t) => t.folder === "trash").length,
  };
}

export type VendorInboxPanelHandle = {
  openCompose: () => void;
  emptyArchive: () => void;
};

export type VendorInboxTabCounts = {
  unopened: number;
  opened: number;
  sent: number;
  trash: number;
};

/** Vendor inbox — same portal inbox system as manager/resident, scoped to the vendor's own thread rows. */
export const VendorInboxPanel = forwardRef<
  VendorInboxPanelHandle,
  {
    tabId: string;
    embeddedInCommunication?: boolean;
    externalTitleActions?: boolean;
    /**
     * Server-resolved SMS Communication UI flag. While it is false the SMS panel
     * is hidden, so inbound-SMS notices must FALL THROUGH into the conversation
     * list (`keepSmsLike`) instead of being filtered into a panel nobody can see.
     */
    smsUiEnabled?: boolean;
    onTabCountsChange?: (counts: VendorInboxTabCounts) => void;
    suppressListPane?: boolean;
    controlledExpandedId?: string | null;
    onControlledExpandedIdChange?: (id: string | null) => void;
    pageScroll?: boolean;
  }
>(function VendorInboxPanel(
  {
    tabId,
    embeddedInCommunication = false,
    externalTitleActions = false,
    smsUiEnabled = false,
    onTabCountsChange,
    suppressListPane = false,
    controlledExpandedId,
    onControlledExpandedIdChange,
    pageScroll = false,
  },
  ref,
) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const navigate = usePortalNavigate();
  const session = usePortalSession();
  const demoMode = isDemoModeActive();
  const currentViewerId = session.userId?.trim() || null;
  const currentViewerKey = demoMode
    ? "demo"
    : session.ready && currentViewerId
      ? `viewer:${currentViewerId}`
      : "pending";
  const [local, setLocal] = useState<InboxThread[]>(
    () => demoMode || (currentViewerId && portalSessionViewerId() === currentViewerId)
      ? loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[]
      : [],
  );
  const [localViewerKey, setLocalViewerKey] = useState(currentViewerKey);
  if (localViewerKey !== currentViewerKey) {
    setLocalViewerKey(currentViewerKey);
    setLocal(
      demoMode || (currentViewerId && portalSessionViewerId() === currentViewerId)
        ? loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[]
        : [],
    );
  }
  const localRef = useRef(local);
  useEffect(() => {
    localRef.current = local;
  }, [local]);
  const hydrationGenerationRef = useRef(0);
  const panelViewerIdRef = useRef<string | null>(null);
  const panelMountedRef = useRef(false);
  const operationOwnerRef = useRef({ key: currentViewerKey, generation: 0 });
  if (operationOwnerRef.current.key !== currentViewerKey) {
    operationOwnerRef.current = {
      key: currentViewerKey,
      generation: operationOwnerRef.current.generation + 1,
    };
  }
  const captureOperationOwnership = useCallback(() => {
    const token = operationOwnerRef.current;
    const viewerId = currentViewerId;
    return () =>
      panelMountedRef.current &&
      operationOwnerRef.current.key === token.key &&
      operationOwnerRef.current.generation === token.generation &&
      (demoMode || Boolean(viewerId && portalSessionViewerId() === viewerId));
  }, [currentViewerId, demoMode]);
  const [internalExpandedId, setInternalExpandedId] = useState<string | null>(null);
  const expandedId = controlledExpandedId !== undefined ? controlledExpandedId : internalExpandedId;
  const expandedIdRef = useRef(expandedId);
  expandedIdRef.current = expandedId;
  const conversationOwnerRef = useRef({ id: expandedId, generation: 0 });
  const replyAttemptGenerationRef = useRef(0);
  if (conversationOwnerRef.current.id !== expandedId) {
    conversationOwnerRef.current = { id: expandedId, generation: conversationOwnerRef.current.generation + 1 };
  }
  const captureConversationOwnership = useCallback((id: string | null) => {
    const token = conversationOwnerRef.current;
    const ownsViewer = captureOperationOwnership();
    return () => ownsViewer() && conversationOwnerRef.current.id === id && conversationOwnerRef.current.generation === token.generation;
  }, [captureOperationOwnership]);
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
  const [autoSend, setAutoSend] = useState(false);
  const [replyAttachments, setReplyAttachments] = useState<InboxComposerAttachment[]>([]);
  const [smsConfigured, setSmsConfigured] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  // Threads marked read while viewing "Unopened" stay listed until the tab is
  // switched or the page is refreshed; they only move to "Opened" on reset.
  const [retainedIds, setRetainedIds] = useState<Set<string>>(() => new Set());
  const [eligibleContacts, setEligibleContacts] = useState<InboxScopedContact[]>([]);
  const [vendorIdentity, setVendorIdentity] = useState({ name: "Vendor", email: "vendor@example.com" });
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    panelMountedRef.current = true;
    return () => {
      panelMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setReplyDraft("");
    setReplySending(false);
    if (!embeddedInCommunication) {
      setReplyViaEmail(true);
      setReplyViaSms(false);
    }
    setReplyAttachments([]);
  }, [currentViewerKey, embeddedInCommunication, expandedId]);

  useEffect(() => {
    setComposeOpen(false);
    setSmsConfigured(false);
    setEligibleContacts([]);
    setVendorIdentity({ name: "Vendor", email: "vendor@example.com" });
  }, [currentViewerKey]);

  useEffect(() => {
    if (!smsUiEnabled || isDemoModeActive()) return;
    const ownsOperation = captureOperationOwnership();
    void fetch("/api/vendor/sms-conversations", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => { if (ownsOperation()) setSmsConfigured(Boolean(body?.smsConfigured)); })
      .catch(() => { if (ownsOperation()) setSmsConfigured(false); });
  }, [captureOperationOwnership, currentViewerKey, smsUiEnabled]);

  useEffect(() => {
    if (isDemoModeActive()) return;
    const ownsOperation = captureOperationOwnership();
    let active = true;
    void fetch("/api/portal/inbox-eligible-contacts?portal=vendor", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { contacts: [] }))
      .then((data: { contacts?: InboxScopedContact[] }) => {
        if (active && ownsOperation()) setEligibleContacts(Array.isArray(data.contacts) ? data.contacts : []);
      })
      .catch(() => {
        if (active && ownsOperation()) setEligibleContacts([]);
      });
    return () => {
      active = false;
    };
  }, [captureOperationOwnership, currentViewerKey]);

  useEffect(() => {
    if (isDemoModeActive()) return;
    const ownsOperation = captureOperationOwnership();
    let active = true;
    void fetch("/api/vendor/profile", { credentials: "include" })
      .then((res) => (res.ok ? res.json() : { profile: null }))
      .then((data: { profile?: { name?: string; email?: string } | null }) => {
        if (!active || !ownsOperation() || !data.profile) return;
        const name = String(data.profile.name ?? "").trim();
        const email = String(data.profile.email ?? "").trim();
        if (name || email) setVendorIdentity((prev) => ({ name: name || prev.name, email: email || prev.email }));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [captureOperationOwnership, currentViewerKey]);

  useEffect(() => {
    const generation = ++hydrationGenerationRef.current;
    const viewerId = session.userId?.trim() || null;
    panelViewerIdRef.current = viewerId;

    if (isDemoModeActive()) {
      setLocal(loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[]);
      return;
    }
    if (!session.ready || !viewerId) {
      setLocal([]);
      return;
    }

    let mounted = true;
    const viewer = observeCommunicationInitialViewer(viewerId);
    const isCurrent = () =>
      mounted &&
      generation === hydrationGenerationRef.current &&
      panelViewerIdRef.current === viewerId &&
      viewer.isCurrent() &&
      portalSessionViewerId() === viewerId;

    void retryStaleCommunicationSource(
      () => syncPersistedInboxFromServerWithStatus(VENDOR_INBOX_STORAGE_KEY),
      () => isCurrent() && viewer.canRetry(),
    ).then((result) => {
      if (!isCurrent() || !result.ok || result.stale || inboxMutationInFlight()) return;
      setLocal(loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[]);
    }).catch(() => {
      // Keep the usable snapshot if an unexpected rejection escapes the status
      // loader.
    });

    return () => {
      mounted = false;
      viewer.dispose();
    };
  }, [session.ready, session.userId]);

  useEffect(() => {
    const expectedViewerId = session.userId?.trim() || null;
    const sync = (evt?: Event) => {
      if (evt && evt.type === PORTAL_INBOX_CHANGED_EVENT) {
        const ce = evt as CustomEvent<{ key?: string }>;
        if (ce.detail?.key && ce.detail.key !== VENDOR_INBOX_STORAGE_KEY) return;
      }
      if (
        !isDemoModeActive() &&
        (!session.ready || !expectedViewerId || panelViewerIdRef.current !== expectedViewerId || portalSessionViewerId() !== expectedViewerId)
      ) {
        return;
      }
      setLocal(loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[]);
    };
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    return () => {
      window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, sync as EventListener);
    };
  }, [session.ready, session.userId]);

  const counts = useMemo(() => countThreads(local), [local]);

  const emailThreads = useMemo(() => {
    if (!embeddedInCommunication) return local;
    return filterEmailInboxThreads(local, { keepSmsLike: !smsUiEnabled });
  }, [embeddedInCommunication, local, smsUiEnabled]);

  const emailCounts = useMemo(() => countThreads(emailThreads), [emailThreads]);

  const tabs = useMemo(
    () => [
      ...INBOX_TAB_DEFS.filter(({ id }) => id !== "schedule").map(({ id, label }) => ({
        id,
        label,
        count: emailCounts[id as keyof typeof emailCounts],
      })),
    ],
    [emailCounts],
  );

  const tabCountsForParent = useMemo<VendorInboxTabCounts>(
    () => ({
      unopened: emailCounts.unopened,
      opened: emailCounts.opened,
      sent: emailCounts.sent,
      trash: emailCounts.trash,
    }),
    [emailCounts],
  );

  useEffect(() => {
    if (embeddedInCommunication) onTabCountsChange?.(tabCountsForParent);
  }, [embeddedInCommunication, onTabCountsChange, tabCountsForParent]);

  const baseRowsForTab = useMemo(() => {
    if (tabId === "all")
      return emailThreads
        .filter((t) => t.folder !== "trash")
        .slice()
        .sort((a, b) => inboxThreadSortMs(b.id, b.time) - inboxThreadSortMs(a.id, a.time));
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

  const bodyById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const t of local) m[t.id] = t.body;
    return m;
  }, [local]);

  const persistUnreadFlag = useCallback((id: string, unread: boolean) => {
    void runInboxMutation(async () => {
      const ownsOperation = captureOperationOwnership();
      if (!ownsOperation()) return;
      const previous = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[];
      const target = previous.find((thread) => thread.id === id && thread.folder === "inbox");
      if (!target || target.unread === unread) return;
      const updated = { ...target, unread };
      const next = previous.map((thread) => (thread.id === id ? updated : thread));
      stagePersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, next);
      setLocal(next);
      const ok = await upsertPersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, [updated], next);
      if (!ownsOperation() || ok) return;
      const current = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[];
      const reconciled = current.map((thread) =>
        thread.id === id && thread.unread === unread
          ? { ...thread, unread: target.unread }
          : thread,
      );
      stagePersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, reconciled);
      setLocal(reconciled);
    });
  }, [captureOperationOwnership]);

  const markReadSilent = useCallback((id: string) => {
    setRetainedIds((prev) => new Set(prev).add(id));
    persistUnreadFlag(id, false);
  }, [persistUnreadFlag]);

  const markRead = (id: string) => {
    markReadSilent(id);
    showToast("Marked as read.");
  };

  const markUnread = useCallback(
    (id: string) => {
      persistUnreadFlag(id, true);
      showToast("Marked as unread.");
    },
    [persistUnreadFlag, showToast],
  );

  function inferPreviousFolder(t: InboxThread): "inbox" | "sent" {
    if (t.previousFolder) return t.previousFolder;
    if (/^(sent_|msg_|welcome_)/.test(t.id)) return "sent";
    return "inbox";
  }

  const moveToArchive = useCallback(
    (id: string) => {
      void runInboxMutation(async () => {
          const ownsOperation = captureOperationOwnership();
          if (!ownsOperation()) return;
          const prev = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[];
          const target = prev.find((t) => t.id === id);
          if (!target || target.folder === "trash" || (target.folder !== "inbox" && target.folder !== "sent")) return;
          const updated: InboxThread = { ...target, folder: "trash", previousFolder: target.folder, unread: false };
          const next = prev.map((t) => (t.id === id ? updated : t));
          stagePersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, next);
          setLocal(next);
          setExpandedId(null);
          const ok = await upsertPersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, [updated], next);
          if (!ownsOperation()) return;
          if (!ok) {
            const current = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[];
            const reconciled = current.map((thread) => thread.id === id && thread.folder === "trash" && thread.previousFolder === target.folder
              ? { ...thread, folder: target.folder, previousFolder: target.previousFolder, unread: thread.unread === updated.unread ? target.unread : thread.unread }
              : thread);
            stagePersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, reconciled);
            setLocal(reconciled);
            showToast("Could not move message to trash.");
            return;
          }
          showToast("Moved to trash.");
      });
    },
    [captureOperationOwnership, showToast],
  );

  const restoreFromArchive = useCallback(
    (id: string) => {
      void runInboxMutation(async () => {
          const ownsOperation = captureOperationOwnership();
          if (!ownsOperation()) return;
          const prev = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[];
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
          stagePersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, next);
          setLocal(next);
          setExpandedId(null);
          const ok = await upsertPersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, [updated], next);
          if (!ownsOperation()) return;
          if (!ok) {
            const current = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[];
            const reconciled = current.map((thread) => thread.id === id && thread.folder === dest && thread.previousFolder === undefined
              ? { ...thread, folder: target.folder, previousFolder: target.previousFolder, unread: thread.unread === updated.unread ? target.unread : thread.unread }
              : thread);
            stagePersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, reconciled);
            setLocal(reconciled);
            showToast("Could not restore message.");
            return;
          }
          showToast("Restored.");
      });
    },
    [captureOperationOwnership, showToast],
  );

  const deleteForever = useCallback(
    (id: string) => {
      void (async () => {
        const ownsOperation = captureOperationOwnership();
        if (!ownsOperation()) return;
        invalidatePersistedInboxCache(VENDOR_INBOX_STORAGE_KEY);
        const ok = await deleteInboxThreadIds([id]);
        if (!ownsOperation()) return;
        if (!ok) {
          showToast("Could not delete message.");
          return;
        }
        const next = (loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[]).filter((t) => t.id !== id);
        stagePersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, next);
        setLocal(next);
        setExpandedId(null);
        showToast("Deleted permanently.");
      })();
    },
    [captureOperationOwnership, setExpandedId, showToast],
  );

  const emptyArchive = useCallback(async () => {
    const ownsOperation = captureOperationOwnership();
    if (!ownsOperation()) return;
    const trashItems = local.filter((t) => t.folder === "trash");
    if (trashItems.length === 0) {
      showToast("Archive is already empty.");
      return;
    }
    if (!(await confirm({ description: `Delete all ${trashItems.length} trash message${trashItems.length === 1 ? "" : "s"}? This cannot be undone.` }))) return;
    if (!ownsOperation()) return;
    void (async () => {
      invalidatePersistedInboxCache(VENDOR_INBOX_STORAGE_KEY);
      const ids = trashItems.map((t) => t.id).filter(Boolean);
      const ok = await deleteInboxThreadIds(ids);
      if (!ownsOperation()) return;
      if (!ok) {
        showToast("Could not empty trash.");
        return;
      }
      const deletedIds = new Set(ids);
      const next = (loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[]).filter((t) => !deletedIds.has(t.id));
      stagePersistedInboxRows(VENDOR_INBOX_STORAGE_KEY, next);
      setLocal(next);
      setExpandedId(null);
      showToast("Archive emptied.");
    })().catch(() => { if (ownsOperation()) showToast("Could not empty trash."); });
  }, [captureOperationOwnership, confirm, local, setExpandedId, showToast]);

  useImperativeHandle(
    ref,
    () => ({
      openCompose: () => setComposeOpen(true),
      emptyArchive,
    }),
    [emptyArchive],
  );

  const handleComposeSend = useCallback(
    (p: ScopedInboxSendPayload) => {
      const ownsOperation = captureOperationOwnership();
      if (!ownsOperation()) return;
      if (p.includesAxisAdmin && isDemoModeActive()) {
        appendPortalMessageToAdminInbox({
          role: "vendor",
          name: p.senderName,
          email: p.senderEmail,
          topic: p.subject.trim(),
          body: p.body.trim(),
        });
      }
      setComposeOpen(false);
      void (async () => {
        try {
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
              eventCategory: "messages",
              senderPortal: "vendor",
            }),
          });
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean };
          if (!ownsOperation()) return;
          if (!res.ok || !data.ok) {
            showToast("Message could not be sent.");
            return;
          }
          invalidatePersistedInboxCache(VENDOR_INBOX_STORAGE_KEY);
          await syncPersistedInboxFromServer(VENDOR_INBOX_STORAGE_KEY, { force: true });
          if (!ownsOperation()) return;
          setLocal(loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[]);
          showToast(
            p.includesAxisAdmin && !p.includesDirectoryRecipients
              ? "Message sent to PropLane admin."
              : "Message sent.",
          );
          navigate("/vendor/communication/email/sent");
        } catch {
          if (ownsOperation()) showToast("Message could not be sent.");
        }
      })();
    },
    [captureOperationOwnership, navigate, showToast],
  );

  const activeSmsAvailable = smsUiEnabled && smsConfigured;

  useEffect(() => {
    if (!embeddedInCommunication) return;
    const unified = resolvePropLaneUnifiedReplyChannels({
      emailAvailable: true,
      smsAvailable: activeSmsAvailable,
    });
    setReplyViaEmail(unified.viaEmail);
    setReplyViaSms(unified.viaSms);
  }, [activeSmsAvailable, embeddedInCommunication, expandedId]);

  const handleReply = useCallback(
    async (
      row: PortalInboxTableRow,
      text: string,
      channels: { email: boolean; sms: boolean } = { email: true, sms: false },
      attachmentUrls: string[] = [],
    ) => {
      const ownsOperation = captureOperationOwnership();
      if (!ownsOperation()) return;
      const thread = localRef.current.find((t) => t.id === row.id);
      if (!thread) return;
      const ownsConversation = captureConversationOwnership(thread.id);
      if (!channels.email && !channels.sms) throw new InboxSendRefusal(null);
      const replyId = `reply-${Date.now().toString(36)}`;
      const attachmentMeta = attachmentMetaFromUrls(attachmentUrls);
      const reply: InboxThreadMessage = {
        id: replyId,
        from: vendorIdentity.name,
        body: text,
        at: formatInboxStamp(new Date()),
        outbound: true,
        delivery: "sending",
        attachments: attachmentMeta.length ? attachmentMeta : undefined,
      };
      setLocal((current) =>
        current.map((item) =>
          item.id === thread.id
            ? appendReplyToInboxThread(item, reply)
            : item,
        ),
      );
      const rollbackReply = () => {
        if (!ownsConversation()) return;
        setLocal((current) =>
          current.map((item) => {
            if (item.id !== thread.id) return item;
            const messages = (item.messages ?? []).filter(
              (message) => message.id !== replyId,
            );
            if (messages.length === (thread.messages ?? []).length) {
              return {
                ...item,
                messages,
                preview: thread.preview,
                time: thread.time,
                unread: thread.unread,
              };
            }
            const last = messages[messages.length - 1];
            return {
              ...item,
              messages,
              preview: last
                ? last.body.slice(0, 100).replace(/\n/g, " ")
                : thread.preview,
              time: last?.at ?? thread.time,
            };
          }),
        );
      };
      const subject = thread.subject.startsWith("Re:") ? thread.subject : `Re: ${thread.subject}`;
      let emailOk = false;
      let smsOk = false;
      let failureMessage = "";
      try {
        if (channels.email) {
          if (!ownsOperation()) return;
          try {
            const res = await fetch("/api/portal/send-inbox-message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({
                fromName: vendorIdentity.name,
                fromEmail: vendorIdentity.email,
                threadId: thread.id,
                subject,
                text,
                toEmails: [thread.email],
                deliverToPortalInbox: true,
                deliverViaEmail: true,
                deliverViaSms: false,
                senderPortal: "vendor",
                attachmentUrls: attachmentUrls.length ? attachmentUrls : undefined,
              }),
            });
            const data = (await res.json().catch(() => ({}))) as {
              ok?: boolean;
              error?: string;
            };
            if (!ownsOperation()) return;
            emailOk = res.ok && data.ok === true;
            if (!emailOk) failureMessage = data.error?.trim() ?? "";
          } catch {
            failureMessage = "";
          }
        }
        if (channels.sms) {
          if (!ownsOperation()) return;
          if (!activeSmsAvailable) {
            failureMessage ||= "Text messaging is not available right now.";
          } else {
            try {
              const res = await fetch("/api/portal/send-inbox-message", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({
                  fromName: vendorIdentity.name,
                  fromEmail: vendorIdentity.email,
                  threadId: thread.id,
                  subject,
                  text,
                  toEmails: [thread.email],
                  deliverToPortalInbox: false,
                  deliverViaEmail: false,
                  deliverViaSms: true,
                  senderPortal: "vendor",
                  attachmentUrls: attachmentUrls.length ? attachmentUrls : undefined,
                }),
              });
              const data = (await res.json().catch(() => ({}))) as {
                ok?: boolean;
                error?: string;
              };
              if (!ownsOperation()) return;
              smsOk = res.ok && data.ok === true;
              if (!smsOk) failureMessage = data.error?.trim() || failureMessage;
            } catch {
              // Preserve any explicit refusal from the other channel.
            }
          }
        }
        if (!emailOk && !smsOk) {
          rollbackReply();
          throw new InboxSendRefusal(failureMessage || null);
        }

        // Conversation navigation only fences active-thread UI. The initiating
        // viewer still owns this source-thread cache reconciliation.
        if (!ownsOperation()) return;
        const currentRows = loadPersistedInbox(VENDOR_INBOX_STORAGE_KEY, VENDOR_INBOX_FALLBACK) as InboxThread[];
        const currentThread = currentRows.find((item) => item.id === thread.id);
        if (currentThread) {
          const withReply = (currentThread.messages ?? []).some(
            (message) => message.id === replyId,
          )
            ? currentThread
            : appendReplyToInboxThread(currentThread, reply);
          const delivered = markThreadMessageDelivery(withReply, replyId, undefined);
          const persisted = currentRows.map((item) =>
            item.id === thread.id ? delivered : item,
          );
          setLocal(persisted);
          await upsertPersistedInboxRows(
            VENDOR_INBOX_STORAGE_KEY,
            [delivered],
            persisted,
          ).catch(() => false);
        }
      } finally {
        // The delivered reply is persisted explicitly above.
      }
      if (ownsOperation()) {
        void syncPersistedInboxFromServer(VENDOR_INBOX_STORAGE_KEY, {
          force: true,
        }).catch(() => {});
      }
      return {
        emailRequested: channels.email,
        smsRequested: channels.sms,
        emailOk,
        smsOk,
      };
    },
    [activeSmsAvailable, captureConversationOwnership, captureOperationOwnership, vendorIdentity],
  );

  const renderExtraActions = useCallback(
    (row: PortalInboxTableRow) => {
      // Destructive actions follow the ROW's own folder, never the active tab —
      // the unified "all" view spans folders, so a tab-derived "Delete forever"
      // would destroy a live conversation.
      const thread = local.find((t) => t.id === row.id);
      const folder = thread?.folder ?? (tabId === "trash" ? "trash" : "inbox");
      // One row of matching circular controls, same as the manager's header.
      if (folder === "trash") {
        return (
          <>
            <button
              type="button"
              className={INBOX_THREAD_ICON_BTN}
              aria-label="Restore conversation"
              title="Restore"
              onClick={() => restoreFromArchive(row.id)}
            >
              <ArchiveRestore className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              className={INBOX_THREAD_ICON_BTN_DANGER}
              aria-label="Delete conversation"
              title="Delete forever"
              onClick={() => deleteForever(row.id)}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
            </button>
          </>
        );
      }
      if (folder === "inbox" && !thread?.unread) {
        return (
          <>
            <button
              type="button"
              className={INBOX_THREAD_ICON_BTN}
              aria-label="Mark conversation unread"
              title="Mark unread"
              onClick={() => markUnread(row.id)}
            >
              <MailOpen className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              className={INBOX_THREAD_ICON_BTN}
              aria-label="Archive conversation"
              title="Archive"
              onClick={() => moveToArchive(row.id)}
            >
              <Archive className="h-4 w-4" aria-hidden />
            </button>
          </>
        );
      }
      return (
        <button
          type="button"
          className={INBOX_THREAD_ICON_BTN}
          aria-label="Archive conversation"
          title="Archive"
          onClick={() => moveToArchive(row.id)}
        >
          <Archive className="h-4 w-4" aria-hidden />
        </button>
      );
    },
    [local, tabId, moveToArchive, restoreFromArchive, deleteForever, markUnread],
  );

  const emptyCopy = inboxTabEmptyCopy(tabId);

  const bulkMarkRead = () => {
    for (const id of threadSelection.selectedIds) markRead(id);
    threadSelection.clearSelection();
  };

  const bulkMoveToArchive = () => {
    for (const id of threadSelection.selectedIds) moveToArchive(id);
    threadSelection.clearSelection();
  };

  const bulkRestoreFromArchive = () => {
    for (const id of threadSelection.selectedIds) restoreFromArchive(id);
    threadSelection.clearSelection();
  };

  const bulkDeleteForever = async () => {
    const ownsOperation = captureOperationOwnership();
    const ids = [...threadSelection.selectedIds];
    if (!(await confirm({ description: `Delete ${threadSelection.selectedIds.size} message(s) permanently?` }))) return;
    if (!ownsOperation()) return;
    for (const id of ids) {
      if (!ownsOperation()) return;
      deleteForever(id);
    }
    if (ownsOperation()) threadSelection.clearSelection();
  };

  const bulkMarkUnread = () => {
    for (const id of threadSelection.selectedIds) markUnread(id);
    threadSelection.clearSelection();
  };


  const activeThread = useMemo(
    () => (expandedId ? local.find((t) => t.id === expandedId) ?? null : null),
    [expandedId, local],
  );

  useEffect(() => {
    if (!activeThread || activeThread.folder !== "inbox" || !activeThread.unread) return;
    markReadSilent(activeThread.id);
  }, [activeThread?.id, activeThread?.folder, activeThread?.unread, markReadSilent]);

  const activeIsSent = activeThread?.folder === "sent";
  const activeIsAssistantThread = Boolean(
    activeThread && isConversationWithPropLaneAssistant(activeThread),
  );
  const activeThreadAvatarName = activeThread
    ? activeIsSent
      ? activeThread.email || undefined
      : activeThread.from || activeThread.email || undefined
    : undefined;
  const activeFolder = activeThread
    ? activeThread.folder === "trash"
      ? "inbox"
      : activeThread.folder
    : "inbox";
  const activeBubbles = useMemo((): InboxBubbleMessage[] => {
    if (!activeThread) return [];
    let lastShownSubject = "";
    return inboxThreadMessages(activeThread).map((m, i) => {
      const direction = inboxTurnDirection(activeThread, m, i, activeFolder);
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
        author: m.from,
        body: fields.body,
        at: m.at,
        direction,
        delivery: m.delivery,
        channel: m.channel,
        ...(fields.subject ? { subject: fields.subject } : {}),
        attachments: m.attachments,
      } satisfies InboxBubbleMessage;
    });
  }, [activeThread, activeFolder]);

  const pickReplyAttachments = useCallback(
    (files: FileList | null) => {
      if (!files?.length) return;
      const room = INBOX_MAX_ATTACHMENTS - replyAttachments.length;
      if (room <= 0) {
        showToast(`You can attach up to ${INBOX_MAX_ATTACHMENTS} files.`);
        return;
      }
      for (const file of Array.from(files).slice(0, room)) {
        const ownsConversation = captureConversationOwnership(expandedId);
        const pending = createPendingInboxAttachment(file);
        setReplyAttachments((prev) => [...prev, pending]);
        void uploadInboxAttachment(file)
          .then((url) => {
            if (!ownsConversation()) return;
            setReplyAttachments((prev) => prev.map((a) => (a.id === pending.id ? { ...a, uploadUrl: url, uploading: false } : a)));
          })
          .catch((e) => {
            if (!ownsConversation()) return;
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
    [captureConversationOwnership, captureOperationOwnership, expandedId, replyAttachments.length, showToast],
  );

  // The same reply row as the manager's Communication inbox: ✦ AI, then the channel menu.
  const [askAssistantSignal, setAskAssistantSignal] = useState(0);
  const replyChannelMenu = (
    <InboxComposerChannelMenu
      viaEmail={replyViaEmail}
      viaSms={replyViaSms}
      onViaEmailChange={setReplyViaEmail}
      onViaSmsChange={setReplyViaSms}
      emailAvailable
      smsAvailable={activeSmsAvailable}
    />
  );

  const sendActiveReply = useCallback(async () => {
    if (!activeThread) return;
    const ownsOperation = captureOperationOwnership();
    const operationThreadId = activeThread.id;
    const ownsConversation = captureConversationOwnership(operationThreadId);
    const replyAttempt = ++replyAttemptGenerationRef.current;
    const ownsReplyAttempt = () => ownsConversation() && replyAttemptGenerationRef.current === replyAttempt;
    if (!ownsOperation()) return;
    const text = replyDraft.trim();
    const attachmentUrls = replyAttachments.filter((a) => a.uploadUrl && !a.uploading && !a.error).map((a) => a.uploadUrl!);
    if (!text && attachmentUrls.length === 0) return;
    const viaEmail = replyViaEmail || !activeSmsAvailable;
    const viaSms = replyViaSms && activeSmsAvailable;
    if (!viaEmail && !viaSms) {
      showToast("Choose Email, SMS, or both.");
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
        { email: viaEmail, sms: viaSms },
        attachmentUrls,
      );
      if (!ownsReplyAttempt()) return;
      if (!outcome) return;
      setReplyDraft("");
      setReplyAttachments([]);
      showToast(inboxReplySentToastMessage(outcome));
    } catch (error) {
      if (!ownsReplyAttempt()) return;
      showToast(
        error instanceof InboxSendRefusal
          ? (error.reason ?? "Could not send reply.")
          : "Could not send reply.",
      );
    } finally {
      if (ownsReplyAttempt()) setReplySending(false);
    }
  }, [activeSmsAvailable, activeThread, captureConversationOwnership, captureOperationOwnership, handleReply, replyAttachments, replyDraft, replyViaEmail, replyViaSms, showToast]);

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
        onClose={() => setComposeOpen(false)}
        onSend={handleComposeSend}
        portal="vendor"
        senderName={vendorIdentity.name}
        senderEmail={vendorIdentity.email}
        liveContacts={eligibleContacts}
      />

      {!suppressListPane ? <PortalListToolbar
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: "Search messages",
          dataAttr: "vendor-inbox-search",
        }}
      /> : null}

      {suppressListPane ? (
        <div className={pageScroll ? "flex flex-col" : "flex h-full min-h-0 flex-1 flex-col overflow-hidden"}>
          {activeThread ? (
            <InboxThreadView
              scrollMode={pageScroll ? "page" : "pane"}
              title={activeIsSent ? activeThread.email || "Unknown recipient" : activeThread.from || activeThread.email || "Unknown sender"}
              avatarName={activeThreadAvatarName}
              subtitle={activeThread.subject || (activeIsSent ? undefined : activeThread.email)}
              messages={activeBubbles}
              alignAssistantStart={activeIsAssistantThread}
              threadKey={activeThread.id}
              onBack={() => setExpandedId(null)}
              headerActions={renderExtraActions({
                id: activeThread.id,
                name: activeThread.from,
                email: activeThread.email,
                subject: activeThread.subject,
                whenLabel: activeThread.time,
                read: !activeThread.unread,
              })}
              emptyLabel="No messages in this conversation."
              composer={
                activeThread.folder === "trash" || tabId === "trash" ? undefined : (
                  <>
                    <InboxThreadAssistantStrip
                      contextHint={buildInboxThreadAssistantContext({
                        subject: activeThread.subject,
                        email: activeThread.email,
                        from: activeThread.from,
                        sentSemantics: activeIsSent,
                      })}
                      hideTrigger
                      openSignal={askAssistantSignal}
                    />
                    <InboxComposer
                      value={replyDraft}
                      onChange={setReplyDraft}
                      onSubmit={() => void sendActiveReply()}
                      sending={replySending}
                      disabled={!replyViaEmail && !replyViaSms}
                      placeholder={
                        !embeddedInCommunication && replyViaSms && !replyViaEmail
                          ? "Text message"
                          : "Write a reply…"
                      }
                      maxLength={
                        !embeddedInCommunication && replyViaSms && !replyViaEmail ? 1600 : undefined
                      }
                      dataAttr="vendor-inbox-reply"
                      trailingControls={
                        <>
                          <InboxComposerAiMenu onAsk={() => setAskAssistantSignal((n) => n + 1)} />
                          {replyChannelMenu}
                        </>
                      }
                      attachments={replyAttachments}
                      onAttachmentsPick={pickReplyAttachments}
                      onAttachmentRemove={(id) => setReplyAttachments((prev) => prev.filter((a) => a.id !== id))}
                      maxAttachments={INBOX_MAX_ATTACHMENTS}
                      autoSend={autoSend}
                      onAutoSendChange={setAutoSend}
                    />
                  </>
                )
              }
            />
          ) : (
            <InboxThreadEmpty />
          )}
        </div>
      ) : rowsForTab.length === 0 ? (
        <PortalInboxEmptyState title={emptyCopy} />
      ) : (
        <div className="space-y-3">
          <PortalInboxSelectionToolbar count={threadSelection.selectedIds.size} onClear={threadSelection.clearSelection}>
            {tabId === "unopened" || tabId === "all" ? (
              <>
                <Button type="button" variant="outline" className="rounded-full" onClick={bulkMarkRead}>
                  Mark read
                </Button>
                <Button type="button" variant="outline" className="rounded-full" onClick={bulkMoveToArchive}>
                  Archive
                </Button>
              </>
            ) : null}
            {tabId === "opened" ? (
              <>
                <Button type="button" variant="outline" className="rounded-full" onClick={bulkMarkUnread}>
                  Mark unread
                </Button>
                <Button type="button" variant="outline" className="rounded-full" onClick={bulkMoveToArchive}>
                  Archive
                </Button>
              </>
            ) : null}
            {tabId === "sent" ? (
              <Button type="button" variant="outline" className="rounded-full" onClick={bulkMoveToArchive}>
                Archive
              </Button>
            ) : null}
            {tabId === "trash" ? (
              <>
                <Button type="button" variant="outline" className="rounded-full" onClick={bulkRestoreFromArchive}>
                  Restore
                </Button>
                <Button type="button" variant="outline" className="rounded-full text-rose-700" onClick={bulkDeleteForever}>
                  Delete forever
                </Button>
              </>
            ) : null}
          </PortalInboxSelectionToolbar>
          <PortalInboxMessageTable
            rows={toRows(rowsForTab)}
            primaryPartyHeader={tabId === "all" ? "From / To" : tabId === "sent" ? "To" : "From"}
            onMarkRead={tabId === "unopened" || tabId === "all" ? markRead : undefined}
            getDetailBody={(row) => bodyById[row.id]}
            getThreadMessages={(row) => {
              const thread = local.find((t) => t.id === row.id);
              return thread ? inboxThreadMessages(thread) : [];
            }}
            onReply={
              tabId === "trash"
                ? undefined
                : async (row, text) => {
                    const ownsOperation = captureOperationOwnership();
                    if (!ownsOperation()) return;
                    try {
                      const outcome = await handleReply(row, text, {
                        email: true,
                        sms: false,
                      });
                      if (ownsOperation() && outcome)
                        showToast(inboxReplySentToastMessage(outcome));
                    } catch (error) {
                      if (!ownsOperation()) return;
                      showToast(
                        error instanceof InboxSendRefusal
                          ? (error.reason ?? "Could not send reply.")
                          : "Could not send reply.",
                      );
                    }
                  }
            }
            expandedId={expandedId}
            onToggleExpand={(id) => setExpandedId((cur) => (cur === id ? null : id))}
            renderExtraActions={renderExtraActions}
            selection={{
              selectedIds: threadSelection.selectedIds,
              onToggleSelected: threadSelection.toggleSelected,
              onToggleSelectAll: threadSelection.toggleSelectAll,
              allSelected: threadSelection.allSelected,
              selectableCount: threadRowIds.length,
            }}
          />
        </div>
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
        <div className={PORTAL_PAGE_ACTIONS_DESKTOP}>
          <Button type="button" variant="primary" className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN}`} onClick={() => setComposeOpen(true)}>
            New message
          </Button>
          {tabId === "trash" && counts.trash > 0 ? (
            <Button
              type="button"
              variant="outline"
              className={`shrink-0 ${PORTAL_HEADER_ACTION_BTN} text-[var(--status-overdue-fg)]`}
              onClick={emptyArchive}
            >
              Empty archive
            </Button>
          ) : null}
        </div>
      }
      filterRow={
        <ManagerPortalFilterRow>
          <ManagerPortalStatusPills
            activeTone="primary"
            tabs={tabs}
            activeId={tabId}
            onChange={(id) => navigate(`/vendor/communication/email/`)}
          />
          <div className={PORTAL_FILTER_ACTIONS_MOBILE}>
            <Button type="button" variant="primary" className={PORTAL_HEADER_ACTION_BTN} onClick={() => setComposeOpen(true)}>
              New message
            </Button>
            {tabId === "trash" && counts.trash > 0 ? (
              <Button type="button" variant="outline" className={PORTAL_HEADER_ACTION_BTN} onClick={emptyArchive}>
                Empty
              </Button>
            ) : null}
          </div>
        </ManagerPortalFilterRow>
      }
    >
      {inboxBody}
    </ManagerPortalPageShell>
  );
});
