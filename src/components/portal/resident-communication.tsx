"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommunicationStatusFilterDraft, type CommunicationStatus } from "@/components/portal/communication-status-filter";

import { CommunicationRowActions } from "@/components/portal/communication-row-actions";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import { PenSquare, ShieldCheck } from "lucide-react";
import Link from "next/link";
import type { ResidentPhoneState } from "@/lib/communication/resident-conversation";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { usePublishTitleActions } from "@/components/portal/portal-title-actions-slot";
import { CommunicationDetailsPane, communicationDetailsFromRow } from "@/components/portal/communication-details-pane";
import { CommunicationInboxInitialState } from "@/components/portal/communication-inbox-initial-state";
import { ResidentInboxPanel, type ResidentInboxPanelHandle } from "@/components/portal/resident-inbox-panel";
import { RoleSmsPanel } from "@/components/portal/role-sms-panel";
import { ResidentCommunicationIdentityCard } from "@/components/portal/resident-communication-identity-card";
import {
  INBOX_LIST_SCROLL,
  InboxConversationRow,
  InboxListSegmentTabs,
  InboxTwoPane,
  InboxListHeader,
  PortalInboxEmptyState,
  type InboxListSegment,
} from "@/components/portal/portal-inbox-ui";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import {
  foldTextRowIntoSoleWorkspace,
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
  residentPhoneStateFor,
  syncPersistedInboxFromServerWithStatus,
} from "@/lib/portal-inbox-storage";
import { buildActiveCommunicationThreads, emailThreadJoinKeys } from "@/lib/communication-active-rows";
import {
  communicationInboxListPreview,
  resolveCommunicationViewerId,
} from "@/lib/communication-assistant-inbox-list";
import { usePortalSession } from "@/hooks/use-portal-session";
import { useResidentManagerContacts } from "@/hooks/use-resident-manager-contacts";
import {
  inboxThreadCategoryLabel,
  inboxThreadUnreadCount,
} from "@/lib/communication-row-meta";
import { resolveResidentThreadManager } from "@/lib/resident-communication-manager";
import { inboxThreadLastTurnDirection } from "@/lib/inbox-turn-direction";
import {
  clearCommunicationThreadUrl,
  selectCommunicationSegmentUrl,
  selectCommunicationThreadUrl,
} from "@/lib/portal-communication-nav";
import { useCommunicationThreadId } from "@/hooks/use-communication-thread-id";
import { useCommunicationListSegment } from "@/hooks/use-communication-list-segment";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import {
  normalizeRoleSmsPayload,
  smsMessageBucket,
  type ManagerSmsBucketId,
  type ManagerSmsMessageRow,
} from "@/lib/manager-sms-messages";
import { formatPacificDate } from "@/lib/pacific-time";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import {
  EMPTY_COMMUNICATION_THREAD_FILTERS,
  RECORD_KIND_FILTER_OPTIONS,
  threadPassesCommunicationFilters,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import { recordRoutePath, type RecordKind } from "@/lib/portals/record-kinds";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";

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
  readOnly = false,
  includeArchived = false,
  routeThreadId,
  onRouteThreadChange,
  onThreadOpenChange,
  onThreadSelectedChange,
  commBase,
  listActions,
  residentUserId,
  threadFilters,
  onSegmentChange,
  tabSegment,
}: {
  inboxRef: React.RefObject<ResidentInboxPanelHandle | null>;
  smsUiEnabled: boolean;
  listSegment: InboxListSegment;
  readOnly?: boolean;
  /** "All conversations": archived rows stay in the active list. */
  includeArchived?: boolean;
  routeThreadId?: string;
  onRouteThreadChange?: (threadId: string | undefined) => void;
  onThreadOpenChange?: (open: boolean) => void;
  onThreadSelectedChange?: (selected: boolean) => void;
  commBase: string;
  /** Icon actions drawn beside Search, the manager's toolbar shape. */
  listActions?: React.ReactNode;
  residentUserId?: string | null;
  /** Narrows the list — currently only `recordRefs`/`recordKinds` (record-linked communication). */
  threadFilters?: CommunicationThreadFilters;
  /** A plain-click Active/Archived tab switch updates client state instead of navigating. */
  onSegmentChange?: (segment: "active" | "archived") => void;
  /** The tab that is selected (the list itself may be narrowed further by the Filter). */
  tabSegment: "active" | "archived";
}) {
  const { userId, ready: sessionReady } = usePortalSession({ userId: residentUserId ?? null });
  const viewerId = resolveCommunicationViewerId(residentUserId, userId);
  const viewerEpochRef = useRef(0);
  useEffect(() => {
    viewerEpochRef.current += 1;
  }, [viewerId]);
  // A resident can hold conversations with several managers, so each row names
  // its OWN manager and home; the lookup is shared with the thread header.
  const managerContacts = useResidentManagerContacts();
  // Inbox rows hydrate from sessionStorage — never read them in useState initializers (SSR mismatch).
  const [emailThreads, setEmailThreads] = useState<PersistedInboxThread[]>([]);
  const [smsMessages, setSmsMessages] = useState<ManagerSmsMessageRow[]>([]);
  const [smsOpened, setSmsOpened] = useState<Set<string>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [initialListState, setInitialListState] = useState<"loading" | "ready" | "error">("loading");
  const [initialListViewerId, setInitialListViewerId] = useState<string | null>(null);
  const initialLoadGeneration = useRef(0);
  const initialListReady = initialListState === "ready" && initialListViewerId === viewerId;
  // Server-reported (resident scope): a phone on file that is not verified, or
  // that another account also verified, never links texts to this resident.
  const [phoneState, setPhoneState] = useState<ResidentPhoneState | null>(null);
  const needsPhoneVerification = Boolean(phoneState && ((phoneState.hasPhone && !phoneState.verified) || phoneState.ambiguous));

  useEffect(() => {
    const syncEmail = () => setEmailThreads(loadPersistedInbox(RESIDENT_INBOX_STORAGE_KEY, []));
    syncEmail();
    setSmsOpened(loadOpenedIds());
    window.addEventListener(PORTAL_INBOX_CHANGED_EVENT, syncEmail as EventListener);
    return () => window.removeEventListener(PORTAL_INBOX_CHANGED_EVENT, syncEmail as EventListener);
  }, []);

  const loadResidentSms = useCallback(async (requestGeneration?: number): Promise<boolean> => {
    const requestViewerEpoch = viewerEpochRef.current;
    if (!smsUiEnabled) return true;
    try {
      const res = await fetch("/api/resident/sms-conversations", { credentials: "include", cache: "no-store" });
      if (!res.ok) return false;
      const body = (await res.json()) as { messages?: ManagerSmsMessageRow[] };
      if (!body || !Array.isArray(body.messages)) return false;
      if (
        viewerEpochRef.current !== requestViewerEpoch ||
        (requestGeneration !== undefined && requestGeneration !== initialLoadGeneration.current)
      ) {
        return false;
      }
      setSmsMessages(normalizeRoleSmsPayload(body).messages);
      return true;
    } catch {
      return false;
    }
  }, [setSmsMessages, smsUiEnabled]);

  const loadInitialList = useCallback(async (): Promise<void> => {
    const requestGeneration = ++initialLoadGeneration.current;
    if (!sessionReady || !viewerId?.trim()) {
      setInitialListViewerId(null);
      setInitialListState("loading");
      setSelectedKey(null);
      return;
    }
    setInitialListViewerId(viewerId);
    setInitialListState("loading");
    const [inbox, smsOk] = await Promise.all([
      syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY),
      smsUiEnabled ? loadResidentSms(requestGeneration) : Promise.resolve(true),
    ]);
    if (requestGeneration !== initialLoadGeneration.current || inbox.stale) return;
    if (inbox.ok) {
      setEmailThreads(inbox.rows);
      setPhoneState(residentPhoneStateFor(RESIDENT_INBOX_STORAGE_KEY));
    }
    setInitialListState(inbox.ok && smsOk ? "ready" : "error");
  }, [
    loadResidentSms,
    sessionReady,
    setEmailThreads,
    setInitialListState,
    setInitialListViewerId,
    setSelectedKey,
    smsUiEnabled,
    viewerId,
  ]);

  useEffect(() => {
    void loadInitialList();
    return () => {
      initialLoadGeneration.current += 1;
    };
  }, [loadInitialList]);

  useEffect(() => {
    setSelectedKey(null);
  }, [listSegment]);

  // Same search the manager's list has. The two portals share one skeleton and
  // a resident with a year of charge notices needs to find a thread just as
  // much as a manager does.
  const [query, setQuery] = useState("");

  const filteredEmail = useMemo(() => {
    // The exact rows this list shows — lifted into a shared builder so the
    // Communication sidebar badge (which counts the Active tab) can never
    // drift from what this list renders. Residents have no assistant row.
    const rows = buildActiveCommunicationThreads(emailThreads, {
      portal: "resident",
      viewerId,
      smsUiEnabled,
    });
    if (!threadFilters) return rows;
    return rows.filter((t) =>
      threadPassesCommunicationFilters({ filters: threadFilters, contacts: [], counterpartyEmail: t.email, recordRef: t.recordRef }),
    );
  }, [emailThreads, smsUiEnabled, threadFilters, viewerId]);

  /** The merged conversation rows one segment shows, for an optional search. */
  const rowsForSegment = useCallback(
    (segment: InboxListSegment, search: string, archivedStaysInActive: boolean): UnifiedInboxListItem[] => {
      const q = search.trim().toLowerCase();
      let rows = filteredEmail;
      if (segment === "archived") {
        rows = rows.filter((t) => t.folder === "trash");
      } else if (segment === "unread") {
        rows = rows.filter((t) => t.folder !== "trash" && t.folder === "inbox" && t.unread);
      } else if (!archivedStaysInActive) {
        rows = rows.filter((t) => t.folder !== "trash");
      }
      if (q) {
        // Search refines the selected segment; it must not leak read rows back
        // into Unread or active rows back into Archived.
        rows = rows.filter((t) => {
          const manager = resolveResidentThreadManager(t, managerContacts);
          const hay = [t.from, manager.name, manager.workspaceName, manager.homeLabel, t.email, t.subject, t.body, t.preview]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        });
      }

      const emailItems = rows.map((t): UnifiedInboxListItem => {
        const msgs = inboxThreadMessages(t);
        const lastMsg = msgs[msgs.length - 1];
        // Every row names the MANAGER it is with, and that manager's home.
        const manager = resolveResidentThreadManager(t, managerContacts);
        return {
          key: unifiedInboxKey("email", t.id),
          channel: "email" as const,
          threadId: t.id,
          name: manager.name,
          subtitle: t.subject,
          preview: communicationInboxListPreview(lastMsg?.body ?? t.preview ?? "", segment, 80),
          previewPrefix: inboxThreadLastTurnDirection(t) === "outbound" ? "You: " : undefined,
          time: t.time,
          unread: t.folder === "inbox" && t.unread,
          unreadCount: inboxThreadUnreadCount(t),
          address: manager.homeLabel,
          category: inboxThreadCategoryLabel(t),
          recordRef: t.recordRef,
          // One conversation per manager workspace: rows sharing a key are one row.
          joinKeys: emailThreadJoinKeys(t),
          identityFlag: t.identityFlag ? true : undefined,
          // Sort on the SAME field the row is labelled with — only `thread.time`
          // is normalized; `lastMsg.at` is whatever shape its writer built.
          sortMs: inboxThreadSortMs(t.id, t.time),
        };
      });
      const filteredEmailItems = segment === "unread" ? emailItems.filter((item) => item.unread) : emailItems;

      let smsItems: UnifiedInboxListItem[] = [];
      if (smsUiEnabled && segment !== "archived" && smsMessages.length > 0) {
        const matches =
          !q || smsMessages.some((m) => m.body.toLowerCase().includes(q)) || "text messages".includes(q);
        if (matches) {
          const last = [...smsMessages].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
          const unread = smsMessages.some((m) => m.direction === "inbound" && smsMessageBucket(m, smsOpened) === "unopened");
          if (segment !== "unread" || unread) {
            smsItems = [
              {
                key: unifiedInboxKey("sms", SMS_THREAD_ID),
                channel: "sms",
                threadId: SMS_THREAD_ID,
                name: "Text messages",
                subtitle: "Property manager",
                preview: communicationInboxListPreview(last.body, segment, 80),
                previewPrefix: last.direction === "outbound" ? "You: " : undefined,
                time: formatPacificDate(last.createdAt, { hour: "numeric", minute: "2-digit" }),
                unread,
                sortMs: Date.parse(last.createdAt) || 0,
              },
            ];
          }
        }
      }
      return mergeUnifiedInboxItems(
        [...filteredEmailItems, ...foldTextRowIntoSoleWorkspace(filteredEmailItems, smsItems)],
        "recent",
      );
    },
    [filteredEmail, managerContacts, smsMessages, smsOpened, smsUiEnabled],
  );

  const merged = useMemo(
    () => rowsForSegment(listSegment, query, includeArchived).filter((row) => !readOnly || !row.unread),
    [includeArchived, listSegment, query, readOnly, rowsForSegment],
  );

  // The tabs' counts are the conversations each tab would list, search aside.
  const tabCounts = useMemo(
    () => ({
      active: rowsForSegment("active", "", false).length,
      archived: rowsForSegment("archived", "", false).length,
    }),
    [rowsForSegment],
  );

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

  const selection = useMemo(
    () => (initialListReady && selectedKey ? parseUnifiedInboxKey(selectedKey) : null),
    [initialListReady, selectedKey],
  );

  useEffect(() => {
    if (!initialListReady) return;
    if (!routeThreadId) return;
    const match = merged.find((r) => r.threadId === routeThreadId);
    if (match) setSelectedKey(match.key);
  }, [initialListReady, routeThreadId, merged]);

  useEffect(() => {
    onThreadOpenChange?.(Boolean(selection));
  }, [onThreadOpenChange, selection]);

  useEffect(() => {
    onThreadSelectedChange?.(Boolean(selection));
  }, [onThreadSelectedChange, selection]);

  useEffect(() => {
    if (!initialListReady) return;
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
  }, [initialListReady, merged, routeThreadId]);

  // Filter and the round + are the page's own tools: they sit on the title row (the shell's
  // slot). With no slot (a test, a record pane) they render beside the search.
  const listControls = listActions ? (
    <div className="flex shrink-0 items-center gap-1 [&_button]:shrink-0 [&_a]:shrink-0" data-attr="communication-list-actions">
      {listActions}
    </div>
  ) : null;
  const listControlsPublished = usePublishTitleActions(listControls, listControls != null);

  const listPane = (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <ResidentCommunicationIdentityCard />
      {needsPhoneVerification ? (
        <Link
          href={`${RESIDENT_PORTAL_BASE_PATH}/profile?tab=messaging`}
          className="mx-3 mb-1 flex h-9 shrink-0 items-center gap-2 rounded-xl border border-primary/30 bg-primary/[0.06] px-3 text-sm font-medium text-primary hover:bg-primary/[0.1]"
          data-attr="resident-communication-verify-phone"
        >
          <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden />
          Verify your number
        </Link>
      ) : null}
      <InboxListHeader
        tabs={
          <InboxListSegmentTabs
            commBase={commBase}
            value={tabSegment}
            counts={initialListReady ? tabCounts : undefined}
            onChange={onSegmentChange}
            interceptNavigation={Boolean(onSegmentChange)}
          />
        }
        search={{
          value: query,
          onChange: setQuery,
          placeholder: "Search communication",
          ariaLabel: "Search messages",
          dataAttr: "resident-inbox-search",
        }}
        count={initialListReady ? merged.length : undefined}
        trailing={listControlsPublished ? null : listControls}
      />
      <div className={`${INBOX_LIST_SCROLL} min-h-0 flex-1`} data-communication-inbox-list>
        {!initialListReady ? (
          <CommunicationInboxInitialState
            error={initialListState === "error"}
            onRetry={loadInitialList}
          />
        ) : merged.length === 0 ? (
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
          ) : null
        ) : (
          merged.map((row) => (
            <InboxConversationRow
              key={row.key}
              appearance="flat"
              // A text-only conversation is derived, read-only: nothing to archive.
              trailing={
                emailThreads.find((t) => t.id === row.threadId)?.smsOnly ? undefined : (
                  <CommunicationRowActions row={row} bulk={bulk} archived={listSegment === "archived"} emailThreads={emailThreads} />
                )
              }
              name={row.name}
              subtitle={row.subtitle}
              preview={row.preview}
              previewPrefix={row.previewPrefix}
              time={row.time}
              unread={row.unread}
              unreadCount={row.unreadCount}
              address={row.address}
              category={row.category}
              recordChip={
                row.recordRef
                  ? { label: row.recordRef.label, href: recordRoutePath("resident", row.recordRef.kind, row.recordRef.id) }
                  : undefined
              }
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
    </div>
  );

  const selectedRow = useMemo(
    () => (selectedKey ? merged.find((row) => row.key === selectedKey || (row.memberKeys ?? []).includes(selectedKey)) ?? null : null),
    [merged, selectedKey],
  );
  const contactDetails = useMemo(
    () =>
      communicationDetailsFromRow(selectedRow, (kind, id) =>
        recordRoutePath("resident", kind as RecordKind, id),
      ),
    [selectedRow],
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
        panes="flat"
        details={contactDetails ? <CommunicationDetailsPane details={contactDetails} /> : undefined}
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
  listSegment: listSegmentProp = "active",
  threadId,
  smsUiEnabled = false,
  residentUserId = null,
  threadFilters,
}: {
  /** Routed conversation list segment (Active / Unread / Archived). */
  listSegment?: InboxListSegment;
  /** Deep-linked thread id from `/communication/{segment}/{threadId}`. */
  threadId?: string;
  /** @deprecated Folder tabs removed; kept so legacy routes still resolve. */
  inboxTabId?: ResidentEmailTabId;
  smsUiEnabled?: boolean;
  residentUserId?: string | null;
  /** Scopes the list to one record (`RecordCommunicationSection`) or one "About" kind. */
  threadFilters?: CommunicationThreadFilters;
}) {
  const commBase = `${RESIDENT_PORTAL_BASE_PATH}/communication`;
  const inboxRef = useRef<ResidentInboxPanelHandle>(null);
  const { activeThreadId, setActiveThreadId } = useCommunicationThreadId(commBase, threadId);
  // Client-tracked segment, the manager's and vendor's shape: a plain-click
  // Active/Archived tab switch updates this via `history.pushState` instead of
  // a full navigation, so the already-loaded list never re-fetches.
  const { segment: listSegment, setSegment: setListSegment } = useCommunicationListSegment(
    commBase,
    listSegmentProp,
  );
  const [threadOpen, setThreadOpen] = useState(Boolean(threadId));
  const [threadSelected, setThreadSelected] = useState(Boolean(threadId));
  const [status, setStatus] = useState<CommunicationStatus>(listSegment);
  useEffect(() => {
    // Archived is the tab's job (hideArchived below) — never let the Filter
    // sheet's own status settle on "archived"/"all" behind it.
    setStatus((current) => {
      if (listSegment === "unread") return current === "unread" ? current : "unread";
      if (current === "archived" || current === "all") return "active";
      return current;
    });
  }, [listSegment]);
  const handleSegmentNavigate = useCallback(
    (next: "active" | "archived") => {
      setListSegment(next);
      // A thread open in one folder never exists in the other — close it so
      // the URL (now segment-only) and the open-thread state agree.
      setActiveThreadId(undefined);
      selectCommunicationSegmentUrl(`${commBase}/${next}`);
    },
    [commBase, setActiveThreadId, setListSegment],
  );
  // The "About" record-kind filter (PLAN-0920-1058 area 1c) — local UI state,
  // merged onto whatever `threadFilters` the caller already scoped this list
  // to (a single record's own Communication section passes `recordRefs`).
  // `threadPassesCommunicationFilters` only narrows, never widens, so this
  // can only remove rows the viewer's authorization already let them see.
  const [recordKindFilter, setRecordKindFilter] = useState<RecordKind | "">("");

  const effectiveThreadFilters = useMemo<CommunicationThreadFilters | undefined>(() => {
    if (!recordKindFilter) return threadFilters;
    return { ...(threadFilters ?? EMPTY_COMMUNICATION_THREAD_FILTERS), recordKinds: [recordKindFilter] };
  }, [threadFilters, recordKindFilter]);

  // The list segment actually fed to the merge is the tab (Active/Archived)
  // combined with the Filter's own Unread/Read — archived always wins.
  const mergeSegment: InboxListSegment =
    listSegment === "archived" ? "archived" : status === "unread" ? "unread" : "active";

  const communicationFilterSheet = (
    <PortalFilterSortSheet
      activeCount={(status === "active" ? 0 : 1) + (recordKindFilter ? 1 : 0)}
      compactPanel
      filterFieldCount={2}
      constrainDropdownToTitleBand={false}
      // The same plain filter glyph the manager's list row uses; the word
      // lives in the tooltip and the active count in the accessible name.
      commandStripTrigger
      mobileFlushBody
      dataAttr="resident-communication-filter-open"
    >
      <CommunicationStatusFilterDraft value={status} onChange={setStatus} hideArchived />
      <FieldSingleSelect
        label="About"
        value={recordKindFilter}
        onChange={(next) => setRecordKindFilter((next || "") as RecordKind | "")}
        options={[{ value: "", label: "All records" }, ...RECORD_KIND_FILTER_OPTIONS]}
        placeholder="All records"
        dataAttr="resident-communication-filter-about"
      />
    </PortalFilterSortSheet>
  );

  const openCompose = () => inboxRef.current?.openCompose();

  const communicationNewMessageButton = (
    <PortalPrimaryIconAction
      icon={PenSquare}
      label="New message"
      data-attr="communication-new-message"
      onClick={openCompose}
    />
  );

  // Both tools sit beside the list's own Search, inside the list card, on
  // every breakpoint — never in the title band as well. One place means each
  // control reaches a phone exactly once (guarded by
  // tests/unit/portal-inline-title-band-duplicate-controls.test.tsx).
  const communicationCommandActions = (
    <>
      {communicationFilterSheet}
      {communicationNewMessageButton}
    </>
  );

  return (
    <PortalCommunicationShell
      title="Communication"
      hideTitleOnMobileNav
      hideMobileFilterRow={threadOpen}
      mobileThreadReading={threadOpen}
      threadSelected={threadSelected}
      hideAssistantFab
    >
      <ResidentUnifiedInbox
        inboxRef={inboxRef}
        smsUiEnabled={smsUiEnabled}
        listSegment={mergeSegment}
        tabSegment={listSegment === "archived" ? "archived" : "active"}
        readOnly={status === "read"}
        routeThreadId={activeThreadId}
        onRouteThreadChange={setActiveThreadId}
        onThreadOpenChange={setThreadOpen}
        onThreadSelectedChange={setThreadSelected}
        commBase={commBase}
        listActions={communicationCommandActions}
        residentUserId={residentUserId}
        threadFilters={effectiveThreadFilters}
        onSegmentChange={handleSegmentNavigate}
      />
    </PortalCommunicationShell>
  );
}
