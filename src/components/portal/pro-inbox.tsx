"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { Archive, ArchiveRestore, Eraser, Pencil, Phone, Trash2, UserRound } from "lucide-react";
import Link from "next/link";
import { residentDetailHref } from "@/lib/portal-detail-routes";
import { formatTourContactPhoneDisplay } from "@/lib/tour-contact-quality";
import { clearInboxReplyDraft, readInboxReplyDraft, writeInboxReplyDraft } from "@/lib/inbox-reply-draft-store";
import { inboxCounterpartyName } from "@/lib/manager-inbox-contacts";
import { inboxRowAddressLabel } from "@/lib/communication-row-meta";
import { defaultScheduleSendAtLocal } from "@/components/portal/portal-message-compose-fields";
import {
  InboxComposerAiMenu,
  InboxComposerChannelMenu,
  InboxComposerScheduleMenu,
} from "@/components/portal/inbox-composer-tools";
import { Button } from "@/components/ui/button";
import { RowSelectCheckbox } from "@/components/ui/row-select-checkbox";
import {
  PortalContactDetailsModal,
  type PortalContactDetailsValues,
} from "@/components/portal/portal-contact-details-modal";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
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
  lastInboundChannelOf,
  inboxThreadSortMs,
  inboxMessageOutbound,
  advanceInboxAiDraft,
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
import { inboxThreadLastTurnDirection, inboxTurnDirection } from "@/lib/inbox-turn-direction";
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
  InboundMessageWorkflowCard,
  InboxComposer,
  InboxReplyChannelPicker,
  InboxConversationRow,
  InboxScheduledCard,
  InboxScheduledThreadList,
  InboxThreadEmpty,
  InboxThreadSkeleton,
  InboxThreadView,
  PORTAL_INBOX_LIST_TOOLBAR_CLASS,
  InboxTwoPane,
  PortalInboxEmptyState,
  inboxTabEmptyCopy,
  type InboxBubbleMessage,
  INBOX_THREAD_ICON_BTN,
  INBOX_THREAD_ICON_BTN_DANGER,
} from "./portal-inbox-ui";
import {
  useInboxRowSelection,
  sendManualScheduledMessageNow,
  sendAutomationScheduledMessageNow,
} from "@/components/portal/portal-inbox-selection";
import { ManagerInboxSchedulePanel } from "@/components/portal/pro-inbox-schedule-panel";
import {
  patchScheduledMessage,
  useScheduledPaymentMessages,
} from "@/components/portal/payment-schedule-ui";
import {
  automationChannelDefaultsFromSettings,
  scheduledItemsForRecipient,
} from "@/lib/inbox-scheduled-thread";
import { readPortalApiError } from "@/lib/portal-api-error";
import { MANAGER_APPLICATIONS_EVENT } from "@/lib/manager-applications-storage";
import {
  inboxThreadHasEmail,
  hasInboxReplyChannelSelected,
  resolveAssistantInboxReplyChannels,
  resolveCommunicationPersonThreadReplyChannels,
  resolveManagerInboxReplyChannels,
  resolveManagerInboxPortalRecipient,
  resolveManagerInboxSmsTarget,
  resolvePropLaneUnifiedReplyChannels,
  inboxSmsUnavailableReason,
} from "@/lib/manager-inbox-reply-channels";
import {
  resolveCommunicationInboxThread,
} from "@/lib/communication-assistant-inbox-list";
import { isPropLaneAssistantInboxThread, isTeamInboxThread } from "@/lib/communication-inbox-assistant";
import { sendPropLaneAssistantInboxMessage } from "@/lib/assistant-inbox-reply";
import { buildManagerInboxLiveContacts } from "@/lib/manager-inbox-contacts";
import {
  isUpcomingScheduledInboxMessage,
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useSelectedWorkspaceId } from "@/hooks/use-selected-workspace-id";
import { ManagerCreateWorkOrderModal } from "@/components/portal/pro-create-work-order-modal";
import { ManagerCreateServiceRequestModal } from "@/components/portal/pro-create-service-request-modal";
import {
  suggestInboundMessageWorkflows,
  workflowTitleFromMessage,
  type InboundWorkflowSuggestionKind,
} from "@/lib/inbox/inbound-message-workflow-suggestions";
import { resolveManagerServiceResidentByEmail } from "@/lib/manager-service-resident-lookup";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  filterEmailInboxThreads,
  filterManagerCommunicationThreads,
  threadMatchesVendorContact,
} from "@/lib/communication-inbox-filters";
import { emailReplySubjectFor, inboxEmailBubbleFields } from "@/lib/inbox-email-display";
import { dispatchManagerSmsContactsChanged, type ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
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
  isManualSmsSubmitted,
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
  aiDraftQueue?: InboxAiDraft[];
  resolvedAiDraftIds?: string[];
};

function threadEligibleForAiDraft(thread: InboxThread): boolean {
  if (isPropLaneAssistantInboxThread(thread)) return false;
  if (thread.folder !== "inbox") return false;
  if (inboxThreadManagerReplyPending(thread)) return true;
  const email = String(thread.email ?? "").trim().toLowerCase();
  return email.includes("@");
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
    /** Scope threads to one vendor (Vendors detail Communication tab). */
    filterVendorEmail?: string;
    filterVendorPhone?: string;
    /** Rendered when suppressListPane is set and no thread matches filterResidentEmail. */
    emptyThreadFallback?: React.ReactNode;
    /** Bumps when a parent modal schedules/cancels for the filtered resident. */
    scheduledRefreshKey?: number;
    /** Clear PropLane Assistant messages and keep the row. */
    onClearAssistant?: () => void | Promise<void>;
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
    filterVendorEmail,
    filterVendorPhone,
    emptyThreadFallback,
    scheduledRefreshKey = 0,
    onClearAssistant,
  },
  ref,
) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const navigate = usePortalNavigate();
  const portalBase = usePaidPortalBasePath();
  const inboxBase = embeddedInCommunication && commBase ? `${commBase}/inbox` : `${portalBase}/inbox`;
  const {
    messages: scheduledMessages,
    settings: reminderAutomationSettings,
    reload: reloadAutomationScheduled,
  } = useScheduledPaymentMessages({
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
  const { userId, email: viewerEmail } = useManagerUserId();
  // The line and address below belong to the ACTIVE workspace; re-read them on a switch.
  const selectedWorkspace = useSelectedWorkspaceId();
  const [smsCanSend, setSmsCanSend] = useState(false);
  /** The line texts leave on — the manager's own number, or the workspace's shared one. */
  const [smsSendingNumber, setSmsSendingNumber] = useState<string | null>(null);
  /** Work-number replies stay live when canSend even if the global SMS comm UI flag is off. */
  const smsOutboundEnabled = smsUiEnabled || smsCanSend;

  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/manager/messaging-number", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        const status = body as {
          canSend?: boolean;
          number?: { phoneNumber?: string | null } | null;
          workspaceNumber?: { phoneNumber?: string | null } | null;
        };
        setSmsCanSend(status.canSend === true);
        setSmsSendingNumber(status.number?.phoneNumber ?? status.workspaceNumber?.phoneNumber ?? null);
      })
      .catch(() => {
        if (!cancelled) setSmsCanSend(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace]);

  /* The address an email reply actually leaves from is the WORKSPACE work
     email (`resolveManagerOutboundFrom`), not the viewer's login address — the
     channel menu names that one so "Email · assist-…@prop-lane.space" matches
     what the recipient sees in their From column. */
  const [workEmailAddress, setWorkEmailAddress] = useState<string | null>(null);
  useEffect(() => {
    if (isDemoModeActive()) return;
    let cancelled = false;
    void fetch("/api/manager/assistant-email", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        const status = body as {
          canUse?: boolean;
          workspaceEmail?: { address?: string | null } | null;
          address?: string | null;
        };
        if (status.canUse !== true) return;
        setWorkEmailAddress(status.workspaceEmail?.address?.trim() || status.address?.trim() || null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspace]);

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
  const [scheduleLater, setScheduleLater] = useState(false);
  const [scheduleSendAt, setScheduleSendAt] = useState(() => defaultScheduleSendAtLocal());
  // The composer's ✦ menu opens the thread assistant rail; each bump is one ask.
  const [askAssistantSignal, setAskAssistantSignal] = useState(0);
  const [workflowWorkOrderOpen, setWorkflowWorkOrderOpen] = useState(false);
  const [workflowServiceOpen, setWorkflowServiceOpen] = useState(false);
  const [workflowMessageText, setWorkflowMessageText] = useState("");
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
  const vendorEmailNorm = filterVendorEmail?.trim() ?? "";
  const vendorPhoneNorm = filterVendorPhone?.trim() ?? "";
  const embeddedVendorChat = Boolean(vendorEmailNorm || vendorPhoneNorm);
  const embeddedResidentChat = Boolean(residentEmailNorm);

  const emailThreads = useMemo(() => {
    let base = embeddedInCommunication
      ? filterEmailInboxThreads(local, { keepSmsLike: !smsUiEnabled })
      : local;
    base = filterManagerCommunicationThreads(base);
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
    const vendorScoped = embeddedVendorChat
      ? residentScoped.filter((t) =>
          threadMatchesVendorContact(t, { email: vendorEmailNorm, phone: vendorPhoneNorm }),
        )
      : residentScoped;
    return collapsePersonInboxThreads(vendorScoped, { mergeFolders: embeddedInCommunication });
  }, [
    embeddedInCommunication,
    smsUiEnabled,
    local,
    threadFilters,
    filterContacts,
    residentEmailNorm,
    embeddedVendorChat,
    vendorEmailNorm,
    vendorPhoneNorm,
  ]);

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

  // Resident- and vendor-scoped chat (detail → Communication) auto-select the
  // newest conversation in the active view. `tabId` is the archived toggle here —
  // "trash" is the archived view and must select an ARCHIVED thread, every other
  // tab a live one; selecting across the two would show a live conversation under
  // "Archived". The tab-change reset below must not run in these modes or it
  // clobbers this in the same commit — see the comment there.
  useEffect(() => {
    if ((!residentEmailNorm && !embeddedVendorChat) || controlledExpandedId !== undefined) return;
    const candidates = emailThreads.filter((t) =>
      tabId === "trash" ? t.folder === "trash" : t.folder !== "trash",
    );
    if (candidates.length === 0) {
      setInternalExpandedId(null);
      return;
    }
    const best = [...candidates].sort((a, b) => threadTimestamp(b) - threadTimestamp(a))[0];
    if (best) setInternalExpandedId(best.id);
  }, [residentEmailNorm, embeddedVendorChat, emailThreads, controlledExpandedId, tabId]);

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
    if (embeddedVendorChat) {
      filtered = emailThreads.filter((t) => (tabId === "trash" ? t.folder === "trash" : t.folder !== "trash"));
    } else if (tabId === "unopened")
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
    if (controlledExpandedId === undefined && !embeddedResidentChat && !embeddedVendorChat) setExpandedId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const threadRowIds = useMemo(() => rowsForTab.map((t) => t.id), [rowsForTab]);
  const threadSelection = useInboxRowSelection(threadRowIds);

  // Mark an unread inbox thread read without a toast — used when a thread is
  // opened in the two-pane view (kept listed under Unopened until refresh via
  // `retainedIds`, matching the explicit "Mark read" behaviour).
  const markReadSilent = useCallback((id: string) => {
    const current = loadPersistedInbox(MANAGER_INBOX_STORAGE_KEY, []) as InboxThread[];
    const thread = current.find((row) => row.id === id && row.folder === "inbox" && row.unread);
    if (!thread) return;
    const changed = { ...thread, unread: false };
    const next = current.map((row) => row.id === id ? changed : row);
    // Commit the selected row to the shared store before React's persistence
    // effect runs. A read must not rewrite the entire mailbox: an unrelated
    // inaccessible row can reject that replacement before this row is saved.
    void upsertPersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, [changed], next).then((ok) => {
      if (!ok) showToast("Could not mark the conversation as read. Try again.");
    });
    setLocal(next);
    setRetainedIds((prev) => new Set(prev).add(id));
  }, [showToast]);

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

  const deleteAllTrash = useCallback(async () => {
    const trashItems = local.filter((t) => t.folder === "trash");
    if (trashItems.length === 0) {
      showToast("Trash is already empty.");
      return;
    }
    if (!(await confirm({ description: `Delete all ${trashItems.length} trash message${trashItems.length === 1 ? "" : "s"}? This cannot be undone.` }))) return;
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
      channels: { email: boolean; sms: boolean; proplane?: boolean },
      attachmentUrls: string[] = [],
    ) => {
      const thread = localRef.current.find((t) => t.id === rowId);
      if (!thread) return;
      // A Team thread replies the way an assistant thread does: in-app only,
      // no person counterparty — the send route posts it to the team.
      const assistantThread = isPropLaneAssistantInboxThread(thread) || isTeamInboxThread(thread);
      const portalRecipient = assistantThread
        ? null
        : resolveManagerInboxPortalRecipient(thread, smsRecipients, smsOutboundEnabled);
      const proplaneAllowed = Boolean(
        channels.proplane && (assistantThread || portalRecipient),
      );
      const emailAllowed = channels.email && inboxThreadHasEmail(thread.email);
      const smsAllowed =
        channels.sms &&
        Boolean(resolveManagerInboxSmsTarget(thread, smsRecipients, smsOutboundEnabled)?.phone?.trim());
      if (!proplaneAllowed && !emailAllowed && !smsAllowed) {
        throw new InboxSendRefusal(
          channels.proplane && !assistantThread && !portalRecipient
            ? "This person is not reachable in the PropLane app yet."
            : channels.email && !inboxThreadHasEmail(thread.email)
              ? "This conversation has no email address. Send via SMS instead."
              : null,
        );
      }

      const replyId = `reply-${Date.now().toString(36)}`;
      const attachmentMeta = attachmentMetaFromUrls(attachmentUrls);
      const subject = emailReplySubjectFor(thread.subject);
      // The bubble wears the channel the reply is leaving on — email first when
      // several are on, since that is the one with a subject line to show.
      const replyChannel: InboxThreadMessage["channel"] = emailAllowed
        ? "email"
        : smsAllowed
          ? "sms"
          : "proplane";
      const reply: InboxThreadMessage = {
        id: replyId,
        from: "Property manager",
        body: text,
        at: formatInboxStamp(new Date()),
        outbound: true,
        delivery: "sending",
        attachments: attachmentMeta.length ? attachmentMeta : undefined,
        channel: replyChannel,
        ...(emailAllowed ? { subject } : {}),
      };
      persistInboxRef.current = false;
      setLocal((current) =>
        current.map((row) =>
          row.id === thread.id
            ? advanceInboxAiDraft(appendReplyToInboxThread(row, reply))
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

      let emailOk = false;
      let smsOk = false;
      let proplaneOk = false;
      let smsUnknown = false;
      let failureMessage = "";
      try {
        if (proplaneAllowed) {
          try {
            const result = await sendPropLaneAssistantInboxMessage({
              threadId: thread.id,
              subject,
              text,
              fromName: "Property manager",
              senderPortal: "manager",
              attachmentUrls,
              toEmails: portalRecipient?.toEmails,
              toUserIds: portalRecipient?.toUserIds,
            });
            proplaneOk = result.ok;
            if (!result.ok) failureMessage = result.error?.trim() ?? "";
          } catch {
            failureMessage = "";
          }
        }

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
              smsUnknown = isManualSmsOutcomeUnknown(data);
              smsOk = res.ok && isManualSmsSubmitted(data);
              if (smsOk) {
                replySmsAttemptRef.current = null;
              } else if (smsUnknown) {
                failureMessage = MANUAL_SMS_UNKNOWN_MESSAGE;
              } else if (res.ok && data.status && data.status !== "submitted") {
                failureMessage =
                  "Text message is queued but has not been delivered yet. Check Settings → Messaging or try again shortly.";
              } else {
                failureMessage = data.error?.trim() || failureMessage;
              }
            } catch {
              smsUnknown = true;
              failureMessage = MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE;
            }
          }
        }

        if (!emailOk && !smsOk && !proplaneOk) {
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
          const delivered = advanceInboxAiDraft(markThreadMessageDelivery(withReply, replyId, undefined));
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
        proplaneRequested: proplaneAllowed,
        proplaneOk,
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
  const [reply, setReply] = useState<{ threadId: string | null; text: string }>({ threadId: null, text: "" });
  const replyRef = useRef(reply);
  const replyDraft = reply.text;
  const setReplyDraft = useCallback((text: string) => {
    const next = { ...replyRef.current, text };
    replyRef.current = next;
    setReply(next);
  }, []);
  const [replyFocusSignal, setReplyFocusSignal] = useState(0);
  const adoptedAiDraftByThreadRef = useRef<Map<string, string>>(new Map());
  const [adoptedAiDraftThreadId, setAdoptedAiDraftThreadId] = useState<string | null>(null);
  const aiDraftHydratedKeysRef = useRef<Set<string>>(new Set());
  const [replyAttachments, setReplyAttachments] = useState<InboxComposerAttachment[]>([]);
  const [replySending, setReplySending] = useState(false);
  const [replyViaEmail, setReplyViaEmail] = useState(true);
  const [replyViaSms, setReplyViaSms] = useState(false);
  const [replyViaProplane, setReplyViaProplane] = useState(false);
  const [approvingDraft, setApprovingDraft] = useState(false);
  const { enabled: aiAutoSend, setEnabled: setAiAutoSend } = useInboxAiDraftAutoSend();
  const { channelsFor } = useManagerCommunicationDeliverVia();
  const autoSentDraftRef = useRef<string | null>(null);
  const [draftErrors, setDraftErrors] = useState<Record<string, string>>({});
  const [discardedDraftIds, setDiscardedDraftIds] = useState<Set<string>>(() => new Set());
  const [draftingIds, setDraftingIds] = useState<Set<string>>(() => new Set());
  const draftAttemptedRef = useRef<Set<string>>(new Set());

  const activeThread = useMemo(
    () =>
      resolveCommunicationInboxThread(
        expandedId,
        emailThreads,
        local,
        "manager",
        userId,
      ),
    [expandedId, emailThreads, local, userId],
  );
  const activeAiDraftAdopted = Boolean(
    activeThread?.aiDraft?.status === "pending_approval"
      && activeThread.aiDraft.text.trim()
      && reply.threadId === activeThread.id
      && replyDraft.trim() === activeThread.aiDraft.text.trim(),
  );

  const insertAiDraftIntoReply = useCallback(
    (threadId: string, text: string, force = false) => {
      const normalized = text.trim();
      if (!normalized) return false;
      const current = replyRef.current.threadId === threadId
        ? replyRef.current.text
        : readInboxReplyDraft(threadId);
      const previousAiDraft = adoptedAiDraftByThreadRef.current.get(threadId);
      if (!force && current.trim() && current !== previousAiDraft) {
        showToast("Draft ready. Your existing reply was kept.");
        return false;
      }
      const next = { threadId, text: normalized };
      adoptedAiDraftByThreadRef.current.set(threadId, normalized);
      setAdoptedAiDraftThreadId(threadId);
      replyRef.current = next;
      setReply(next);
      setReplyFocusSignal((value) => value + 1);
      return true;
    },
    [showToast],
  );

  // Opening a thread in the unified Communication list marks it read (dot clears).
  useEffect(() => {
    if (!inboxSynced || !activeThread || activeThread.folder !== "inbox" || !activeThread.unread) return;
    markReadSilent(activeThread.id);
  }, [activeThread?.id, inboxSynced, markReadSilent]);

  // A draft per conversation — restored when the manager comes back to it.
  // The text and the conversation it belongs to travel as one value, so the
  // write below never files the previous thread's words under the new id.
  useEffect(() => {
    const threadId = activeThread?.id ?? null;
    const next = { threadId, text: threadId ? readInboxReplyDraft(threadId) : "" };
    setAdoptedAiDraftThreadId(null);
    replyRef.current = next;
    setReply(next);
    setReplyAttachments((prev) => {
      prev.forEach(revokeInboxAttachmentPreview);
      return [];
    });
  }, [expandedId]);

  // Keep the unsent text for THIS conversation as it is typed.
  useEffect(() => {
    if (!reply.threadId || reply.threadId !== activeThread?.id) return;
    writeInboxReplyDraft(reply.threadId, reply.text);
  }, [activeThread?.id, reply]);

  useEffect(() => {
    if (!activeThread?.aiDraft?.text || activeThread.aiDraft.status !== "pending_approval") return;
    const key = `${activeThread.id}:${activeThread.aiDraft.generatedAt ?? activeThread.aiDraft.text}`;
    if (aiDraftHydratedKeysRef.current.has(key)) return;
    aiDraftHydratedKeysRef.current.add(key);
    insertAiDraftIntoReply(activeThread.id, activeThread.aiDraft.text);
  }, [
    activeThread?.aiDraft?.generatedAt,
    activeThread?.aiDraft?.status,
    activeThread?.aiDraft?.text,
    activeThread?.id,
    insertAiDraftIntoReply,
  ]);

  const [threadPhoneOpen, setThreadPhoneOpen] = useState(false);
  const [threadPhoneError, setThreadPhoneError] = useState<string | null>(null);
  const [savingThreadPhone, setSavingThreadPhone] = useState(false);

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
  const smsDisabledReason = useMemo(
    () =>
      inboxSmsUnavailableReason({
        smsAvailable: activeSmsAvailable,
        smsOutboundEnabled,
        smsUiEnabled,
      }),
    [activeSmsAvailable, smsOutboundEnabled, smsUiEnabled],
  );
  const activeIsAssistantThread = Boolean(
    activeThread && isPropLaneAssistantInboxThread(activeThread),
  );
  const activeProplaneAvailable = Boolean(activeThread);
  const showReplyChannelPicker = Boolean(activeThread);
  /* A primitive on purpose: the default-channel effects key on it, and a string
     only changes when the person actually reaches us on a different channel —
     not on every thread refresh, which would undo a manual channel switch. */
  const activeLastInboundChannel = useMemo(
    () => (activeThread ? lastInboundChannelOf(activeThread) : null),
    [activeThread],
  );

  /**
   * An email-only conversation has no SMS channel until someone supplies a
   * number. Saving one writes an address-book contact carrying THIS thread's
   * address, which is what makes `activeSmsAvailable` resolve for it.
   */
  const canAddThreadPhone = Boolean(
    smsUiEnabled && !activeSmsAvailable && activeThread?.email?.trim() && !embeddedResidentChat,
  );
  const canAddThreadEmail = Boolean(
    smsUiEnabled &&
      smsOutboundEnabled &&
      !activeEmailAvailable &&
      activeThread &&
      !activeIsAssistantThread &&
      !embeddedResidentChat,
  );
  const canEditThreadContact = Boolean(
    activeThread &&
      !activeIsAssistantThread &&
      !embeddedResidentChat &&
      inboxThreadHasEmail(activeThread.email),
  );

  const saveThreadContact = useCallback(
    async (values: PortalContactDetailsValues) => {
      const threadEmail = activeThread?.email?.trim().toLowerCase();
      const email = values.email || threadEmail;
      if (!email) {
        setThreadPhoneError("Enter an email address.");
        return;
      }
      setSavingThreadPhone(true);
      setThreadPhoneError(null);
      try {
        const res = await fetch("/api/manager/sms-contacts", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phone: values.phone,
            email,
            // The route stores a label for every contact; fall back to whatever
            // already names this conversation rather than forcing a retype.
            displayName: (values.name || activeThread?.from || email).slice(0, 80),
          }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not save contact details.");
        setThreadPhoneOpen(false);
        showToast("Contact details saved.");
        dispatchManagerSmsContactsChanged();
      } catch (e) {
        setThreadPhoneError(e instanceof Error ? e.message : "Could not save contact details.");
      } finally {
        setSavingThreadPhone(false);
      }
    },
    [activeThread, showToast],
  );

  const openThreadPhone = useCallback(() => {
    setThreadPhoneError(null);
    setThreadPhoneOpen(true);
  }, []);


  useEffect(() => {
    if (activeIsAssistantThread) {
      const next = resolveAssistantInboxReplyChannels({
        emailAvailable: activeEmailAvailable,
        smsAvailable: activeSmsAvailable,
      });
      setReplyViaProplane(next.viaProplane);
      setReplyViaEmail(next.viaEmail);
      setReplyViaSms(next.viaSms);
      return;
    }
    if (embeddedInCommunication) {
      const person = resolveCommunicationPersonThreadReplyChannels({
        emailAvailable: activeEmailAvailable,
        smsAvailable: activeSmsAvailable,
        lastInboundChannel: activeLastInboundChannel,
      });
      setReplyViaProplane(person.viaProplane);
      setReplyViaEmail(person.viaEmail);
      setReplyViaSms(person.viaSms);
      return;
    }
    const preferred = channelsFor("inbox_default");
    const next = resolveManagerInboxReplyChannels({
      emailAvailable: activeEmailAvailable,
      smsAvailable: activeSmsAvailable,
      preferred,
    });
    setReplyViaProplane(false);
    setReplyViaEmail(next.viaEmail);
    setReplyViaSms(next.viaSms);
  }, [
    activeIsAssistantThread,
    embeddedInCommunication,
    expandedId,
    channelsFor,
    activeEmailAvailable,
    activeSmsAvailable,
    activeLastInboundChannel,
  ]);

  const activeIsSent = activeThread?.folder === "sent";
  const activeFolder = activeThread
    ? activeThread.folder === "trash"
      ? inferPreviousFolder(activeThread)
      : activeThread.folder
    : "inbox";

  const activeBubbles = useMemo((): InboxBubbleMessage[] => {
    if (!activeThread) return [];
    const pendingRoot = pendingSendingThreadIds.has(activeThread.id);
    // An email turn shows its subject once: on the first email turn, and again
    // only when the subject changes ("Re: Propert" three times shows it once).
    // Quoted Gmail/Outlook history is stripped so the bubble is the new text.
    let lastEmailSubject = "";
    return inboxThreadMessages(activeThread).map((m, i) => {
      // Root direction follows the folder (a Sent thread we authored). Appended
      // messages default to outbound (a reply we sent), but a new message
      // delivered into this person-thread carries an explicit direction so an
      // inbound turn on our inbox copy renders inbound rather than as our reply.
      const direction = inboxTurnDirection(activeThread, m, i, activeFolder);
      const delivery =
        m.delivery ?? (pendingRoot && i === 0 && direction === "outbound" ? ("sending" as const) : undefined);
      const fields = inboxEmailBubbleFields(
        {
          body: m.body,
          subject: m.subject ?? (i === 0 ? activeThread.subject : undefined),
          channel: m.channel,
        },
        lastEmailSubject,
      );
      lastEmailSubject = fields.lastShownSubject;
      return {
        id: m.id,
        author: m.from,
        body: fields.body,
        at: m.at,
        direction,
        delivery,
        // The channel the turn was stamped with when written. Unstamped legacy
        // turns show no tag — a guessed "Email" is how an in-app reply that never
        // left PropLane used to look sent.
        channel: m.channel,
        ...(fields.subject ? { subject: fields.subject } : {}),
        attachments: m.attachments,
      } satisfies InboxBubbleMessage;
    });
  }, [activeThread, activeFolder, pendingSendingThreadIds]);

  const latestInboundMessageText = useMemo(() => {
    if (!activeThread || activeIsSent) return "";
    const inbound = [...activeBubbles].reverse().find((bubble) => bubble.direction === "inbound");
    return inbound?.body?.trim() ?? "";
  }, [activeBubbles, activeIsSent, activeThread]);

  const inboundWorkflowSuggestions = useMemo(
    () => suggestInboundMessageWorkflows(latestInboundMessageText),
    [latestInboundMessageText],
  );

  const workflowResident = useMemo(() => {
    const email = activeThread?.email?.trim() ?? "";
    if (!email) return null;
    return resolveManagerServiceResidentByEmail(userId, email);
  }, [activeThread?.email, userId]);

  const openInboundWorkflow = useCallback(
    (kind: InboundWorkflowSuggestionKind) => {
      setWorkflowMessageText(latestInboundMessageText);
      if (kind === "maintenance_work_order") setWorkflowWorkOrderOpen(true);
      else setWorkflowServiceOpen(true);
    },
    [latestInboundMessageText],
  );

  // ---- Scheduled / automated messages, INLINE in the person's thread --------
  // The old standalone Schedule table is gone; upcoming messages to this person
  // render as "Scheduled · sends <when>" cards at the tail of their conversation,
  // cancelable / send-now / editable in place.
  const [scheduledBusyId, setScheduledBusyId] = useState<string | null>(null);

  const threadScheduledItems = useMemo(
    () =>
      activeThread
        ? scheduledItemsForRecipient(
            activeThread.email,
            manualScheduledMessages,
            scheduledMessages,
            automationChannelDefaultsFromSettings(reminderAutomationSettings),
          )
        : [],
    [activeThread, manualScheduledMessages, reminderAutomationSettings, scheduledMessages],
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
      next: {
        subject: string;
        body: string;
        deliverViaEmail?: boolean;
        deliverViaSms?: boolean;
        sendAt?: string;
      },
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
              ...(next.sendAt ? { sendAt: next.sendAt } : {}),
            }),
          });
          if (!res.ok) throw new Error(await readPortalApiError(res, "Could not save changes."));
        } else {
          await patchScheduledMessage(item.id, {
            customSubject: next.subject,
            customBody: next.body,
            ...(next.sendAt ? { customSendAt: next.sendAt } : {}),
            ...(next.deliverViaEmail !== undefined ? { customDeliverViaEmail: next.deliverViaEmail } : {}),
            ...(next.deliverViaSms !== undefined ? { customDeliverViaSms: next.deliverViaSms } : {}),
          });
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
    [markReadSilent, setExpandedId],
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
    if (
      !hasInboxReplyChannelSelected({
        viaEmail: replyViaEmail && activeEmailAvailable,
        viaSms: replyViaSms && activeSmsAvailable,
        viaProplane: replyViaProplane && activeProplaneAvailable,
      })
    ) {
      showToast("Choose PropLane, Email, SMS, or a combination.");
      return;
    }
    if (replyAttachments.some((a) => a.uploading)) {
      showToast("Wait for uploads to finish.");
      return;
    }

    // Ticked "Schedule for later" — the same press SCHEDULES rather than sends,
    // so there is one send button and no second way to fire the message.
    if (scheduleLater) {
      const sendAt = new Date(scheduleSendAt);
      if (Number.isNaN(sendAt.getTime())) {
        showToast("Choose a valid send date and time.");
        return;
      }
      if (sendAt.getTime() < Date.now() - 60_000) {
        showToast("Send time must be in the future.");
        return;
      }
      setReplySending(true);
      try {
        const res = await fetch("/api/portal/scheduled-inbox-messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            senderPortal: "manager",
            subject: activeThread.subject || `Message for ${activeThread.from || activeThread.email}`,
            body: text,
            sendAt: sendAt.toISOString(),
            recipientEmail: activeThread.email,
            recipientName: activeThread.from || activeThread.email,
            deliverViaEmail: replyViaEmail && activeEmailAvailable,
            deliverViaSms: replyViaSms && activeSmsAvailable,
          }),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => null)) as { error?: string } | null;
          showToast(payload?.error ?? "Could not schedule message.");
          return;
        }
        // Clear the reply only on success, so a refused schedule never loses
        // what the manager typed.
        setReplyDraft("");
        clearInboxReplyDraft(activeThread.id);
        setReplyAttachments([]);
        setScheduleLater(false);
        showToast("Message scheduled.");
        // Pull the pinned "N scheduled" card back in. Without this the
        // conversation still shows the OLD count, so a manager who just
        // scheduled something sees no sign it worked and schedules it twice.
        reloadScheduled();
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
        activeThread.id,
        text,
        {
          email: replyViaEmail,
          sms: replyViaSms,
          proplane: replyViaProplane,
        },
        attachmentUrls,
      );
      if (!outcome) return;
      setReplyDraft("");
      clearInboxReplyDraft(activeThread.id);
      adoptedAiDraftByThreadRef.current.delete(activeThread.id);
      setAdoptedAiDraftThreadId(null);
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
    replyViaProplane,
    activeEmailAvailable,
    activeSmsAvailable,
    activeProplaneAvailable,
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
        // A queued automation draft still waiting on this thread is kept
        // behind the fresh reply draft, never silently replaced by it.
        const next = localRef.current.map((thread) =>
          thread.id === threadId
            ? {
                ...thread,
                aiDraft: data.draft,
                aiDraftQueue:
                  thread.aiDraft?.status === "pending_approval" && thread.aiDraft.text !== data.draft?.text
                    ? [thread.aiDraft, ...(thread.aiDraftQueue ?? [])]
                    : thread.aiDraftQueue,
              }
            : thread,
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
    if (adoptedAiDraftByThreadRef.current.has(activeThread.id)) {
      adoptedAiDraftByThreadRef.current.delete(activeThread.id);
      setReplyDraft("");
      clearInboxReplyDraft(activeThread.id);
    }
    const updated: InboxThread = advanceInboxAiDraft(activeThread);
    const next = local.map((t) => (t.id === activeThread.id ? updated : t));
    setDiscardedDraftIds((prev) => new Set(prev).add(activeThread.id));
    persistInboxRef.current = false;
    setLocal(next);
    await upsertPersistedInboxRows(MANAGER_INBOX_STORAGE_KEY, [updated], next);
    persistInboxRef.current = true;
  }, [activeThread, local, setReplyDraft]);

  const approveActiveDraft = useCallback(async () => {
    // The normal composer is the only send surface. Auto-send and Approve must
    // deliver what is on screen (replyDraft), never a hidden server aiDraft that
    // dirty-composer protection refused to insert.
    const pending = activeThread?.aiDraft?.text.trim() ?? "";
    const text = replyDraft.trim();
    if (!activeThread || !pending || !text) return false;
    if (text !== pending) return false;
    // Resolve against live availability so auto-send (and a stale picker
    // state right after opening a phone-only thread) still picks SMS when
    // email is impossible — never toast "choose a channel" and stick the
    // auto-send latch forever.
    const channels = {
      viaEmail: replyViaEmail && activeEmailAvailable,
      viaSms: replyViaSms && activeSmsAvailable,
      viaProplane: replyViaProplane && activeProplaneAvailable,
    };
    if (!hasInboxReplyChannelSelected(channels)) {
      showToast("Choose PropLane, Email, SMS, or a combination.");
      return false;
    }
    setApprovingDraft(true);
    try {
      const outcome = await handleReply(activeThread.id, text, {
        email: channels.viaEmail,
        sms: channels.viaSms,
        proplane: channels.viaProplane,
      });
      if (outcome) {
        adoptedAiDraftByThreadRef.current.delete(activeThread.id);
        setAdoptedAiDraftThreadId(null);
        setReplyDraft("");
        clearInboxReplyDraft(activeThread.id);
        showToast(inboxReplySentToastMessage(outcome));
      }
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
  }, [
    activeEmailAvailable,
    activeProplaneAvailable,
    activeSmsAvailable,
    activeThread,
    handleReply,
    replyDraft,
    replyViaEmail,
    replyViaProplane,
    replyViaSms,
    setReplyDraft,
    showToast,
  ]);

  useEffect(() => {
    autoSentDraftRef.current = null;
  }, [activeThread?.id]);

  useEffect(() => {
    if (!aiAutoSend || !activeThread?.aiDraft?.text) return;
    if (activeThread.aiDraft.status !== "pending_approval") return;
    // A draft the workspace queued FOR review is the one thing auto-send must
    // never touch — the manager turned that on to see it first.
    if (activeThread.aiDraft.requiresReview) return;
    // Fail closed when the visible composer does not hold this pending draft.
    if (!activeAiDraftAdopted) return;
    if (approvingDraft || draftingIds.has(activeThread.id)) return;
    if (!hasInboxReplyChannelSelected({
      viaEmail: activeEmailAvailable && replyViaEmail,
      viaSms: activeSmsAvailable && replyViaSms,
      viaProplane: activeProplaneAvailable && replyViaProplane,
    })) return;
    const key = `${activeThread.id}:${activeThread.aiDraft.text}`;
    if (autoSentDraftRef.current === key) return;
    autoSentDraftRef.current = key;
    void approveActiveDraft().then((sent) => {
      if (!sent) autoSentDraftRef.current = null;
    });
  }, [
    aiAutoSend,
    activeAiDraftAdopted,
    activeThread?.id,
    activeThread?.aiDraft?.text,
    activeThread?.aiDraft?.status,
    activeThread?.aiDraft?.requiresReview,
    activeEmailAvailable,
    activeSmsAvailable,
    activeProplaneAvailable,
    replyViaEmail,
    replyViaSms,
    replyViaProplane,
    approvingDraft,
    draftingIds,
    approveActiveDraft,
  ]);

  const replySendingAs = useMemo(
    () => ({
      sms: smsSendingNumber ? formatTourContactPhoneDisplay(smsSendingNumber) : undefined,
      email: workEmailAddress ?? (viewerEmail?.trim() || undefined),
      proplane: "PropLane",
    }),
    [smsSendingNumber, viewerEmail, workEmailAddress],
  );

  const replyChannelPicker = (
    <InboxReplyChannelPicker
      viaEmail={replyViaEmail}
      viaSms={replyViaSms}
      viaProplane={replyViaProplane}
      onViaProplaneChange={setReplyViaProplane}
      onViaEmailChange={setReplyViaEmail}
      onViaSmsChange={setReplyViaSms}
      emailAvailable={activeEmailAvailable}
      smsAvailable={activeSmsAvailable}
      proplaneAvailable={activeProplaneAvailable}
      onAddEmail={canAddThreadEmail ? openThreadPhone : undefined}
      onAddPhone={canAddThreadPhone ? openThreadPhone : undefined}
      smsDisabledReason={smsDisabledReason}
      sendingAs={replySendingAs}
    />
  );

  const replyChannelMenu = (
    <InboxComposerChannelMenu
      viaEmail={replyViaEmail}
      viaSms={replyViaSms}
      viaProplane={replyViaProplane}
      onViaProplaneChange={setReplyViaProplane}
      onViaEmailChange={setReplyViaEmail}
      onViaSmsChange={setReplyViaSms}
      emailAvailable={activeEmailAvailable}
      smsAvailable={activeSmsAvailable}
      proplaneAvailable={activeProplaneAvailable}
      onAddEmail={canAddThreadEmail ? openThreadPhone : undefined}
      onAddPhone={canAddThreadPhone ? openThreadPhone : undefined}
      smsDisabledReason={smsDisabledReason}
      sendingAs={replySendingAs}
    />
  );

  const showAiDraftUi = Boolean(
    activeThread && !activeIsAssistantThread && activeThread.folder === "inbox",
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

  const bulkDeleteForever = async () => {
    if (!(await confirm({ description: `Delete ${threadSelection.selectedIds.size} message(s) permanently?` }))) return;
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
    <RowSelectCheckbox
      checked={threadSelection.selectedIds.has(thread.id)}
      onChange={() => threadSelection.toggleSelected(thread.id)}
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
                leading={rowCheckbox(thread)}
              />
            );
          })
        )}
      </div>
    </div>
  );

  const threadContactEditButton = canEditThreadContact ? (
    <button
      type="button"
      className={INBOX_THREAD_ICON_BTN}
      aria-label="Edit contact details"
      title="Edit contact details"
      data-attr="inbox-thread-contact-edit"
      onClick={openThreadPhone}
    >
      <Pencil className="h-4 w-4" aria-hidden />
    </button>
  ) : null;

  /*
   * The thread header carries its OWN conversation controls — edit, archive,
   * delete. This used to be gated on `externalTitleActions`, a flag meaning
   * "the page header is carrying them instead", which stopped being true once
   * Communication's page chrome moved to the title band: the flag read false
   * here and the header rendered a lone pen with no way to archive.
   *
   * The resident-detail chat tab is the one surface that keeps none: it hides
   * the identity header entirely and archiving there belongs to the inbox.
   */
  const showThreadHeaderActions = !embeddedResidentChat;

  /*
   * The header names the PERSON and then says who they are and where they
   * live. It used to lead with the raw address on a thread the manager had
   * sent — "ethan.wright.workflow@test.proplane.local" over "Ethan Wright ·
   * Application update" — which inverts the two: an address as the headline
   * and the human as a caption.
   */
  const activeThreadTitle = activeThread
    ? activeIsAssistantThread
      ? activeThread.from || "PropLane Assistant"
      : inboxCounterpartyName(activeThread.email, activeIsSent ? null : activeThread.from, filterContacts) ||
        activeThread.email ||
        "Unknown sender"
    : "";

  /**
   * The thread header is a compact contact card: role · property · room ·
   * phone · email on one line, with Call and Open resident beside the
   * conversation controls. Everything the manager used to open a second tab
   * for sits above the messages.
   */
  const activeThreadContact = useMemo(
    () =>
      activeThread && !activeIsAssistantThread
        ? filterContacts?.find(
            (c) => c.email.trim().toLowerCase() === activeThread.email.trim().toLowerCase(),
          ) ?? null
        : null,
    [activeThread, activeIsAssistantThread, filterContacts],
  );
  const activeThreadPhone = activeSmsTarget?.phone?.trim() || "";

  const activeThreadSubtitle = (() => {
    if (!activeThread || activeIsAssistantThread) return undefined;
    const contact = activeThreadContact;
    // The directory's role union is not the filter's ("manager" vs
    // "management"), so map rather than cast — a cast would print "PropLane
    // admin" for a manager.
    const role =
      contact?.role === "resident"
        ? contact.tenancyStatus === "applicant"
          ? "Applicant"
          : contact.tenancyStatus === "past"
            ? "Past resident"
            : "Resident"
        : contact?.role === "vendor"
          ? "Vendor"
          : contact?.role === "manager"
            ? "Manager"
            : null;
    const place = [inboxRowAddressLabel(contact?.propertyLabel), contact?.roomLabel]
      .filter(Boolean)
      .join(", ");
    const parts = [
      role,
      place,
      activeThreadPhone ? formatTourContactPhoneDisplay(activeThreadPhone) : null,
      activeThread.email?.trim() || null,
    ].filter(Boolean) as string[];
    if (parts.length > 0) return parts.join(" · ");
    // Nothing known about them beyond the address they write from — better than
    // repeating the subject, which the open thread already shows.
    return activeThread.email || activeThread.subject || undefined;
  })();

  const activeResidentHref = (() => {
    const contact = activeThreadContact;
    if (!contact || contact.role !== "resident" || !contact.id.startsWith("res-")) return null;
    const tab =
      contact.tenancyStatus === "applicant" ? "potential" : contact.tenancyStatus === "past" ? "past" : "current";
    return residentDetailHref(portalBase, tab, contact.id.slice(4), "application");
  })();

  const threadContactActions =
    activeThread && !activeIsAssistantThread && !embeddedResidentChat ? (
      <>
        {activeThreadPhone ? (
          <a
            href={`tel:${activeThreadPhone}`}
            className={INBOX_THREAD_ICON_BTN}
            aria-label="Call"
            title={`Call ${formatTourContactPhoneDisplay(activeThreadPhone)}`}
            data-attr="inbox-thread-call"
          >
            <Phone className="h-4 w-4" aria-hidden />
          </a>
        ) : null}
        {activeResidentHref ? (
          <Link
            href={activeResidentHref}
            className={INBOX_THREAD_ICON_BTN}
            aria-label="Open resident"
            title="Open resident"
            data-attr="inbox-thread-open-resident"
          >
            <UserRound className="h-4 w-4" aria-hidden />
          </Link>
        ) : null}
      </>
    ) : null;

  const threadHeaderActions =
    activeThread && showThreadHeaderActions ? (
    activeThread.folder === "trash" ? (
      <>
        {!activeIsAssistantThread ? (
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
        ) : null}
        {!activeIsAssistantThread ? (
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
        ) : onClearAssistant ? (
        <button
          type="button"
          className={INBOX_THREAD_ICON_BTN_DANGER}
          aria-label="Clear PropLane Assistant"
          title="Clear"
          data-attr="inbox-thread-clear-assistant"
          onClick={() => void onClearAssistant()}
        >
          <Eraser className="h-4 w-4" aria-hidden />
        </button>
        ) : null}
      </>
    ) : (
      <>
        {/* One row of matching circular controls: call, open, edit, archive, delete. */}
        {threadContactActions}
        {threadContactEditButton}
        {!activeIsAssistantThread ? (
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
        ) : null}
        {!activeIsAssistantThread ? (
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
        ) : onClearAssistant ? (
        <button
          type="button"
          className={INBOX_THREAD_ICON_BTN_DANGER}
          aria-label="Clear PropLane Assistant"
          title="Clear"
          data-attr="inbox-thread-clear-assistant"
          onClick={() => void onClearAssistant()}
        >
          <Eraser className="h-4 w-4" aria-hidden />
        </button>
        ) : null}
      </>
    )
  ) : activeThread && embeddedInCommunication ? (
    <>
      {threadContactActions}
      {threadContactEditButton}
    </>
  ) : null;

  const scheduledCards =
    activeThread &&
    !embeddedInCommunication &&
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
            channelEditable={item.editable}
            source={item.source}
            editable={item.editable}
            busy={scheduledBusyId === item.id}
            recipient={activeThread.email}
            sendAt={item.sendAt}
            onCancel={() => { if (item.deliveryStatus !== "sending") void cancelScheduledItem(item); }}
            onSendNow={() => { if (item.deliveryStatus !== "sending") void sendScheduledItemNow(item); }}
            onSaveEdit={item.editable ? (next) => saveScheduledEdit(item, next) : undefined}
          />
        ))}
      </InboxScheduledThreadList>
    ) : null;

  const threadPane = activeThread ? (
    <InboxThreadView
      title={activeThreadTitle}
      avatarName={
        activeIsSent
          ? activeThread.email || undefined
          : activeThread.from || activeThread.email || undefined
      }
      subtitle={activeThreadSubtitle}
      messages={activeBubbles}
      alignAssistantStart={activeIsAssistantThread}
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
            {/* `folder` is already narrowed to "sent" | "inbox" by the trash guard above. */}
            {inboundWorkflowSuggestions.length > 0 && !activeIsSent ? (
              <InboundMessageWorkflowCard
                suggestions={inboundWorkflowSuggestions}
                onSelect={openInboundWorkflow}
              />
            ) : null}
            {/* Draft with PropLane, Ask PropLane and Schedule live in the composer
                row (its ✦ and 🕒 tools). Only a draft in flight, a failed
                draft, or a draft waiting for approval still shows above it. */}
            {showAiDraftUi ? (
              <AiDraftReplyCard
                drafting={draftingIds.has(activeThread.id) && !activeThread.aiDraft?.text}
                draft={
                  activeThread.aiDraft?.status === "pending_approval" ? activeThread.aiDraft.text : undefined
                }
                error={draftErrors[activeThread.id]}
                approving={approvingDraft}
                onApprove={() => void approveActiveDraft()}
                onDiscard={() => void discardActiveDraft()}
                onAdopt={(text) => {
                  insertAiDraftIntoReply(activeThread.id, text, true);
                }}
                adopted={activeAiDraftAdopted}
                autoSend={aiAutoSend}
                onAutoSendChange={embeddedInCommunication ? undefined : setAiAutoSend}
                maxLength={
                  !embeddedInCommunication && replyViaSms && !replyViaEmail ? 1600 : undefined
                }
                onGenerate={() => {
                  draftAttemptedRef.current.delete(activeThread.id);
                  void requestInboxAiDraft(activeThread.id, true);
                }}
                hideGenerateButton
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
              hideTrigger
              openSignal={askAssistantSignal}
            />
            <InboxComposer
              value={replyDraft}
              onChange={(next) => {
                setReplyDraft(next);
                if (!next.trim() && adoptedAiDraftThreadId === activeThread.id) {
                  void discardActiveDraft();
                }
              }}
              onSubmit={() => void sendActiveReply()}
              sending={replySending}
              placeholder="Write a reply…"
              maxLength={!embeddedInCommunication && replyViaSms && !replyViaEmail ? 1600 : undefined}
              dataAttr="inbox-reply"
              focusSignal={replyFocusSignal}
              hint={
                scheduleLater && inboxThreadHasEmail(activeThread.email)
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
                  <InboxComposerAiMenu
                    disabled={draftingIds.has(activeThread.id)}
                    onDraft={
                      showAiDraftUi && activeThread.aiDraft?.status !== "pending_approval"
                        ? () => {
                            draftAttemptedRef.current.delete(activeThread.id);
                            void requestInboxAiDraft(activeThread.id, true);
                          }
                        : undefined
                    }
                    onAsk={() => setAskAssistantSignal((n) => n + 1)}
                  />
                  {inboxThreadHasEmail(activeThread.email) ? (
                    <InboxComposerScheduleMenu
                      scheduleLater={scheduleLater}
                      onScheduleLaterChange={setScheduleLater}
                      sendAt={scheduleSendAt}
                      onSendAtChange={setScheduleSendAt}
                    />
                  ) : null}
                  {showReplyChannelPicker ? replyChannelMenu : null}
                </>
              }
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
  ) : expandedId ? (
    <InboxThreadSkeleton />
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

      <ManagerCreateWorkOrderModal
        open={workflowWorkOrderOpen}
        onClose={() => setWorkflowWorkOrderOpen(false)}
        onSubmitted={() => {
          setWorkflowWorkOrderOpen(false);
          showToast("Service created.");
        }}
        managerUserId={userId}
        defaultResident={workflowResident}
        defaultTitle={workflowTitleFromMessage(workflowMessageText, "Maintenance request")}
        defaultDescription={workflowMessageText}
      />
      <ManagerCreateServiceRequestModal
        open={workflowServiceOpen}
        onClose={() => setWorkflowServiceOpen(false)}
        onSubmitted={() => {
          setWorkflowServiceOpen(false);
          showToast("Add-on service request created.");
        }}
        managerUserId={userId}
        defaultResident={workflowResident}
        defaultNotes={workflowMessageText}
      />

      <PortalContactDetailsModal
        open={threadPhoneOpen}
        onClose={() => setThreadPhoneOpen(false)}
        initial={{
          name: activeThread?.from?.trim() || "",
          phone: activeSmsTarget?.phone?.trim() || "",
          email: activeThread?.email?.trim() || "",
        }}
        onSave={(values) => void saveThreadContact(values)}
        saving={savingThreadPhone}
        error={threadPhoneError}
        formId="inbox-thread-contact-details-form"
      />

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
