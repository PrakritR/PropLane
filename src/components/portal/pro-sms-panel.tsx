"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronLeft, Pencil, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { ManagerSmsComposeModal } from "@/components/portal/pro-sms-compose-modal";
import {
  PortalContactDetailsModal,
  type PortalContactDetailsValues,
} from "@/components/portal/portal-contact-details-modal";
import {
  buildInboxThreadAssistantContext,
  InboxThreadAssistantStrip,
} from "@/components/portal/inbox-thread-assistant-strip";
import {
  INBOX_LIST_SCROLL,
  InboxAvatar,
  InboxComposer,
  InboxReplyChannelPicker,
  InboxThreadEmpty,
  InboxTwoPane,
  PortalInboxEmptyState,
  type InboxListSegment,
} from "@/components/portal/portal-inbox-ui";
import {
  dispatchManagerSmsContactsChanged,
  MANAGER_SMS_SORT_OPTIONS,
  normalizeManagerSmsConversationsPayload,
  smsConversationDisplayName,
  smsConversationSubtitle,
  sortSmsConversationRows,
  smsThreadHasUnread,
  type ManagerSmsConversationsPayload,
  type ManagerSmsMessageRow,
  type ManagerSmsResidentConversation,
  type ManagerSmsSortId,
} from "@/lib/manager-sms-messages";
import { isVoiceCallNoteSid } from "@/lib/voice/voice-call-notes";
import {
  threadPassesCommunicationFilters,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import { counterpartyRoleLabel } from "@/lib/sms-conversation-identity";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { formatPacificDate } from "@/lib/pacific-time";
import { useInboxThreadScroll } from "@/hooks/use-inbox-thread-scroll";
import {
  MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE,
  MANUAL_SMS_UNKNOWN_MESSAGE,
  resolveManualSmsAttempt,
  type ManualSmsAttempt,
} from "@/lib/sms/manual-send-attempt";
import {
  archiveManagerSmsConversation,
  loadManagerSmsArchivedIds,
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT,
  restoreManagerSmsConversation,
} from "@/lib/manager-sms-archive.client";

const SMS_OPENED_STORAGE_KEY = "axis_manager_sms_opened_v1";
// v2 stores CONVERSATION IDs, not phones: since one phone can be two threads
// (prospect + resident), hiding by phone made deleting one thread visually
// erase the other as well.
const SMS_HIDDEN_STORAGE_KEY = "axis_manager_sms_hidden_v2";

// Site-themed surfaces (values resolve per light/dark via CSS variables) so the
// SMS panel matches the rest of the product instead of a hardcoded iOS look.
/** Outbound bubble / send accent — the site primary (cobalt light / indigo dark). */
/** Destructive red for swipe / delete affordances. */
const DELETE_RED = "var(--status-overdue-fg)";

function conversationId(resident: ManagerSmsResidentConversation): string {
  // The explicit conversation key separates two people on one shared line and
  // the same person across roles — prefer it over the phone so those threads
  // never collapse into one row.
  return (
    resident.conversationKey ??
    resident.phone ??
    resident.residentUserId ??
    resident.residentEmail ??
    resident.name
  );
}

/** iOS Messages list timestamp: time today, weekday this week, else short date. */
function iosListTimestamp(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayDiff = Math.round((startOfToday.getTime() - startOfMsg.getTime()) / 86_400_000);
  if (dayDiff === 0) {
    return formatPacificDate(d, { hour: "numeric", minute: "2-digit" });
  }
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff > 1 && dayDiff < 7) {
    return formatPacificDate(d, { weekday: "short" });
  }
  return formatPacificDate(d, { month: "numeric", day: "numeric", year: "2-digit" });
}

function loadOpenedIds(): Set<string> {
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

function persistOpenedIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SMS_OPENED_STORAGE_KEY, JSON.stringify([...ids]));
}

function loadHiddenConversationIds(): Set<string> {
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

function persistHiddenConversationIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(SMS_HIDDEN_STORAGE_KEY, JSON.stringify([...ids]));
}

export type ManagerSmsPanelHandle = {
  openCompose: () => void;
  reload: () => void;
};

export const ManagerSmsPanel = forwardRef<
  ManagerSmsPanelHandle,
  {
    filterResidentEmail?: string | null;
    filterResidentUserId?: string | null;
    threadFilters?: CommunicationThreadFilters;
    filterContacts?: InboxScopedContact[];
    onUnreadCountChange?: (unread: number) => void;
    onSentNavigate?: () => void;
    /**
     * When false (Communication shell), New message lives in the page header.
     * When true (e.g. resident detail), keep an inline compose modal via openCompose().
     */
    allowInlineCompose?: boolean;
    /**
     * Conversations API base (GET grouped / POST send / DELETE). Defaults to the
     * manager route; admin oversight passes its own admin-scoped endpoint, which
     * also copies every send to the admin phone.
     */
    endpoint?: string;
    /**
     * Whether this surface may DELETE conversations. Must be false for any
     * endpoint without a DELETE handler — otherwise the swipe/trash actions
     * confirm a destructive dialog and then always fail with a 405 that the
     * generic toast hides. Admin oversight is read/send only.
     */
    allowDelete?: boolean;
    /** When true, only the open thread pane is rendered (unified Communication list lives elsewhere). */
    suppressListPane?: boolean;
    controlledActiveId?: string | null;
    onControlledActiveIdChange?: (id: string | null) => void;
    onConversationOpened?: () => void;
    /** When embedded in unified Communication — drives archive/restore chrome. */
    listSegment?: InboxListSegment;
    /** Fires after archive or restore so the parent list can refresh. */
    onArchived?: () => void;
    /** Let the portal page scroll the thread instead of a nested pane (resident profile). */
    pageScroll?: boolean;
  }
>(function ManagerSmsPanel(
  {
    filterResidentEmail,
    filterResidentUserId,
    threadFilters,
    filterContacts,
    onUnreadCountChange,
    onSentNavigate,
    allowInlineCompose = true,
    endpoint = "/api/manager/sms-conversations",
    allowDelete = true,
    suppressListPane = false,
    controlledActiveId,
    onControlledActiveIdChange,
    onConversationOpened,
    listSegment = "active",
    onArchived,
    pageScroll = false,
  },
  ref,
) {
  const { showToast } = useAppUi();
  const [data, setData] = useState<ManagerSmsConversationsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openedSmsIds, setOpenedSmsIds] = useState<Set<string>>(() => loadOpenedIds());
  // Mirrors `openedSmsIds` so `markOpened` can build and persist the next set
  // without waiting for React to run a state updater — see the comment there.
  const openedSmsIdsRef = useRef(openedSmsIds);
  const [hiddenConversationIds, setHiddenConversationIds] = useState<Set<string>>(() =>
    loadHiddenConversationIds(),
  );
  const [archivedConversationIds, setArchivedConversationIds] = useState<Set<string>>(() =>
    loadManagerSmsArchivedIds(),
  );
  const [composeOpen, setComposeOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ManagerSmsSortId>("newest");
  const [internalActiveId, setInternalActiveId] = useState<string | null>(null);
  const activeId = controlledActiveId !== undefined ? controlledActiveId : internalActiveId;
  const setActiveId = useCallback(
    (id: string | null | ((prev: string | null) => string | null)) => {
      const resolve = (prev: string | null) => (typeof id === "function" ? id(prev) : id);
      if (controlledActiveId !== undefined) {
        onControlledActiveIdChange?.(resolve(controlledActiveId));
      } else {
        setInternalActiveId(resolve);
      }
    },
    [controlledActiveId, onControlledActiveIdChange],
  );
  const [draft, setDraft] = useState("");
  const [replyViaEmail, setReplyViaEmail] = useState(false);
  const [replyViaSms, setReplyViaSms] = useState(true);
  const [replyIssue, setReplyIssue] = useState<string | null>(null);
  const replyAttemptRef = useRef<ManualSmsAttempt | null>(null);
  const [sending, setSending] = useState(false);
  const [pendingOutboundByRow, setPendingOutboundByRow] = useState<Record<string, ManagerSmsMessageRow[]>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [contactNameOpen, setContactNameOpen] = useState(false);
  const [contactNameError, setContactNameError] = useState<string | null>(null);
  const [savingContactName, setSavingContactName] = useState(false);
  // Keep the latest onConversationOpened without making it an effect dependency —
  // parents pass an inline callback that changes identity every render, and letting
  // that (or `rows` churn) retrigger the controlled-open sync causes an infinite
  // render loop ("Maximum update depth exceeded").
  const onConversationOpenedRef = useRef(onConversationOpened);
  useEffect(() => {
    onConversationOpenedRef.current = onConversationOpened;
  }, [onConversationOpened]);
  const lastSyncedControlledIdRef = useRef<string | null>(null);

  useEffect(() => {
    const sync = () => setArchivedConversationIds(loadManagerSmsArchivedIds());
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, sync as EventListener);
    return () => window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, sync as EventListener);
  }, []);

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setLoading(true);
    setError(null);
    try {
      const res = await fetch(endpoint, { credentials: "include", cache: "no-store" });
      const body = (await res.json()) as ManagerSmsConversationsPayload & { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not load SMS.");
      setData(normalizeManagerSmsConversationsPayload(body));
    } catch (e) {
      if (!opts?.quiet) setError(e instanceof Error ? e.message : "Could not load SMS.");
    } finally {
      if (!opts?.quiet) setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep inbound prospect replies visible without a hard refresh.
  useEffect(() => {
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load({ quiet: true });
    };
    const id = window.setInterval(tick, 20_000);
    const onVis = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);

  useImperativeHandle(
    ref,
    () => ({
      openCompose: () => {
        if (allowInlineCompose) setComposeOpen(true);
      },
      reload: () => {
        void load();
      },
    }),
    [allowInlineCompose, load],
  );

  const residents = useMemo(() => {
    const all = data?.residents ?? [];
    const email = filterResidentEmail?.trim().toLowerCase();
    const userId = filterResidentUserId?.trim();
    let scoped = all;
    if (email || userId) {
      scoped = all.filter((resident) => {
        if (userId && resident.residentUserId === userId) return true;
        if (email && resident.residentEmail?.trim().toLowerCase() === email) return true;
        return false;
      });
    }
    if (!threadFilters || !filterContacts) return scoped;
    return scoped.filter((resident) =>
      threadPassesCommunicationFilters({
        filters: threadFilters,
        contacts: filterContacts,
        counterpartyEmail: resident.residentEmail,
        propertyLabel: resident.propertyLabel,
        counterpartyRole: resident.counterpartyRole,
      }),
    );
  }, [data?.residents, filterResidentEmail, filterResidentUserId, threadFilters, filterContacts]);

  const rows = useMemo(() => {
    return residents
      .map((resident) => {
        const messages = Array.isArray(resident.messages) ? resident.messages : [];
        const lastMessage = messages[messages.length - 1] ?? null;
        const rowId = conversationId(resident);
        return {
          resident,
          messages,
          lastMessage,
          rowId,
          unread: smsThreadHasUnread(messages, openedSmsIds),
          hidden: hiddenConversationIds.has(rowId),
          archived: archivedConversationIds.has(rowId),
        };
      })
      // iOS Messages: only threads with texts (or not locally deleted).
      .filter((row) => {
        if (row.hidden) return false;
        if (!row.lastMessage) return listSegment === "active";
        if (listSegment === "archived") return row.archived;
        if (listSegment === "unread") return !row.archived && row.unread;
        return !row.archived;
      });
  }, [archivedConversationIds, hiddenConversationIds, listSegment, openedSmsIds, residents]);

  const unreadCount = useMemo(() => rows.filter((r) => r.unread).length, [rows]);

  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
  }, [onUnreadCountChange, unreadCount]);

  const visibleRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? rows.filter((r) => {
          const hay = [
            r.resident.name,
            r.resident.phone,
            r.resident.residentEmail,
            r.resident.propertyLabel,
            r.lastMessage?.body,
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        })
      : rows;
    return sortSmsConversationRows(filtered, sort);
  }, [rows, search, sort]);

  const active = useMemo(() => {
    const fromList = visibleRows.find((r) => r.rowId === activeId) ?? rows.find((r) => r.rowId === activeId);
    if (fromList) return fromList;
    if (!activeId) return null;
    const resident = residents.find((r) => conversationId(r) === activeId);
    if (!resident) return null;
    const messages = Array.isArray(resident.messages) ? resident.messages : [];
    const lastMessage = messages[messages.length - 1] ?? null;
    if (hiddenConversationIds.has(activeId)) return null;
    return {
      resident,
      messages,
      lastMessage,
      rowId: activeId,
      unread: smsThreadHasUnread(messages, openedSmsIds),
      hidden: false,
      archived: archivedConversationIds.has(activeId),
    };
  }, [activeId, archivedConversationIds, hiddenConversationIds, openedSmsIds, residents, rows, visibleRows]);

  const { scrollRef: threadScrollRef, endRef: threadEndRef, handleScroll: handleThreadScroll } =
    useInboxThreadScroll(activeId ?? undefined, active?.messages.length ?? 0);

  // Persists synchronously, not from inside a state updater: callers notify a
  // parent (`onConversationOpened`) on the very next line, and that parent reads
  // the opened-id set back out of localStorage. React only runs an updater on
  // the following render, so writing there would leave the parent reading the
  // pre-open set and the unread dot stuck on the thread just opened.
  const markOpened = useCallback((messageIds: string[]) => {
    if (messageIds.length === 0) return;
    const prev = openedSmsIdsRef.current;
    if (messageIds.every((id) => prev.has(id))) return;
    const next = new Set(prev);
    for (const id of messageIds) next.add(id);
    openedSmsIdsRef.current = next;
    persistOpenedIds(next);
    setOpenedSmsIds(next);
  }, []);

  const openThread = useCallback(
    (rowId: string, messages: ManagerSmsMessageRow[]) => {
      setActiveId(rowId);
      markOpened(messages.filter((m) => m.direction === "inbound").map((m) => m.id));
      setDraft("");
      onConversationOpened?.();
    },
    [markOpened, onConversationOpened, setActiveId],
  );

  useEffect(() => {
    if (!controlledActiveId) {
      lastSyncedControlledIdRef.current = null;
      return;
    }
    // Only sync when the controlled selection actually changes — never on every
    // `rows` refetch or callback identity change, which would loop forever.
    if (lastSyncedControlledIdRef.current === controlledActiveId) return;
    const row =
      rows.find((r) => r.rowId === controlledActiveId) ??
      (() => {
        const resident = residents.find((r) => conversationId(r) === controlledActiveId);
        if (!resident) return null;
        const messages = Array.isArray(resident.messages) ? resident.messages : [];
        return { rowId: controlledActiveId, messages, resident };
      })();
    if (!row) return; // rows may load after the id is set; retry until present.
    lastSyncedControlledIdRef.current = controlledActiveId;
    markOpened(row.messages.filter((m) => m.direction === "inbound").map((m) => m.id));
    onConversationOpenedRef.current?.();
  }, [controlledActiveId, markOpened, residents, rows]);

  const composeResidents =
    filterResidentEmail || filterResidentUserId ? residents : (data?.residents ?? []);

  const handleSmsSent = useCallback(() => {
    void load().then(() => {
      onSentNavigate?.();
    });
  }, [load, onSentNavigate]);

  const archiveConversation = useCallback(
    (resident: ManagerSmsResidentConversation) => {
      const rowId = conversationId(resident);
      archiveManagerSmsConversation(rowId);
      setArchivedConversationIds(loadManagerSmsArchivedIds());
      setActiveId(null);
      onArchived?.();
      showToast("Moved to archived.");
    },
    [onArchived, setActiveId, showToast],
  );

  const restoreConversation = useCallback(
    (resident: ManagerSmsResidentConversation) => {
      const rowId = conversationId(resident);
      restoreManagerSmsConversation(rowId);
      setArchivedConversationIds(loadManagerSmsArchivedIds());
      setActiveId(null);
      onArchived?.();
      showToast("Restored.");
    },
    [onArchived, setActiveId, showToast],
  );

  const deleteConversation = useCallback(
    async (resident: ManagerSmsResidentConversation) => {
      const phone = resident.phone?.trim();
      if (!phone) {
        showToast("No phone on this conversation.");
        return;
      }
      const rowId = conversationId(resident);
      // One phone can be two threads (prospect + resident). Name the role so
      // the confirm matches what is actually about to be destroyed.
      const roleLabel = resident.counterpartyRole
        ? `${counterpartyRoleLabel(resident.counterpartyRole).toLowerCase()} conversation`
        : "conversation";
      const ok = window.confirm(
        `Delete the ${roleLabel} with ${resident.name}?\n\nThis removes only this thread's texts from Messages on this account.`,
      );
      if (!ok) return;
      setDeletingId(rowId);
      try {
        const res = await fetch(endpoint, {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          // The key, not the phone, identifies which of the two threads to drop.
          body: JSON.stringify({ phone, conversationKey: resident.conversationKey ?? null }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string; partial?: boolean };
        if (!res.ok) {
          showToast(body.error ?? "Could not delete conversation.");
          return;
        }
        if (body.partial) {
          // Part of the thread is already gone but part remains — hiding the
          // row would claim a completeness the server did not deliver.
          showToast(body.error ?? "Some texts could not be deleted. Try again.");
          void load();
          return;
        }
        setHiddenConversationIds((prev) => {
          const next = new Set(prev);
          next.add(rowId);
          persistHiddenConversationIds(next);
          return next;
        });
        if (activeId === rowId) setActiveId(null);
        showToast("Conversation deleted.");
        void load();
      } catch {
        showToast("Could not delete conversation.");
      } finally {
        setDeletingId(null);
      }
    },
    [activeId, endpoint, load, showToast],
  );

  const deleteSavedContact = useCallback(
    async (resident: ManagerSmsResidentConversation) => {
      const conversationKey = resident.conversationKey?.trim();
      if (!conversationKey) return;
      if (!window.confirm(`Remove ${smsConversationDisplayName(resident)} from contacts?`)) return;
      setDeletingId(conversationId(resident));
      try {
        const res = await fetch("/api/manager/sms-contacts", {
          method: "DELETE",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationKey }),
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          showToast(body.error ?? "Could not remove contact.");
          return;
        }
        dispatchManagerSmsContactsChanged();
        setActiveId(null);
        onArchived?.();
        showToast("Contact removed.");
        void load({ quiet: true });
      } catch {
        showToast("Could not remove contact.");
      } finally {
        setDeletingId(null);
      }
    },
    [load, onArchived, setActiveId, showToast],
  );

  useEffect(() => {
    setDraft("");
    setReplyViaEmail(false);
    setReplyViaSms(true);
    setReplyIssue(null);
    replyAttemptRef.current = null;
  }, [activeId]);

  /**
   * The editor also carries the reply address, so it opens for a directory
   * contact whose name is fixed — otherwise a text-only thread with a known
   * name has no way to gain its email channel.
   */
  const canEditContact = Boolean(active?.resident.conversationKey && active.resident.phone);

  const openContactName = useCallback(() => {
    if (!active || !canEditContact) return;
    setContactNameError(null);
    setContactNameOpen(true);
  }, [active, canEditContact]);

  const saveContactDetails = useCallback(async (values: PortalContactDetailsValues) => {
    if (!active?.resident.conversationKey) return;
    setSavingContactName(true);
    setContactNameError(null);
    try {
      const res = await fetch("/api/manager/sms-contacts", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationKey: active.resident.conversationKey,
          ...(values.name ? { displayName: values.name } : {}),
          phone: values.phone,
          email: values.email,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "Could not save contact details.");
      const movedNumber = values.phone !== (active.resident.phone?.trim() || "");
      if (!movedNumber) {
        setData((current) => current
          ? {
              ...current,
              residents: current.residents.map((resident) =>
                resident.conversationKey === active.resident.conversationKey
                  ? {
                      ...resident,
                      ...(values.name ? { savedContactName: values.name } : {}),
                      residentEmail: values.email || null,
                    }
                  : resident,
              ),
            }
          : current);
      } else {
        // The conversation key is derived from the number, so the old row is
        // gone — let the refetch rebuild the list rather than patch a stale key.
        setActiveId(null);
      }
      setContactNameOpen(false);
      showToast("Contact details saved.");
      dispatchManagerSmsContactsChanged();
      void load({ quiet: true });
    } catch (e) {
      setContactNameError(e instanceof Error ? e.message : "Could not save contact details.");
    } finally {
      setSavingContactName(false);
    }
  }, [active, load, setActiveId, showToast]);

  async function sendReply() {
    if (replyIssue) return;
    if (!active?.resident.phone && !replyViaEmail) return;
    const text = draft.trim();
    if (!text) return;
    if (!replyViaEmail && !replyViaSms) {
      showToast("Choose Email, SMS, or both.");
      return;
    }
    setSending(true);
    const pendingId = `pending-${Date.now()}`;
    const pendingRow: ManagerSmsMessageRow = {
      id: pendingId,
      direction: "outbound",
      body: text,
      fromPhone: null,
      toPhone: active?.resident.phone ?? "",
      messageSid: null,
      source: "work_number",
      createdAt: new Date().toISOString(),
    };
    // The SMS transcript only owns SMS bubbles. An email-only reply should not
    // briefly masquerade as an outbound text and then disappear on reload.
    if (active && replyViaSms) {
      setPendingOutboundByRow((prev) => ({
        ...prev,
        [active.rowId]: [...(prev[active.rowId] ?? []), pendingRow],
      }));
    }
    let smsRequestPending = false;
    let smsSucceeded = false;
    try {
      let smsOk = false;
      let emailOk = false;
      let smsQueued = false;
      let failureMessage = "";

      if (replyViaSms) {
        if (!active?.resident.phone) {
          showToast("No phone on this conversation.");
          return;
        }
        const attemptSignature = JSON.stringify([
          active.rowId,
          active.resident.phone,
          active.resident.residentUserId ?? null,
          active.resident.conversationKey ?? null,
          text,
        ]);
        const attempt = resolveManualSmsAttempt(
          replyAttemptRef.current,
          attemptSignature,
          1,
        );
        replyAttemptRef.current = attempt;
        smsRequestPending = true;
        const res = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": attempt.idempotencyKeys[0]!,
          },
          body: JSON.stringify({
            toPhone: active.resident.phone,
            text,
            residentUserId: active.resident.residentUserId,
            conversationKey: active.resident.conversationKey ?? null,
          }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          code?: string;
          error?: string;
          status?: string;
        };
        smsRequestPending = false;
        if (
          body.code === "delivery_outcome_unknown" ||
          body.status === "unknown"
        ) {
          setReplyIssue(MANUAL_SMS_UNKNOWN_MESSAGE);
          showToast(MANUAL_SMS_UNKNOWN_MESSAGE);
          return;
        }
        smsOk = res.ok;
        smsSucceeded = smsOk;
        smsQueued = res.ok && body.status !== "submitted";
        if (!smsOk) failureMessage = body.error?.trim() || "Text message failed.";
      }

      if (replyViaEmail) {
        const email = active?.resident.residentEmail?.trim();
        if (!email) {
          failureMessage ||= "No email is available for this conversation.";
        } else {
          const res = await fetch("/api/portal/send-inbox-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              fromName: "Property manager",
              toEmails: [email],
              subject: `Message from your property manager`,
              text,
              deliverToPortalInbox: true,
              eventCategory: "messages",
              senderPortal: "manager",
            }),
          });
          const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
          emailOk = res.ok && data.ok === true;
          if (!emailOk) failureMessage = data.error?.trim() || failureMessage;
        }
      }

      if (!smsOk && !emailOk) {
        replyAttemptRef.current = null;
        showToast(failureMessage || "Could not send.");
        return;
      }

      if (replyViaSms) {
        setHiddenConversationIds((prev) => {
          if (!active || !prev.has(active.rowId)) return prev;
          const next = new Set(prev);
          next.delete(active.rowId);
          persistHiddenConversationIds(next);
          return next;
        });
      }
      if (emailOk && smsOk) {
        showToast(smsQueued ? "Email sent; text message queued." : "Sent via email and text.");
      } else if (emailOk) {
        showToast(replyViaSms ? "Email sent. Text message failed." : "Email sent.");
      } else if (smsQueued) {
        showToast(replyViaEmail ? "Text message queued. Email failed." : "Text message queued.");
      } else {
        showToast(replyViaEmail ? "Text message sent. Email failed." : "Text message sent.");
      }
      setDraft("");
      replyAttemptRef.current = null;
      await load();
    } catch {
      if (smsRequestPending) {
        setReplyIssue(MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE);
        showToast(MANUAL_SMS_NETWORK_UNKNOWN_MESSAGE);
      } else if (smsSucceeded) {
        const message =
          "The text message was sent, but the email outcome could not be confirmed. Do not resend this message. Check the conversation later.";
        setReplyIssue(message);
        setDraft("");
        showToast(message);
      } else {
        replyAttemptRef.current = null;
        showToast("Could not send.");
      }
    } finally {
      if (active) {
        setPendingOutboundByRow((prev) => {
          const next = { ...prev };
          delete next[active.rowId];
          return next;
        });
      }
      setSending(false);
    }
  }

  const activeEmailAvailable = Boolean(active?.resident.residentEmail?.trim());

  const showThread = Boolean(activeId && active);

  const listPane = (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 px-3.5 pb-2 pt-[max(0.75rem,env(safe-area-inset-top,0px))] lg:pt-4">
        <h2 className="text-sm font-semibold tracking-tight text-foreground">Messages</h2>
      </header>

      <div className="portal-inbox-list-toolbar flex shrink-0 items-center gap-2 border-b border-border px-3 pb-2.5">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">Search conversations</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search"
            enterKeyHint="search"
            className="portal-inbox-search h-10 w-full rounded-full border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted/70 focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
            data-attr="sms-messages-search"
          />
        </label>
        <label className="sr-only" htmlFor="sms-sort">
          Sort conversations
        </label>
        <Select
          id="sms-sort"
          value={sort}
          onChange={(e) => setSort(e.target.value as ManagerSmsSortId)}
          className="h-10 shrink-0 rounded-full border border-border bg-card px-2.5 text-xs font-medium text-foreground outline-none focus:border-primary/40"
          data-attr="sms-messages-sort"
          aria-label="Sort conversations"
        >
          {MANAGER_SMS_SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </Select>
      </div>

      <div className={INBOX_LIST_SCROLL}>
        {loading ? <p className="px-4 py-8 text-center text-sm text-muted">Loading…</p> : null}
        {error ? (
          <div className="px-4 py-6 text-center text-sm text-danger">
            {error}{" "}
            <button type="button" className="underline" onClick={() => void load()}>
              Retry
            </button>
          </div>
        ) : null}
        {!loading && !error && visibleRows.length === 0 ? (
          <div className="p-4">
            <PortalInboxEmptyState title={search.trim() ? `No messages match “${search.trim()}”.` : "No messages yet."} />
          </div>
        ) : null}
        <ul>
          {visibleRows.map((row) => (
            <ConversationRow
              key={row.rowId}
              name={smsConversationDisplayName(row.resident)}
              subtitle={smsConversationSubtitle(row.resident)}
              preview={
                row.lastMessage
                  ? `${row.lastMessage.direction === "outbound" ? "You: " : ""}${row.lastMessage.body}`
                  : ""
              }
              time={iosListTimestamp(row.lastMessage?.createdAt)}
              unread={row.unread}
              editing={false}
              deleting={deletingId === row.rowId}
              selected={activeId === row.rowId}
              onOpen={() => openThread(row.rowId, row.messages)}
              onDelete={allowDelete ? () => void deleteConversation(row.resident) : undefined}
            />
          ))}
        </ul>
      </div>
    </div>
  );

  const threadPane = !active ? (
    <InboxThreadEmpty hint="Choose a conversation on the left, or use New message above." />
  ) : (
    <div className={pageScroll ? "flex flex-col" : "flex h-full min-h-0 flex-1 flex-col overflow-hidden"}>
      <header
        className="portal-inbox-thread-header sticky top-0 z-10 flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top, 0px))" }}
      >
        <button
          type="button"
          className="flex min-h-10 touch-manipulation items-center gap-0.5 rounded-lg px-1 text-sm font-medium text-primary active:opacity-60 lg:hidden"
          data-attr="sms-messages-back"
          onClick={() => setActiveId(null)}
          aria-label="Back to conversations"
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={2.25} />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <p className="truncate text-sm font-semibold text-foreground">
            {smsConversationDisplayName(active.resident)}
          </p>
          <p className="truncate text-xs text-muted">
            {smsConversationSubtitle(active.resident) || " "}
          </p>
        </div>
        {canEditContact ? (
          <button
            type="button"
            className="flex h-10 w-10 shrink-0 touch-manipulation items-center justify-center rounded-full text-muted transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label="Edit contact details"
            data-attr="sms-contact-name-edit"
            onClick={openContactName}
          >
            <Pencil className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
        {active.archived ? (
          <Button
            type="button"
            variant="outline"
            className="h-10 min-h-10 rounded-full px-3 text-xs"
            data-attr="sms-messages-thread-restore"
            onClick={() => restoreConversation(active.resident)}
          >
            Restore
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              className="h-10 min-h-10 rounded-full px-3 text-xs"
              data-attr="sms-messages-thread-archive"
              onClick={() => archiveConversation(active.resident)}
            >
              Archive
            </Button>
            {allowDelete ? (
              <button
                type="button"
                className="flex h-10 w-10 touch-manipulation items-center justify-center rounded-full text-muted transition-colors hover:bg-foreground/5 hover:text-danger focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
                aria-label={active.messages.length === 0 ? "Remove contact" : "Delete conversation"}
                data-attr="sms-messages-thread-delete"
                disabled={deletingId === active.rowId}
                onClick={() => void (
                  active.messages.length === 0 && active.resident.savedContactName
                    ? deleteSavedContact(active.resident)
                    : deleteConversation(active.resident)
                )}
              >
                <Trash2 className="h-[18px] w-[18px]" strokeWidth={1.75} />
              </button>
            ) : null}
          </>
        )}
      </header>

      <div
        ref={pageScroll ? undefined : threadScrollRef}
        onScroll={pageScroll ? undefined : handleThreadScroll}
        className={
          pageScroll
            ? "portal-inbox-thread-body space-y-2 bg-background/40 px-3 py-4"
            : "portal-inbox-thread-body flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain bg-background/40 px-3 py-4 [-webkit-overflow-scrolling:touch]"
        }
      >
        {(() => {
          const threadMessages = [
            ...active.messages,
            ...(pendingOutboundByRow[active.rowId] ?? []),
          ];
          return threadMessages.length === 0 ? (
          <div className={`flex items-center justify-center py-6 ${pageScroll ? "" : "min-h-full flex-1"}`}>
            <PortalInboxEmptyState title="No messages in this conversation." />
          </div>
        ) : (
          <div
            className={`flex w-full flex-col gap-2 ${pageScroll ? "space-y-2" : "min-h-min flex-grow justify-end"}`}
          >
            {threadMessages.map((msg, index) => (
              <Bubble
                key={msg.id}
                message={msg}
                pending={msg.id.startsWith("pending-")}
                cluster={
                  threadMessages[index - 1]?.direction === msg.direction &&
                  threadMessages[index + 1]?.direction === msg.direction
                    ? "middle"
                    : threadMessages[index - 1]?.direction === msg.direction
                      ? "last"
                      : threadMessages[index + 1]?.direction === msg.direction
                        ? "first"
                        : "single"
                }
              />
            ))}
          </div>
        );
        })()}
        <div ref={threadEndRef} className="h-px shrink-0" aria-hidden />
      </div>

      <InboxThreadAssistantStrip
        contextHint={buildInboxThreadAssistantContext({
          subject: "SMS conversation",
          from: smsConversationDisplayName(active.resident),
          email: smsConversationSubtitle(active.resident) || active.resident.phone || undefined,
        })}
        storageScopeKey="Communication SMS thread"
      />

      {replyIssue ? (
        <p
          className="border-t border-border bg-warning/10 px-4 py-2 text-xs leading-relaxed text-foreground"
          role="alert"
        >
          {replyIssue}
        </p>
      ) : null}

      {!active.archived ? (
      <InboxComposer
        value={draft}
        onChange={setDraft}
        onSubmit={() => void sendReply()}
        sending={sending}
        disabled={(!replyViaEmail && !replyViaSms) || Boolean(replyIssue)}
        placeholder={replyViaSms && !replyViaEmail ? "Text message" : "Write a reply…"}
        maxLength={replyViaSms && !replyViaEmail ? 1600 : undefined}
        dataAttr="sms-messages-reply"
        channelControl={
          <InboxReplyChannelPicker
            viaEmail={replyViaEmail}
            viaSms={replyViaSms}
            onViaEmailChange={setReplyViaEmail}
            onViaSmsChange={setReplyViaSms}
            emailAvailable={activeEmailAvailable}
            smsAvailable
            onAddEmail={canEditContact ? openContactName : undefined}
          />
        }
      />
      ) : null}
    </div>
  );

  return (
    <div className="space-y-0">
      {allowInlineCompose ? (
        <ManagerSmsComposeModal
          open={composeOpen}
          onClose={() => setComposeOpen(false)}
          residents={composeResidents}
          onSent={handleSmsSent}
          endpoint={endpoint}
        />
      ) : null}

      <PortalContactDetailsModal
        open={contactNameOpen}
        onClose={() => setContactNameOpen(false)}
        initial={{
          name: active?.resident.savedContactName?.trim() || "",
          phone: active?.resident.phone?.trim() || "",
          email: active?.resident.residentEmail?.trim() || "",
        }}
        onSave={(values) => void saveContactDetails(values)}
        saving={savingContactName}
        error={contactNameError}
        formId="sms-contact-details-form"
      />

      {suppressListPane ? (
        <div className={pageScroll ? "flex flex-col" : "flex h-full min-h-0 flex-1 flex-col overflow-hidden"}>{threadPane}</div>
      ) : (
        <InboxTwoPane threadOpen={showThread} list={listPane} thread={threadPane} />
      )}
    </div>
  );
});

function Bubble({
  message,
  pending = false,
  cluster = "single",
}: {
  message: ManagerSmsMessageRow;
  pending?: boolean;
  cluster?: "single" | "first" | "middle" | "last";
}) {
  const outbound = message.direction === "outbound";
  const radius = outbound
    ? cluster === "first"
      ? "rounded-[1.125rem] rounded-br-md"
      : cluster === "middle"
        ? "rounded-[1.125rem] rounded-tr-md rounded-br-md"
        : cluster === "last"
          ? "rounded-[1.125rem] rounded-tr-md"
          : "rounded-[1.125rem] rounded-br-md"
    : cluster === "first"
      ? "rounded-[1.125rem] rounded-bl-md"
      : cluster === "middle"
        ? "rounded-[1.125rem] rounded-tl-md rounded-bl-md"
        : cluster === "last"
          ? "rounded-[1.125rem] rounded-tl-md"
          : "rounded-[1.125rem] rounded-bl-md border border-border bg-secondary text-foreground";
  // `min-w-0` + `ml-auto`/`mr-auto` keep long URLs from expanding the flex
  // item to full width (default min-width:auto), which made outbound bubbles
  // look left-aligned while staying blue.
  return (
    <div className="group/msg flex w-full min-w-0">
      <div
        className={`portal-inbox-bubble-wrap flex min-w-0 flex-col ${
          outbound ? "ml-auto items-end" : "mr-auto items-start"
        }`}
      >
        <div
          className={`relative w-full px-4 py-2.5 text-[15px] leading-relaxed sm:text-base portal-inbox-inbound-bubble ${radius} ${
            outbound
              ? "portal-inbox-outbound-bubble"
              : cluster === "single"
                ? "border border-border bg-secondary text-foreground"
                : "border border-border bg-secondary text-foreground"
          } ${pending ? "opacity-80" : ""}`}
          data-sms-bubble-align={outbound ? "end" : "start"}
        >
        {isVoiceCallNoteSid(message.messageSid) ? (
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Call</p>
        ) : null}
        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{message.body || " "}</p>
        </div>
        {pending ? (
          <span className={`mt-1 block px-1 text-[11px] italic text-muted ${outbound ? "text-right" : ""}`}>
            Sending…
          </span>
        ) : null}
      </div>
    </div>
  );
}

function ConversationRow({
  name,
  subtitle,
  preview,
  time,
  unread,
  editing,
  deleting,
  selected,
  onOpen,
  onDelete,
}: {
  name: string;
  subtitle: string;
  preview: string;
  time: string;
  unread: boolean;
  editing: boolean;
  deleting: boolean;
  selected: boolean;
  onOpen: () => void;
  /** Omitted on surfaces whose endpoint has no DELETE handler — see `allowDelete`. */
  onDelete?: () => void;
}) {
  const canDelete = Boolean(onDelete);
  const DELETE_W = canDelete ? 76 : 0;
  const [offset, setOffset] = useState(0);
  const [armed, setArmed] = useState(false);
  const startX = useRef<number | null>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (!editing) {
      setArmed(false);
      setOffset(0);
    }
  }, [editing]);

  const reveal = editing ? (armed ? -DELETE_W : 0) : offset;

  const onPointerDown = (e: ReactPointerEvent) => {
    if (editing) return;
    startX.current = e.clientX;
    dragging.current = false;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    if (startX.current == null || editing) return;
    const dx = e.clientX - startX.current;
    if (Math.abs(dx) > 8) dragging.current = true;
    // Swipe left to reveal delete (iOS).
    setOffset(Math.max(-DELETE_W, Math.min(0, dx)));
  };
  const onPointerUp = () => {
    if (startX.current == null) return;
    setOffset((cur) => (cur < -DELETE_W / 2 ? -DELETE_W : 0));
    startX.current = null;
  };

  return (
    <li className="relative isolate overflow-hidden bg-card">
      {/* Delete action sits under the row — only visible when slid open */}
      {canDelete ? (
        <div
          className="absolute inset-y-0 right-0 flex items-stretch"
          style={{ width: DELETE_W }}
          aria-hidden={reveal === 0}
        >
          <button
            type="button"
            className="flex w-full touch-manipulation items-center justify-center text-[13px] font-medium text-white active:brightness-90"
            style={{ backgroundColor: DELETE_RED }}
            data-attr="sms-messages-swipe-delete"
            disabled={deleting || reveal === 0}
            tabIndex={reveal === 0 ? -1 : 0}
            onClick={(e) => {
              e.stopPropagation();
              onDelete?.();
            }}
          >
            {deleting ? "…" : "Delete"}
          </button>
        </div>
      ) : null}

      <div
        className={[
          "portal-inbox-row relative z-[1] flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-transform duration-200 ease-out",
          selected ? "portal-inbox-row--selected bg-accent" : "bg-card hover:bg-foreground/[0.03]",
          "touch-pan-y",
        ].join(" ")}
        style={{
          transform: `translate3d(${reveal}px,0,0)`,
        }}
        onClick={() => {
          if (dragging.current) {
            dragging.current = false;
            return;
          }
          if (editing) {
            setArmed((v) => !v);
            return;
          }
          if (offset < -8) {
            setOffset(0);
            return;
          }
          onOpen();
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {editing && canDelete ? (
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 touch-manipulation items-center justify-center rounded-full text-white"
            style={{ backgroundColor: DELETE_RED }}
            aria-label={armed ? `Hide delete for ${name}` : `Delete ${name}`}
            aria-expanded={armed}
            data-attr="sms-messages-edit-delete"
            disabled={deleting}
            onClick={(e) => {
              e.stopPropagation();
              setArmed((v) => !v);
            }}
          >
            <span className="text-[18px] font-bold leading-none">−</span>
          </button>
        ) : null}
        <InboxAvatar name={name} className="h-11 w-11 text-[14px]" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <p
              className={`truncate text-sm ${
                unread ? "font-semibold text-foreground" : "font-medium text-foreground/90"
              }`}
            >
              {name}
            </p>
            <span className="shrink-0 text-[11px] tabular-nums text-muted">{time}</span>
          </div>
          {subtitle ? <p className="truncate text-xs text-muted">{subtitle}</p> : null}
          <div className="mt-0.5 flex items-center gap-2">
            <p
              className={`min-w-0 flex-1 truncate text-xs ${
                unread ? "font-medium text-foreground/75" : "text-muted"
              }`}
            >
              {preview || " "}
            </p>
            {unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-primary" /> : null}
          </div>
        </div>
      </div>
    </li>
  );
}
