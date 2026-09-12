"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CommunicationListBulkBar,
} from "@/components/portal/communication-list-bulk-bar";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import { Button } from "@/components/ui/button";
import { ResidentInboxPanel, type ResidentInboxPanelHandle } from "@/components/portal/resident-inbox-panel";
import { RoleSmsPanel } from "@/components/portal/role-sms-panel";
import { ResidentManagerNumberCard } from "@/components/portal/resident-manager-number-card";
import {
  INBOX_LIST_SCROLL,
  InboxConversationRow,
  InboxListSegmentRail,
  InboxTwoPane,
  PORTAL_INBOX_LIST_TOOLBAR_CLASS,
  PortalInboxEmptyState,
  type InboxListSegment,
} from "@/components/portal/portal-inbox-ui";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import { PORTAL_HEADER_PRIMARY_ACTION_BTN } from "@/components/portal/portal-metrics";
import { canonicalResidentAgentThreadId } from "@/lib/agent/resident-inbox-agent-ids";
import {
  mergeUnifiedInboxItems,
  parseUnifiedInboxKey,
  unifiedInboxKey,
  type UnifiedInboxListItem,
} from "@/lib/unified-inbox-merge";
import {
  PORTAL_INBOX_CHANGED_EVENT,
  RESIDENT_INBOX_STORAGE_KEY,
  inboxThreadMessages,
  inboxThreadSortMs,
  inboxMessageOutbound,
  loadPersistedInbox,
  syncPersistedInboxFromServer,
  stagePersistedInboxRows,
} from "@/lib/portal-inbox-storage";
import { isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import {
  buildResidentAssistantPlaceholderThread,
  communicationInboxListPreview,
  pinPropLaneAssistantUnifiedItems,
  propLaneAssistantListPreview,
  propLaneAssistantListSubtitle,
  propLaneAssistantThreadIdForPortal,
  resolveCommunicationViewerId,
  withPinnedPropLaneAssistantThreads,
} from "@/lib/communication-assistant-inbox-list";
import { usePortalSession } from "@/hooks/use-portal-session";
import { useResidentManagerContacts } from "@/hooks/use-resident-manager-contacts";
import {
  inboxRowAddressLabel,
  inboxThreadCategoryLabel,
  inboxThreadUnreadCount,
} from "@/lib/communication-row-meta";
import { inboxThreadLastTurnDirection } from "@/lib/inbox-turn-direction";
import {
  clearCommunicationThreadUrl,
  selectCommunicationThreadUrl,
} from "@/lib/portal-communication-nav";
import { useCommunicationThreadId } from "@/hooks/use-communication-thread-id";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import {
  normalizeRoleSmsPayload,
  smsMessageBucket,
  type ManagerSmsBucketId,
  type ManagerSmsMessageRow,
} from "@/lib/manager-sms-messages";
import { formatPacificDate } from "@/lib/pacific-time";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const SMS_THREAD_ID = "text-messages";
const SMS_OPENED_KEY = "axis_role_sms_opened_resident";

function loadOpenedIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(SMS_OPENED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

function inboxUsesDesktopSplit(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 1024px)").matches;
}

function ResidentUnifiedInbox({
  inboxRef,
  smsUiEnabled,
  listSegment,
  routeThreadId,
  onRouteThreadChange,
  onThreadOpenChange,
  onThreadSelectedChange,
  commBase,
  onAddConversation,
  residentUserId,
}: {
  inboxRef: React.RefObject<ResidentInboxPanelHandle | null>;
  smsUiEnabled: boolean;
  listSegment: InboxListSegment;
  routeThreadId?: string;
  onRouteThreadChange?: (threadId: string | undefined) => void;
  onThreadOpenChange?: (open: boolean) => void;
  onThreadSelectedChange?: (selected: boolean) => void;
  commBase: string;
  onAddConversation?: () => void;
  residentUserId?: string | null;
}) {
  const { userId } = usePortalSession({ userId: residentUserId ?? null });
  const viewerId = resolveCommunicationViewerId(residentUserId, userId);
  // The resident has ONE house, so every row carries the same street line. The
  // lookup is shared with the contact card above the list, not re-fetched.
  const managerContacts = useResidentManagerContacts();
  const homeAddress = useMemo(
    () => inboxRowAddressLabel(managerContacts.find((c) => c.propertyLabel)?.propertyLabel),
    [managerContacts],
  );
  // Inbox rows hydrate from sessionStorage — never read them in useState initializers (SSR mismatch).
  const [emailThreads, setEmailThreads] = useState<PersistedInboxThread[]>([]);
  const [smsMessages, setSmsMessages] = useState<ManagerSmsMessageRow[]>([]);
  const [smsOpened, setSmsOpened] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const assistantThreadId = viewerId ? propLaneAssistantThreadIdForPortal("resident", viewerId) : null;

  useEffect(() => {
    const syncEmail = () => setEmailThreads(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, []));
    syncEmail();
    setSmsOpened(loadOpenedIds());
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, syncEmail as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, syncEmail as EventListener);
  }, []);

  useEffect(() => {
    if (!viewerId) return;
    void syncPersistedInboxFromServer(RESIDENT_INBOX_STORAGE_KEY, { force: true }).then((rows) => {
      setEmailThreads(rows);
    });
  }, [viewerId]);

  useEffect(() => {
    if (!viewerId?.trim() || listSegment !== "active") return;
    let staged: PersistedInboxThread[] | null = null;
    setEmailThreads((current) => {
      const hasAssistant = current.some(
        (thread) =>
          isPropLaneAssistantInboxThread(thread) ||
          thread.id === canonicalResidentAgentThreadId(viewerId),
      );
      if (hasAssistant) return current;
      const next = [buildResidentAssistantPlaceholderThread(viewerId), ...current];
      staged = next;
      return next;
    });
    if (staged) {
      queueMicrotask(() => stagePersistedInboxRows(RESIDENT_INBOX_STORAGE_KEY, staged!));
    }
  }, [listSegment, viewerId]);

  useEffect(() => {
    if (!smsUiEnabled) return;
    void (async () => {
      try {
        const res = await fetch("/api/resident/sms-conversations", { credentials: "include", cache: "no-store" });
        if (!res.ok) return;
        const body = await res.json();
        setSmsMessages(normalizeRoleSmsPayload(body).messages);
      } catch {
        /* keep */
      }
    })();
  }, [smsUiEnabled]);

  useEffect(() => {
    setSelectedKey(null);
  }, [listSegment]);

  // Same search the manager's list has. The two portals share one skeleton and
  // a resident with a year of charge notices needs to find a thread just as
  // much as a manager does.
  const [query, setQuery] = useState("");

  const filteredEmail = useMemo(() => {
    const base = filterEmailInboxThreads(emailThreads, { keepSmsLike: !smsUiEnabled });
    return withPinnedPropLaneAssistantThreads(base, "resident", viewerId, listSegment);
  }, [emailThreads, listSegment, smsUiEnabled, viewerId]);

  const emailItems = useMemo((): UnifiedInboxListItem[] => {
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

    const items = rows.map((t) => {
      const msgs = inboxThreadMessages(t);
      const lastMsg = msgs[msgs.length - 1];
      const sentSemantics = t.folder === "sent";
      const lastIndex = Math.max(0, msgs.length - 1);
      const lastOutbound = lastMsg
        ? inboxMessageOutbound(lastMsg, lastIndex, t.folder, t)
        : sentSemantics;
      return {
        key: unifiedInboxKey("email", t.id),
        channel: "email" as const,
        threadId: t.id,
        name: sentSemantics ? t.email || "Recipient" : t.from || t.email || "Sender",
        subtitle: isPropLaneAssistantInboxThread(t)
          ? propLaneAssistantListSubtitle(t)
          : t.subject,
        preview: isPropLaneAssistantInboxThread(t)
          ? propLaneAssistantListPreview(t, listSegment)
          : communicationInboxListPreview(lastMsg?.body ?? t.preview ?? "", listSegment, 80),
        previewPrefix: inboxThreadLastTurnDirection(t) === "outbound" ? "You: " : undefined,
        time: t.time,
        unread: t.folder === "inbox" && t.unread,
        unreadCount: inboxThreadUnreadCount(t),
        address: homeAddress,
        category: inboxThreadCategoryLabel(t),
        // Sort on the SAME field the row is labelled with — only `thread.time`
        // is normalized; `lastMsg.at` is whatever shape its writer built.
        sortMs: inboxThreadSortMs(t.id, t.time),
      };
    });
    if (listSegment === "unread") return items.filter((item) => item.unread);
    return items;
  }, [filteredEmail, homeAddress, listSegment, query]);

  const smsItems = useMemo((): UnifiedInboxListItem[] => {
    if (!smsUiEnabled || listSegment === "archived") return [];
    const scoped = smsMessages;
    if (scoped.length === 0) return [];
    const q = query.trim().toLowerCase();
    if (q && !scoped.some((m) => m.body.toLowerCase().includes(q)) && !"text messages".includes(q)) return [];
    const last = [...scoped].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
    const unread = scoped.some((m) => m.direction === "inbound" && smsMessageBucket(m, smsOpened) === "unopened");
    const item: UnifiedInboxListItem = {
      key: unifiedInboxKey("sms", SMS_THREAD_ID),
      channel: "sms",
      threadId: SMS_THREAD_ID,
      name: "Text messages",
      subtitle: "Property manager",
      preview: communicationInboxListPreview(last.body, listSegment, 80),
      previewPrefix: last.direction === "outbound" ? "You: " : undefined,
      time: formatPacificDate(last.createdAt, { hour: "numeric", minute: "2-digit" }),
      unread,
      sortMs: Date.parse(last.createdAt) || 0,
    };
    if (listSegment === "unread" && !unread) return [];
    return [item];
  }, [listSegment, query, smsMessages, smsOpened, smsUiEnabled]);

  const merged = useMemo(() => {
    const rows = mergeUnifiedInboxItems([...emailItems, ...smsItems], "recent");
    return pinPropLaneAssistantUnifiedItems(rows, assistantThreadId);
  }, [assistantThreadId, emailItems, smsItems]);

  const bulk = useUnifiedCommunicationBulk({
    mergedRows: merged,
    listSegment,
    storageKey: RESIDENT_INBOX_STORAGE_KEY,
    emailThreads,
    onEmailThreadsChange: setEmailThreads,
    onSelectionCleared: () => {
      setSelectedKey(null);
      onRouteThreadChange?.(undefined);
      clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
    },
  });

  const selection = useMemo(() => (selectedKey ? parseUnifiedInboxKey(selectedKey) : null), [selectedKey]);

  useEffect(() => {
    if (!routeThreadId) return;
    const match = merged.find((r) => r.threadId === routeThreadId);
    if (match) setSelectedKey(match.key);
  }, [routeThreadId, merged]);

  useEffect(() => {
    onThreadOpenChange?.(Boolean(selection));
  }, [onThreadOpenChange, selection]);

  useEffect(() => {
    onThreadSelectedChange?.(Boolean(selection));
  }, [onThreadSelectedChange, selection]);

  useEffect(() => {
    if (merged.length === 0) {
      if (!routeThreadId) setSelectedKey(null);
      return;
    }
    setSelectedKey((cur) => {
      if (routeThreadId) {
        const routed = merged.find((row) => row.threadId === routeThreadId);
        if (routed) return routed.key;
        if (cur && merged.some((row) => row.key === cur)) return cur;
        return null;
      }
      if (cur && merged.some((row) => row.key === cur)) return cur;
      if (inboxUsesDesktopSplit()) return merged[0]!.key;
      return null;
    });
  }, [merged, routeThreadId]);

  const listPane = (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ResidentManagerNumberCard />
      <InboxListSegmentRail commBase={commBase} listSegment={listSegment} />
      <div className={PORTAL_INBOX_LIST_TOOLBAR_CLASS}>
        <div className="relative min-w-0">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages"
            aria-label="Search messages"
            className="portal-inbox-search h-9 w-full rounded-xl border border-border bg-background px-3 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
            data-attr="resident-inbox-search"
          />
        </div>
        {merged.length > 0 ? (
          <p className="hidden px-1 text-[11px] text-muted sm:block">
            {merged.length} conversation{merged.length === 1 ? "" : "s"}
            {query.trim() ? ` matching \u201C${query.trim()}\u201D` : ""}
          </p>
        ) : null}
      </div>
      <div className={`${INBOX_LIST_SCROLL} min-h-0 flex-1`} data-communication-inbox-list>
        {merged.length === 0 ? (
          query.trim() ? (
            <div className="p-4">
              <PortalInboxEmptyState title={`No messages match \u201C${query.trim()}\u201D.`} />
            </div>
          ) : listSegment === "archived" ? (
            <div className="p-4">
              <PortalInboxEmptyState title="No archived conversations." />
            </div>
          ) : listSegment === "unread" ? (
            <div className="p-4">
              <PortalInboxEmptyState title="No unread conversations." />
            </div>
          ) : null
        ) : (
          merged.map((row) => (
            <InboxConversationRow
              key={row.key}
              name={row.name}
              subtitle={row.subtitle}
              preview={row.preview}
              previewPrefix={row.previewPrefix}
              time={row.time}
              unread={row.unread}
              unreadCount={row.unreadCount}
              address={row.address}
              category={row.category}
              selected={selectedKey === row.key}
              onOpen={() => {
                setSelectedKey(row.key);
                onRouteThreadChange?.(row.threadId);
                const href = `${commBase}/${listSegment}/${encodeURIComponent(row.threadId)}`;
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
      />
    </div>
  );

  const smsSelected = selection?.channel === "sms";
  const threadPane = (
    <>
      {smsSelected ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          <RoleSmsPanel apiPath="/api/resident/sms-conversations" storageScope="resident" tabId={"all" as ManagerSmsBucketId} />
        </div>
      ) : null}
      <div className={smsSelected ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <ResidentInboxPanel
          ref={inboxRef}
          tabId={listSegment === "archived" ? "trash" : "all"}
          embeddedInCommunication
          externalTitleActions
          suppressListPane
          smsUiEnabled={smsUiEnabled}
          controlledExpandedId={selection?.channel === "email" ? selection.threadId : null}
          onControlledExpandedIdChange={(id) => {
            if (!id) {
              setSelectedKey(null);
              onRouteThreadChange?.(undefined);
              clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
              return;
            }
            setSelectedKey(unifiedInboxKey("email", id));
            onRouteThreadChange?.(id);
            const href = `${commBase}/${listSegment}/${encodeURIComponent(id)}`;
            if (routeThreadId !== id) {
              selectCommunicationThreadUrl(href, { replaceExisting: Boolean(routeThreadId) });
            }
          }}
        />
      </div>
    </>
  );

  return (
    <>
      <InboxTwoPane
        panes="split"
        heightMode="viewport"
        fillViewport={Boolean(selection)}
        fillParent
        mobileCompact
        className="min-h-0 flex-1"
        threadOpen={Boolean(selection)}
        list={listPane}
        thread={threadPane}
      />
    </>
  );
}

/** @deprecated Folder tabs removed; kept so legacy routes still resolve. */
export type ResidentEmailTabId = "unopened" | "opened" | "schedule" | "sent" | "trash";

export function ResidentCommunication({
  listSegment = "active",
  threadId,
  smsUiEnabled = false,
  residentUserId = null,
}: {
  /** Routed conversation list segment (Active / Unread / Archived). */
  listSegment?: InboxListSegment;
  /** Deep-linked thread id from `/communication/{segment}/{threadId}`. */
  threadId?: string;
  /** @deprecated Folder tabs removed; kept so legacy routes still resolve. */
  inboxTabId?: ResidentEmailTabId;
  smsUiEnabled?: boolean;
  residentUserId?: string | null;
}) {
  const commBase = `${RESIDENT_PORTAL_BASE_PATH}/communication`;
  const inboxRef = useRef<ResidentInboxPanelHandle>(null);
  const { activeThreadId, setActiveThreadId } = useCommunicationThreadId(commBase, threadId);
  const [threadOpen, setThreadOpen] = useState(Boolean(threadId));
  const [threadSelected, setThreadSelected] = useState(Boolean(threadId));

  const communicationFilterSheet = (
    <PortalFilterSortSheet
      activeCount={0}
      compactPanel
      filterFieldCount={1}
      // Content width — see the note on the manager's sheet.
      className="md:w-auto md:max-w-none"
      mobileFlushBody
      dataAttr="resident-communication-filter-open"
    >
      <p className="text-sm text-muted">
        Resident Communication shows all of your conversations. Use Archived to review older threads.
      </p>
    </PortalFilterSortSheet>
  );

  const openCompose = () => inboxRef.current?.openCompose();

  const communicationNewMessageButton = (
    <Button
      type="button"
      variant="primary"
      className={PORTAL_HEADER_PRIMARY_ACTION_BTN}
      data-attr="communication-new-message"
      aria-label="New message"
      onClick={openCompose}
    >
      <span className="sm:hidden" aria-hidden="true">
        Message
      </span>
      <span className="hidden sm:inline">New message</span>
    </Button>
  );

  // Band-only shape: this aside is UNGATED, so it renders once at every
  // breakpoint. Never pair it with a separate mobile actions row — that draws
  // every control twice on a phone. Guarded by
  // tests/unit/portal-inline-title-band-duplicate-controls.test.tsx.
  const communicationCommandActions = (
    <>
      {communicationFilterSheet}
      {communicationNewMessageButton}
    </>
  );

  return (
    <PortalCommunicationShell
      title="Inbox"
      subtitle="Message your property manager, get updates, and ask questions — all in one place."
      titleAside={communicationCommandActions}
      hideTitleOnMobileNav
      hideMobileFilterRow={threadOpen}
      mobileThreadReading={threadOpen}
      threadSelected={threadSelected}
      hideAssistantFab
    >
      <ResidentUnifiedInbox
        inboxRef={inboxRef}
        smsUiEnabled={smsUiEnabled}
        listSegment={listSegment}
        routeThreadId={activeThreadId}
        onRouteThreadChange={setActiveThreadId}
        onThreadOpenChange={setThreadOpen}
        onThreadSelectedChange={setThreadSelected}
        commBase={commBase}
        onAddConversation={() => inboxRef.current?.openCompose()}
        residentUserId={residentUserId}
      />
    </PortalCommunicationShell>
  );
}
