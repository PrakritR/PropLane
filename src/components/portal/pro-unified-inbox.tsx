"use client";

import { MessageSquarePlus, Trash2 } from "lucide-react";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { portalEmptyCopy, portalEmptyNoMatchTitle, type PortalEmptyCopyKey } from "@/lib/portal-empty-copy";
import { CommunicationRowActions } from "@/components/portal/communication-row-actions";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  clearCommunicationThreadUrl,
  selectCommunicationThreadUrl,
} from "@/lib/portal-communication-nav";
import { ManagerInbox, type ManagerInboxHandle } from "@/components/portal/pro-inbox";
import { managerInboxAdapter } from "@/components/portal/communication-adapters/manager-inbox-adapter";
import type { CommunicationInboxAdapter } from "@/lib/communication/inbox-adapter";
import { ManagerSmsPanel, smsOutboundPreviewPrefix, type ManagerSmsPanelHandle } from "@/components/portal/pro-sms-panel";

import {
  PortalContactDetailsModal,
} from "@/components/portal/portal-contact-details-modal";
import { dispatchManagerSmsContactsChanged } from "@/lib/manager-sms-messages";
import { pollShouldHaltAfterStatus } from "@/lib/poll-halt";
import { createCoalescedRefresher, type CoalescedRefresher } from "@/lib/coalesced-refresh";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import { useIsClient } from "@/hooks/use-is-client";
import { usePortalSession } from "@/hooks/use-portal-session";
import { CommunicationInboxInitialState } from "@/components/portal/communication-inbox-initial-state";
import { useOptionalAppUi } from "@/components/providers/app-ui-provider";
import { usePublishTitleActions } from "@/components/portal/portal-title-actions-slot";
import {
  CommunicationDetailsPane,
  type CommunicationDetails,
  type CommunicationDetailsRecord,
} from "@/components/portal/communication-details-pane";
import { counterpartyRoleLabel } from "@/lib/sms-conversation-identity";
import { formatSmsPhoneLabel } from "@/lib/phone-e164";
import { recordRoutePath } from "@/lib/portals/record-kinds";
import {
  INBOX_LIST_SCROLL,
  InboxConversationRow,
  InboxListHeader,
  InboxListSegmentTabs,
  InboxThreadEmpty,
  InboxThreadSkeleton,
  InboxTwoPane,
  type InboxListSegment,
} from "@/components/portal/portal-inbox-ui";
import {
  conversationAddressLabel,
  conversationHouseLabels,
  inboxRowAddressLabel,
  inboxThreadCategoryLabel,
  inboxThreadUnreadCount,
} from "@/lib/communication-row-meta";
import { filterEmailInboxThreads } from "@/lib/communication-inbox-filters";
import {
  emailThreadJoinKeys,
  emailThreadPersonKey,
  smsConversationJoinKeys,
  smsConversationPersonKey,
  smsConversationRowId,
} from "@/lib/communication-active-rows";
import { isAssistantUnifiedInboxRow, isPropLaneAssistantInboxThread } from "@/lib/communication-inbox-assistant";
import {
  assistantUnifiedListItemFromThread,
  buildManagerAssistantPlaceholderThread,
  communicationInboxListPreview,
  ensurePinnedManagerAssistantUnifiedItems,
  pinPropLaneAssistantUnifiedItems,
  propLaneAssistantListPreview,
  propLaneAssistantListSubtitle,
  propLaneAssistantThreadIdForPortal,
  resolveCommunicationViewerId,
  withPinnedPropLaneAssistantThreads,
} from "@/lib/communication-assistant-inbox-list";
import { useActiveWorkspaceIdentity } from "@/hooks/use-selected-workspace-id";
import {
  buildResidentPlaceholderInboxItems,
  parseContactInboxThreadId,
} from "@/lib/communication-resident-placeholders";
import { archivePlaceholderContactThread } from "@/lib/communication-inbox-thread-mutations";
import {
  threadPassesCommunicationFilters,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import { ResidentDirectChatPane } from "@/components/portal/pro-resident-detail-inbox";
import {
  collapsePersonInboxThreads,
  inboxThreadMessages,
  inboxThreadSortMs,
  inboxMessageOutbound,
  markPersistedInboxSourcesRead,
  reconcileObservedInboxReadRows,
  retryWhileStale,
  formatInboxListNarrowTime,
  type PersistedInboxSyncResult,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import { inboxThreadLastTurnDirection } from "@/lib/inbox-turn-direction";
import {
  mergeUnifiedInboxItems,
  parseUnifiedInboxKey,
  unifiedInboxKey,
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
import { isVoiceCallNoteSid, voiceCallListPreviewPrefix } from "@/lib/voice/voice-call-notes";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import { inboxCounterpartyName } from "@/lib/manager-inbox-contacts";
import {
  loadManagerSmsArchivedIds,
  MANAGER_SMS_ARCHIVE_CHANGED_EVENT,
  mirrorManagerSmsArchivedFromServer,
} from "@/lib/manager-sms-archive.client";
import { loadManagerSmsOpenedIds, markManagerSmsOpenedIds } from "@/lib/manager-sms-opened.client";
import { loadSmsHiddenIds } from "@/lib/manager-sms-hidden.client";
import { startObservedInboxReadOperation } from "@/lib/portal-inbox-read-operation.client";
import { applySmsProjectionListMutation } from "@/lib/sms-projection-list-reconciliation";

function sameStringSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function previewLine(body: string, max = 80) {
  const t = body.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

// Alias so every existing call site keeps reading naturally; the actual
// derivation is shared with the sidebar badge (`communication-active-rows.ts`)
// so a hidden/archived id lookup here and the badge's own lookup can never
// disagree.
const smsConversationId = (resident: ManagerSmsResidentConversation) =>
  resident.projectionId ?? smsConversationRowId(resident);

function emailThreadMergeStub(t: PersistedInboxThread): UnifiedInboxListItem {
  const smsBindingKeys = [...new Set(
    [...(t.smsBindingKeys ?? []), t.smsConversationKey ?? ""]
      .map((key) => key.trim())
      .filter(Boolean),
  )];
  return {
    key: unifiedInboxKey("email", t.id),
    channel: "email",
    threadId: t.id,
    name: t.id,
    preview: "",
    time: "",
    unread: false,
    sortMs: 0,
    memberKeys: (t.sourceThreadIds ?? [t.id]).map((id) => unifiedInboxKey("email", id)),
    ...(smsBindingKeys.length > 0 ? { smsBindingKeys } : {}),
    ...(smsBindingKeys.length === 1 ? { smsBindingKey: smsBindingKeys[0] } : {}),
    personKey: emailThreadPersonKey(t),
    joinKeys: emailThreadJoinKeys(t),
    identityFlag: t.identityFlag ? true : undefined,
  };
}

/** Desktop shows list + thread together; phones use list-then-thread navigation. */
function inboxUsesDesktopSplit(): boolean {
  if (typeof window === "undefined") return true;
  if (typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(min-width: 1024px)").matches;
}

type ManagerInboxSnapshot = {
  emailThreads: PersistedInboxThread[];
  smsResidents: ManagerSmsResidentConversation[];
};

/**
 * Last-ready Communication list per viewer+workspace, held only for the life
 * of this module (PLAN B2). `ManagerUnifiedInbox` can remount without a full
 * page reload — e.g. navigating to another portal section and back — and
 * without this it re-showed the loading skeleton and re-ran every source
 * fetch even though the exact same list was already known. On such a
 * remount this snapshot renders immediately instead, while `loadInitialList`
 * revalidates silently underneath; a failed revalidation keeps showing the
 * snapshot rather than surfacing an error. The very first load of a browser
 * session has no entry yet and keeps the original all-sources-ready
 * invariant (`tests/unit/inbox-initial-loading-readiness.test.tsx`).
 */
const managerInboxSnapshotCache = new Map<string, ManagerInboxSnapshot>();
export function resetManagerInboxSnapshotCacheForTests(): void {
  managerInboxSnapshotCache.clear();
}

function managerInboxSnapshotKey(
  viewerId: string,
  workspaceId: string | null | undefined,
  adapterKind: CommunicationInboxAdapter["kind"] = "manager",
): string {
  // The manager key is unchanged; another adapter never shares a snapshot with it.
  return adapterKind === "manager"
    ? `${viewerId}::${workspaceId ?? "default"}`
    : `${adapterKind}:${viewerId}::${workspaceId ?? "default"}`;
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
  listActions,
  listPrimary,
  onAddConversation,
  onApplicationsLoaded,
  onArchivedViewChange,
  adapter = managerInboxAdapter,
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
  /** Icon tools drawn beside the internal search (filter · settings). */
  listActions?: ReactNode;
  /** Round primary compose control at the end of the command row. */
  listPrimary?: ReactNode;
  /** Opens the new-message / compose flow when the list is empty on Active. */
  onAddConversation?: () => void;
  /** Rebuild the parent-owned contact directory after its source has completed. */
  onApplicationsLoaded?: () => void;
  /** Filter status follows the Active | Archived tabs. */
  onArchivedViewChange?: (next: Extract<InboxListSegment, "active" | "archived">) => void;
  /**
   * Where the conversations come from and how they are changed. Defaults to the
   * manager's own sources; the admin page mounts this same component with the
   * admin adapter (`CommunicationInboxAdapter`).
   */
  adapter?: CommunicationInboxAdapter;
}) {
  const isClient = useIsClient();
  const [emailThreads, setEmailThreads] = useState<PersistedInboxThread[]>([]);
  const [smsResidents, setSmsResidents] = useState<ManagerSmsResidentConversation[]>([]);
  const [smsListVersion, setSmsListVersion] = useState(0);
  const [smsNextCursor, setSmsNextCursor] = useState<string | null>(null);
  // A fresh head starts a new paging window because conversation recency can
  // reorder rows; an append advances only that window's continuation.
  const oldestSmsCursorRef = useRef<string | null>(null);
  const smsListWindowGenerationRef = useRef(0);
  const [smsLoadingMore, setSmsLoadingMore] = useState(false);
  const [smsPageError, setSmsPageError] = useState<string | null>(null);
  const [smsOpenedIds, setSmsOpenedIds] = useState<Set<string>>(() => new Set());
  const smsOpenedIdsRef = useRef(smsOpenedIds);
  const deletedSmsProjectionIdsRef = useRef(new Set<string>());
  const [smsHiddenIds, setSmsHiddenIds] = useState<Set<string>>(() => loadSmsHiddenIds());
  const [smsArchivedIds, setSmsArchivedIds] = useState<Set<string>>(() => loadManagerSmsArchivedIds());
  const [internalQuery, setInternalQuery] = useState("");
  const query = onSearchQueryChange ? (searchQueryProp ?? "") : internalQuery;
  const setQuery = onSearchQueryChange ?? setInternalQuery;
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [routedSmsError, setRoutedSmsError] = useState<string | null>(null);
  const resolvedSmsRouteRef = useRef<{ requested: string; canonical: string; context: string } | null>(null);
  const explicitlyOpened = useRef<{ key: string; context: string } | null>(null);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(Boolean(routeThreadId));
  const statusFilter =
    threadFilters?.status ?? (listSegmentProp === "unread" ? "unread" : "active");
  // Active | Archived is the URL tab. Filter unread/read refines inside that
  // folder and must not collapse Archived back to Active.
  const folder: Extract<InboxListSegment, "active" | "archived"> =
    listSegmentProp === "archived" ? "archived" : "active";
  const listSegment: InboxListSegment =
    folder === "archived" ? "archived" : statusFilter === "unread" ? "unread" : "active";
  const includeArchived = folder === "archived" || statusFilter === "all";
  const appUi = useOptionalAppUi();
  const { userId, ready: sessionReady } = usePortalSession();
  const viewerId = resolveCommunicationViewerId(null, userId);
  const workspaceIdentity = useActiveWorkspaceIdentity();
  const assistantWorkspace = useMemo(
    () =>
      workspaceIdentity.id
        ? { id: workspaceIdentity.id, isDefault: workspaceIdentity.isDefault }
        : null,
    [workspaceIdentity.id, workspaceIdentity.isDefault],
  );
  const viewerEpochRef = useRef(0);
  const viewerAuthority = useMemo(() => ({ viewerId }), [viewerId]);
  const currentViewerAuthorityRef = useRef(viewerAuthority);
  const currentViewerIdRef = useRef(viewerId);
  const previousViewerIdRef = useRef(viewerId);
  const smsResidentsViewerEpochRef = useRef(0);
  const previousSmsWorkspaceIdRef = useRef(workspaceIdentity.id);
  const currentSmsWorkspaceIdRef = useRef(workspaceIdentity.id);
  const smsWorkspaceEpochRef = useRef(0);
  const directSendRefreshGeneration = useRef(0);
  const directSendInboxRefreshersRef = useRef(
    new Map<object, CoalescedRefresher<PersistedInboxSyncResult>>(),
  );
  // Set once the SMS poll has been refused for an auth reason. The next tick
  // would be refused identically, so the loop stops instead of failing every
  // 20 seconds for the life of the tab. A 5xx still retries — see
  // pollShouldHaltAfterStatus.
  const smsPollHaltedRef = useRef(false);
  const [smsPollHalted, setSmsPollHalted] = useState(false);
  useLayoutEffect(() => {
    const previousViewerId = previousViewerIdRef.current;
    if (previousViewerId !== viewerId) {
      adapter.invalidateSmsConversations(previousViewerId);
      adapter.invalidateSmsConversations(viewerId);
      previousViewerIdRef.current = viewerId;
    }
    const nextViewerEpoch = viewerEpochRef.current + 1;
    currentViewerAuthorityRef.current = viewerAuthority;
    currentViewerIdRef.current = viewerId;
    viewerEpochRef.current = nextViewerEpoch;
    smsResidentsViewerEpochRef.current = nextViewerEpoch;
    directSendRefreshGeneration.current += 1;
    directSendInboxRefreshersRef.current.clear();
    // SMS contacts and a refused-poll latch are viewer-owned. A retained
    // component can switch sessions without remounting, so neither may carry
    // a previous viewer's contact metadata or authorization state forward.
    setSmsResidents([]);
    deletedSmsProjectionIdsRef.current.clear();
    oldestSmsCursorRef.current = null;
    setSmsNextCursor(null);
    setSmsPageError(null);
    const nextOpened = loadManagerSmsOpenedIds(viewerId);
    smsOpenedIdsRef.current = nextOpened;
    setSmsOpenedIds((current) => sameStringSet(current, nextOpened) ? current : nextOpened);
    smsPollHaltedRef.current = false;
    setSmsPollHalted(false);
  }, [adapter, viewerAuthority, viewerId]);
  useLayoutEffect(() => {
    if (previousSmsWorkspaceIdRef.current === workspaceIdentity.id) return;
    previousSmsWorkspaceIdRef.current = workspaceIdentity.id;
    currentSmsWorkspaceIdRef.current = workspaceIdentity.id;
    smsWorkspaceEpochRef.current += 1;
    setSmsResidents([]);
    deletedSmsProjectionIdsRef.current.clear();
    oldestSmsCursorRef.current = null;
    setSmsNextCursor(null);
    setSmsPageError(null);
  }, [workspaceIdentity.id]);
  const assistantThreadId = viewerId && adapter.pinsAssistant
    ? propLaneAssistantThreadIdForPortal("manager", viewerId, assistantWorkspace)
    : null;
  const [initialListState, setInitialListState] = useState<"loading" | "ready" | "error">("loading");
  const [initialListViewerId, setInitialListViewerId] = useState<string | null>(null);
  const initialLoadGeneration = useRef(0);
  const initialListReady = isClient && initialListState === "ready" && initialListViewerId === viewerId;
  const selectionContext = JSON.stringify({
    viewerId,
    statusFilter,
    query: query.trim().toLowerCase(),
    filters: threadFilters ?? null,
    scope: commBase,
  });

  const threadListHref = useCallback(
    () => `${commBase}/${listSegment}`,
    [commBase, listSegment],
  );

  const threadDetailHref = useCallback(
    (threadId: string) => `${commBase}/${listSegment}/${encodeURIComponent(threadId)}`,
    [commBase, listSegment],
  );

  const closeActiveThread = useCallback(() => {
    explicitlyOpened.current = null;
    setSelectedKey(null);
    setMobileThreadOpen(false);
    onRouteThreadChange?.(undefined);
    clearCommunicationThreadUrl(threadListHref());
  }, [onRouteThreadChange, threadListHref]);

  useEffect(() => {
    const syncArchive = () => setSmsArchivedIds(loadManagerSmsArchivedIds());
    window.addEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, syncArchive as EventListener);
    return () => window.removeEventListener(MANAGER_SMS_ARCHIVE_CHANGED_EVENT, syncArchive as EventListener);
  }, []);

  useEffect(() => {
    if (!isClient) return;
    setEmailThreads(adapter.loadCachedThreads());
  }, [adapter, isClient]);

  useEffect(() => {
    const sync = () => setEmailThreads(adapter.loadCachedThreads());
    window.addEventListener(adapter.threadsChangedEvent, sync as EventListener);
    return () => window.removeEventListener(adapter.threadsChangedEvent, sync as EventListener);
  }, [adapter]);

  useEffect(() => {
    if (!adapter.pinsAssistant) return;
    if (!isClient || !initialListReady || !viewerId?.trim()) return;
    if (listSegment === "archived") return;
    let staged: PersistedInboxThread[] | null = null;
    setEmailThreads((current) => {
      const placeholder = buildManagerAssistantPlaceholderThread(viewerId, assistantWorkspace);
      const hasLive = current.some((thread) => thread.id === placeholder.id && thread.folder !== "trash");
      if (hasLive) return current;
      const next = withPinnedPropLaneAssistantThreads(current, "manager", viewerId, listSegment, assistantWorkspace);
      staged = next;
      return next;
    });
    if (staged) {
      queueMicrotask(() => adapter.stageThreads(staged!));
    }
  }, [adapter, assistantWorkspace, initialListReady, isClient, listSegment, viewerId]);

  const loadSms = useCallback(async ({ force = false, initialGeneration, cursor, append = false }: { force?: boolean; initialGeneration?: number; cursor?: string | null; append?: boolean } = {}): Promise<boolean> => {
    const requestViewerEpoch = viewerEpochRef.current;
    const requestedWindowGeneration = smsListWindowGenerationRef.current;
    const requestViewerId = viewerId;
    const requestWorkspaceId = workspaceIdentity.id;
    if (smsPollHaltedRef.current) return false;
    if (append) setSmsLoadingMore(true);
    setSmsPageError(null);
    try {
      const res = await adapter.loadSmsConversations({
        viewerId: requestViewerId ?? "",
        force,
        workspaceId: workspaceIdentity.id,
        cursor,
      });
      if (
        currentViewerIdRef.current !== requestViewerId ||
        currentSmsWorkspaceIdRef.current !== requestWorkspaceId ||
        viewerEpochRef.current !== requestViewerEpoch ||
        (initialGeneration !== undefined && initialGeneration !== initialLoadGeneration.current)
      ) {
        return false;
      }
      if (pollShouldHaltAfterStatus(res.status)) {
        smsPollHaltedRef.current = true;
        setSmsPollHalted(true);
        if (append) setSmsPageError("Could not load more conversations.");
        return false;
      }
      if (!res.ok) {
        if (append) setSmsPageError("Could not load more conversations.");
        return false;
      }
      const body = (await res.json()) as { residents?: ManagerSmsResidentConversation[]; nextCursor?: string | null };
      if (!body || !Array.isArray(body.residents)) {
        if (append) setSmsPageError("Could not load more conversations.");
        return false;
      }
      if (
        viewerEpochRef.current !== requestViewerEpoch ||
        currentSmsWorkspaceIdRef.current !== requestWorkspaceId ||
        (append && requestedWindowGeneration !== smsListWindowGenerationRef.current) ||
        (initialGeneration !== undefined && initialGeneration !== initialLoadGeneration.current)
      ) {
        return false;
      }
      const normalized = normalizeManagerSmsConversationsPayload(body);
      const server = normalized.residents.filter((row) => !row.projectionId || !deletedSmsProjectionIdsRef.current.has(row.projectionId));
      if (!append) smsListWindowGenerationRef.current += 1;
      oldestSmsCursorRef.current = normalized.nextCursor ?? null;
      setSmsNextCursor(oldestSmsCursorRef.current);
      mirrorManagerSmsArchivedFromServer(normalized.residents);
      setSmsArchivedIds(loadManagerSmsArchivedIds());
      setSmsResidents((current) => {
        if (smsResidentsViewerEpochRef.current !== requestViewerEpoch) return current;
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
        if (append) {
          const byId = new Map(current.map((row) => [smsConversationId(row), row]));
          for (const row of server) {
            const id = smsConversationId(row);
            const previous = byId.get(id);
            byId.set(id, previous && previous.projectionId &&
              (previous.stateVersion ?? 0) > (row.stateVersion ?? 0)
              ? previous : previous ? { ...previous, ...row } : row);
          }
          return [...byId.values()];
        }
        // Conversation recency is mutable. An old row can move into the new
        // head while an entire middle page is still missing, so every head
        // refresh starts a new authorized pagination window.
        const currentById = new Map(current.map((row) => [smsConversationId(row), row]));
        const unique = new Map<string, ManagerSmsResidentConversation>();
        for (const row of [...pendingOptimistic, ...server]) {
          const id = smsConversationId(row);
          const previous = currentById.get(id);
          unique.set(id, previous && previous.projectionId &&
            (previous.stateVersion ?? 0) > (row.stateVersion ?? 0) ? previous : row);
        }
        return [...unique.values()];
      });
      if (!append) setSmsListVersion((version) => version + 1);
      return true;
    } catch {
      if (append) setSmsPageError("Could not load more conversations.");
      return false;
    } finally {
      if (append) setSmsLoadingMore(false);
    }
  }, [adapter, viewerId, workspaceIdentity.id]);

  const loadMoreSms = useCallback(() => {
    if (!smsNextCursor || smsLoadingMore) return;
    void loadSms({ cursor: smsNextCursor, append: true });
  }, [loadSms, smsLoadingMore, smsNextCursor]);

  const loadInitialList = useCallback(async (): Promise<void> => {
    const requestGeneration = ++initialLoadGeneration.current;
    if (!isClient || !sessionReady || !viewerId?.trim()) {
      setInitialListViewerId(null);
      setInitialListState("loading");
      setSelectedKey(null);
      setMobileThreadOpen(false);
      return;
    }
    setInitialListViewerId(viewerId);
    // PLAN B2: a remount within the same session already proved this exact
    // viewer+workspace ready once (`managerInboxSnapshotCache`, seeded by the
    // layout effect below). Keep showing it — never flash back to "loading" —
    // while the fetches below revalidate silently.
    const hadCachedSnapshot = managerInboxSnapshotCache.has(
      managerInboxSnapshotKey(viewerId, workspaceIdentity.id, adapter.kind),
    );
    if (!hadCachedSnapshot) setInitialListState("loading");
    const [inbox, applications, smsOk] = await Promise.all([
      retryWhileStale(() => adapter.syncThreads()),
      // A surface with no contact directory (admin) is ready without one.
      adapter.syncDirectory
        ? retryWhileStale(() => adapter.syncDirectory!(viewerId))
        : Promise.resolve({ ok: true, stale: false }),
      // force unless this is a remount that already proved the list ready
      // (`hadCachedSnapshot`): the first load of a session decides whether the
      // page is "ready" or "error" (and the one an explicit Retry re-runs via
      // retryInitialList below), so it must be a genuine new attempt, never
      // the shared sms-conversations TTL cache's last (possibly failed,
      // possibly another caller's) response. A tab switch BACK to this page
      // revalidates silently on the TTL + in-flight guarded path instead of
      // refetching the whole list every time.
      loadSms({ force: !hadCachedSnapshot, initialGeneration: requestGeneration }),
    ]);
    if (requestGeneration !== initialLoadGeneration.current) return;
    if (inbox.stale || applications.stale) {
      // Still stale after the retries: show the error/Retry state, never a skeleton that cannot resolve.
      if (!hadCachedSnapshot) setInitialListState("error");
      return;
    }
    if (applications.ok) onApplicationsLoaded?.();
    if (inbox.ok) setEmailThreads(inbox.rows);
    const ready = inbox.ok && applications.ok && smsOk;
    // A background revalidation failure after a cache hit keeps the last
    // known-good snapshot on screen (silent) instead of surfacing an error —
    // the very first load of a session has no cache hit and keeps the
    // original invariant exactly.
    setInitialListState(ready || hadCachedSnapshot ? "ready" : "error");
  }, [adapter, isClient, loadSms, onApplicationsLoaded, sessionReady, viewerId, workspaceIdentity.id]);

  const retryInitialList = useCallback(async (): Promise<void> => {
    // An authorization refusal pauses automatic SMS polling for this viewer.
    // A person explicitly retrying is the only same-viewer path allowed to
    // clear that pause after access has recovered.
    smsPollHaltedRef.current = false;
    setSmsPollHalted(false);
    return loadInitialList();
  }, [loadInitialList]);

  useEffect(() => {
    void loadInitialList();
    return () => {
      initialLoadGeneration.current += 1;
    };
  }, [loadInitialList]);

  // PLAN B2 — seed from the last-ready snapshot BEFORE paint on a remount, so
  // the skeleton never has a chance to flash. `useLayoutEffect` (not
  // `useEffect`) so this commits in the same phase as the mount, ahead of
  // `loadInitialList`'s own effect above. A brand-new session has no cache
  // entry and this is a no-op, preserving the original invariant.
  //
  // This is a MOUNT-only opportunity — `hasSeededSnapshotRef` is consumed the
  // first time `viewerId` resolves truthy and never re-armed. A genuine
  // account switch WITHIN the same mounted instance (A-B-A) must keep going
  // through the ordinary fetch cycle: seeding again on every viewerId change
  // would restore viewer A's stale rows the instant the session flips back
  // to A, defeating the deliberate "empty during the transition" guarantee
  // those cases already have (see the A-B-A tests in
  // `tests/unit/inbox-initial-loading-readiness.test.tsx`).
  const hasSeededSnapshotRef = useRef(false);
  useLayoutEffect(() => {
    if (hasSeededSnapshotRef.current) return;
    if (!isClient || !viewerId?.trim()) return;
    hasSeededSnapshotRef.current = true;
    const key = managerInboxSnapshotKey(viewerId, workspaceIdentity.id, adapter.kind);
    const cached = managerInboxSnapshotCache.get(key);
    if (!cached) return;
    setInitialListViewerId(viewerId);
    setInitialListState("ready");
    setEmailThreads(cached.emailThreads);
    setSmsResidents(cached.smsResidents);
  }, [adapter.kind, isClient, viewerId, workspaceIdentity.id]);

  // Keep the snapshot cache mirroring whatever is currently rendered as
  // "ready", so the NEXT remount of this viewer+workspace has the freshest
  // possible fallback (including live updates while mounted, e.g. polling).
  useEffect(() => {
    if (!isClient || !viewerId?.trim()) return;
    if (initialListState !== "ready" || initialListViewerId !== viewerId) return;
    managerInboxSnapshotCache.set(managerInboxSnapshotKey(viewerId, workspaceIdentity.id, adapter.kind), {
      emailThreads,
      smsResidents,
    });
  }, [adapter.kind, emailThreads, initialListState, initialListViewerId, isClient, smsResidents, viewerId, workspaceIdentity.id]);

  useEffect(() => {
    if (smsPollHalted || initialListState !== "ready") return;
    // Poll for inbound texts, but skip while the tab is backgrounded (no point
    // spending egress on a hidden page) and refetch immediately on refocus so
    // the list is fresh the moment the manager returns.
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void loadSms();
    };
    const id = window.setInterval(tick, 20_000);
    const onVis = () => {
      // Refocus reads through the 20s TTL: the poll above keeps a visible
      // page at most that old, so anything older than the window refetches
      // here and a quick app switch does not hit the network at all.
      if (document.visibilityState === "visible") void loadSms();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [initialListState, loadSms, smsPollHalted]);

  useEffect(() => {
    const refreshContacts = (event: Event) => {
      const requestViewerEpoch = viewerEpochRef.current;
      const detail = (event as CustomEvent<ManagerSmsContactsChangedDetail>).detail;
      const optimistic = detail?.optimisticResident;
      if (optimistic?.conversationKey) {
        setSmsResidents((current) => {
          if (smsResidentsViewerEpochRef.current !== requestViewerEpoch) return current;
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
      // A contact just changed (new SMS thread created) — same "something
      // changed, get a real answer" case onSmsDeleted and the direct-send
      // refresh already force; this listener was the one inconsistent case.
      void loadSms({ force: true });
    };
    window.addEventListener(MANAGER_SMS_CONTACTS_CHANGED_EVENT, refreshContacts);
    return () => window.removeEventListener(MANAGER_SMS_CONTACTS_CHANGED_EVENT, refreshContacts);
  }, [loadSms]);

  // Stable identity: passed into ManagerSmsPanel's controlled-open effect, so an
  // inline callback here would change every render and loop the effect forever.
  // Opening a conversation only changes local read state — refresh the opened-id
  // set for the unread badges, but do NOT refetch (the server data is unchanged,
  // and the open SMS panel already reloads on its own; a refetch here was a
  // redundant round-trip on every thread open).
  const handleSmsConversationOpened = useCallback(() => {
    const nextOpened = loadManagerSmsOpenedIds(viewerId, smsOpenedIdsRef.current);
    smsOpenedIdsRef.current = nextOpened;
    setSmsOpenedIds((current) => sameStringSet(current, nextOpened) ? current : nextOpened);
  }, [viewerId]);
  const handleSmsProjectionStateChanged = useCallback(() => {
    void loadSms({ force: true });
  }, [loadSms]);

  const filteredEmail = useMemo(() => {
    // The exact rows the Active tab shows — lifted into a shared builder so the
    // Communication sidebar badge can never drift from what this list renders.
    // `withPinnedPropLaneAssistantThreads` ignores `listSegment` for the
    // manager portal (it always keeps the workspace's Assistant thread live),
    // so hardcoding "active" inside the builder is not a behaviour change here.
    const withAssistant = adapter.buildListThreads(emailThreads, {
      viewerId,
      workspace: assistantWorkspace,
      smsUiEnabled,
    });
    // The contacts directory only gates the property/role/person dimensions
    // (they need it to resolve a match); a record-only filter has everything
    // it needs on the thread itself and must not wait on that fetch.
    const hasRecordFilter = Boolean(threadFilters?.recordRefs?.length || threadFilters?.recordKinds?.length);
    if (!threadFilters || (!filterContacts && !hasRecordFilter)) return withAssistant;
    return withAssistant.filter((t) =>
      isPropLaneAssistantInboxThread(t) ||
      threadPassesCommunicationFilters({
        filters: threadFilters,
        contacts: filterContacts ?? [],
        counterpartyEmail: t.email,
        recordRef: t.recordRef,
      }),
    );
  }, [adapter, assistantWorkspace, emailThreads, threadFilters, filterContacts, smsUiEnabled, viewerId]);

  const emailListItems = useMemo((): UnifiedInboxListItem[] => {
    const q = query.trim().toLowerCase();
    let rows = filteredEmail;
    if (listSegment === "archived") {
      rows = rows.filter((t) => t.folder === "trash");
    } else if (listSegment === "unread") {
      // Keep read state out of the canonical eligibility set. The visible list
      // applies it below so an explicitly opened row can survive being read.
      rows = rows.filter((t) => t.folder !== "trash" && t.folder === "inbox");
    } else if (!includeArchived) {
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
      const smsBindingKeys = [...new Set(
        [...(t.smsBindingKeys ?? []), t.smsConversationKey ?? ""]
          .map((key) => key.trim())
          .filter(Boolean),
      )];
      const sentSemantics = t.folder === "sent";
      // Title the row by the person's name when they are in the directory
      // (PRP-315); the address stays available in the open thread.
      const displayName =
        inboxCounterpartyName(
          t.email,
          sentSemantics && !adapter.namesSentThreadsByFrom ? null : t.from,
          filterContacts,
        ) ||
        (sentSemantics ? "Unknown recipient" : "Unknown sender");
      const lastOutbound = inboxThreadLastTurnDirection(t) === "outbound";
      return {
        key: unifiedInboxKey("email", t.id),
        channel: "email" as const,
        threadId: t.id,
        memberKeys: (t.sourceThreadIds ?? [t.id]).map((id) => unifiedInboxKey("email", id)),
        readSources: t.readSources,
        readSourcesComplete: t.readSourcesComplete,
        ...(smsBindingKeys.length > 0 ? { smsBindingKeys } : {}),
        ...(smsBindingKeys.length === 1 ? { smsBindingKey: smsBindingKeys[0] } : {}),
        // Who this is with, so a text thread with the same person folds in —
        // shared with the sidebar badge (`communication-active-rows.ts`).
        personKey: emailThreadPersonKey(t),
        // One conversation per person per workspace: rows sharing this key join,
        // whatever channel or thread type each started as.
        joinKeys: emailThreadJoinKeys(t),
        identityFlag: t.identityFlag ? true : undefined,
        aliasThreadIds: t.aliasIds,
        personEmail: t.email?.trim() || undefined,
        name: displayName,
        subtitle: isPropLaneAssistantInboxThread(t)
          ? propLaneAssistantListSubtitle(t)
          : t.subject,
        preview: isPropLaneAssistantInboxThread(t)
          ? propLaneAssistantListPreview(t, listSegment)
          : communicationInboxListPreview(
              lastMsg?.body?.trim()
                ? lastMsg.body
                : lastMsg
                  ? ""
                  : (t.preview ?? ""),
              listSegment,
              80,
            ),
        previewPrefix: lastOutbound ? "You: " : undefined,
        time: formatInboxListNarrowTime(lastMsg?.at ?? t.time),
        unread: t.folder === "inbox" && t.unread,
        unreadCount: inboxThreadUnreadCount(t),
        // The house the server resolved the thread to be about — the same set
        // that decided the row is visible at all. The contact directory (joined
        // by email) is the fallback for rows the server could not place.
        address: conversationAddressLabel(
          inboxRowAddressLabel(
            t.houses?.[0]?.label ??
              filterContacts?.find((c) => c.email?.trim().toLowerCase() === t.email?.trim().toLowerCase())
                ?.propertyLabel,
          ),
          t.houses,
        ),
        houseLabels: conversationHouseLabels(t.houses),
        category: inboxThreadCategoryLabel(t),
        recordRef: t.recordRef,
        // Sort on the SAME field the row is labelled with. `lastMsg.at` is the
        // raw stamp its writer happened to build; only `thread.time` is
        // normalized (`appendReplyToInboxThread` advances it to the latest
        // reply), so sorting on the message stamp let an unparseable one fall
        // back to the id's creation epoch and never float a reply to the top.
        sortMs: inboxThreadSortMs(t.id, t.time),
      };
    });
  }, [adapter.namesSentThreadsByFrom, filteredEmail, query, listSegment, includeArchived]);

  const explicitlyBoundSmsKeys = useMemo(
    () => new Set(filteredEmail.flatMap((thread) => [
      ...(thread.smsBindingKeys ?? []),
      thread.smsConversationKey ?? "",
    ]).map((key) => key.trim()).filter(Boolean)),
    [filteredEmail],
  );

  // SMS rows (scoped + de-hidden) come from the same projection in either UI
  // flag state; the flag only controls SMS-specific composer chrome.
  const allSmsItems = useMemo((): {
    item: UnifiedInboxListItem;
    lastOutbound: boolean;
    haystack: string;
    archived: boolean;
    unread: boolean;
  }[] => {
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
        const archived = resident.projectionId
          ? resident.archived === true
          : adapter.smsArchivable && smsArchivedIds.has(rowId);
        const unread = resident.unread ?? smsThreadHasUnread(messages, smsOpenedIds);
        const lastOutbound = lastMessage?.direction === "outbound";
        const item: UnifiedInboxListItem = {
          key: unifiedInboxKey("sms", rowId),
          channel: "sms",
          threadId: rowId,
          // Only a resolved address merges. An unknown number carries none, so
          // it stays its own conversation rather than being guessed onto a
          // resident. Shared with the sidebar badge
          // (`communication-active-rows.ts`).
          personKey: smsConversationPersonKey(resident, explicitlyBoundSmsKeys),
          joinKeys: smsConversationJoinKeys(resident),
          personEmail: resident.residentEmail?.trim() || undefined,
          smsBindingKey: resident.conversationKey?.trim() || undefined,
          // Prefer person name / unit / email; fall back to a readable phone.
          name: smsConversationDisplayName(resident),
          subtitle: smsConversationSubtitle(resident) || undefined,
          preview: communicationInboxListPreview(
            lastMessage ? lastMessage.body : "No messages yet",
            listSegment,
            80,
          ),
          previewPrefix: isVoiceCallNoteSid(lastMessage?.messageSid)
            ? voiceCallListPreviewPrefix()
            : lastOutbound && lastMessage
              ? smsOutboundPreviewPrefix(lastMessage)
              : undefined,
          time: lastMessage ? formatInboxListNarrowTime(lastMessage.createdAt) : "",
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
  }, [adapter.smsArchivable, explicitlyBoundSmsKeys, filterContacts, listSegment, smsArchivedIds, smsHiddenIds, smsOpenedIds, smsResidents, threadFilters]);

  const smsListItems = useMemo((): UnifiedInboxListItem[] => {
    const q = query.trim().toLowerCase();
    const items = allSmsItems.filter(({ archived, haystack }) => {
      if (q && !haystack.includes(q)) return false;
      if (listSegment === "archived") return archived;
      // Keep read state out of the canonical eligibility set, matching the
      // email-eligibility filter above — an explicitly opened row must
      // survive being read (see canRetain below).
      if (listSegment === "unread") return !archived;
      return includeArchived || !archived;
    });
    return items.map(({ item }) => item);
  }, [allSmsItems, query, listSegment, includeArchived]);

  const occupiedResidentEmails = useMemo(() => {
    const occupied = new Set<string>();
    for (const row of filteredEmail) {
      // An ARCHIVED email thread still occupies the contact — once a
      // placeholder is archived it becomes a real (trashed) thread, and the
      // placeholder must stop showing on Active rather than existing
      // alongside its own now-real archived conversation.
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

  const listSegmentCounts = useMemo(() => {
    const placeholders = !filterContacts
      ? []
      : buildResidentPlaceholderInboxItems({
          contacts: filterContacts,
          filters: threadFilters ?? { propertyIds: [], roles: [], contactIds: [] },
          occupiedEmails: occupiedResidentEmails,
          searchQuery: "",
          listSegment: "active",
        });
    const pinAssistant = (rows: UnifiedInboxListItem[], segment: InboxListSegment) => {
      if (!assistantThreadId || !viewerId) {
        return pinPropLaneAssistantUnifiedItems(rows, assistantThreadId);
      }
      const live =
        emailThreads.find((thread) => thread.id === assistantThreadId) ??
        buildManagerAssistantPlaceholderThread(viewerId, assistantWorkspace);
      return ensurePinnedManagerAssistantUnifiedItems(
        rows,
        assistantUnifiedListItemFromThread({ ...live, folder: "inbox" }, segment),
      );
    };
    const active = pinAssistant(
      mergeUnifiedInboxItems(
        [
          ...filteredEmail.filter((t) => t.folder !== "trash").map(emailThreadMergeStub),
          ...allSmsItems.filter((row) => !row.archived).map((row) => row.item),
          ...placeholders,
        ],
        listSort,
      ),
      "active",
    );
    // PropLane Assistant never appears on Archived — it cannot be archived
    // away, so it belongs only on Active/Unread (docs/agents/communication-inbox.md).
    const archived = mergeUnifiedInboxItems(
      [
        ...filteredEmail.filter((t) => t.folder === "trash").map(emailThreadMergeStub),
        ...allSmsItems.filter((row) => row.archived).map((row) => row.item),
      ],
      listSort,
    );
    return { active: active.length, archived: archived.length };
  }, [
    allSmsItems,
    assistantThreadId,
    assistantWorkspace,
    emailThreads,
    filterContacts,
    filteredEmail,
    listSort,
    occupiedResidentEmails,
    threadFilters,
    viewerId,
  ]);

  const smsTargets = useMemo(
    () =>
      smsResidents.map((resident) => ({
        conversationId: smsConversationId(resident),
        phone: resident.phone ?? "",
        conversationKey: resident.conversationKey ?? null,
        projectionId: resident.projectionId ?? null,
        stateVersion: resident.stateVersion ?? null,
        archived: resident.archived === true,
      })),
    [smsResidents],
  );

  const mergedRows = useMemo(() => {
    const merged = mergeUnifiedInboxItems(
      [...emailListItems, ...smsListItems, ...placeholderListItems],
      listSort,
    );
    // PropLane Assistant is pinned on Active and Unread — never on Archived,
    // where it cannot be forced back in and is never selectable
    // (docs/agents/communication-inbox.md).
    if (listSegment === "archived") return merged;
    if (!assistantThreadId || !viewerId) {
      return pinPropLaneAssistantUnifiedItems(merged, assistantThreadId);
    }
    const live =
      emailThreads.find((thread) => thread.id === assistantThreadId) ??
      buildManagerAssistantPlaceholderThread(viewerId, assistantWorkspace);
    const item = assistantUnifiedListItemFromThread({ ...live, folder: "inbox" }, listSegment);
    return ensurePinnedManagerAssistantUnifiedItems(merged, item);
  }, [
    assistantThreadId,
    assistantWorkspace,
    emailListItems,
    emailThreads,
    listSegment,
    listSort,
    placeholderListItems,
    smsListItems,
    viewerId,
  ]);

  const beginSmsMutation = useCallback(() => {
    const requestViewer = viewerId;
    const requestWorkspace = workspaceIdentity.id;
    const requestEpoch = viewerEpochRef.current;
    const requestWorkspaceEpoch = smsWorkspaceEpochRef.current;
    const isCurrent = () => currentViewerIdRef.current === requestViewer &&
      currentSmsWorkspaceIdRef.current === requestWorkspace && viewerEpochRef.current === requestEpoch &&
      smsWorkspaceEpochRef.current === requestWorkspaceEpoch;
    return (mutation: import("@/hooks/use-unified-communication-bulk").SmsBulkMutation) => {
    if (!isCurrent()) return;
    for (const id of mutation.deleted) deletedSmsProjectionIdsRef.current.add(id);
    setSmsResidents((current) => {
      if (!isCurrent()) return current;
      return applySmsProjectionListMutation(current, mutation);
    });
    for (const id of adapter.smsDetailPath ? [...new Set(mutation.reconcile)] : []) {
      void fetch(adapter.smsDetailPath!(id), {
        credentials: "same-origin", cache: "no-store",
      }).then(async (response) => {
        if (!isCurrent()) return;
        if (response.status === 403 || response.status === 404) {
          setSmsResidents((current) => isCurrent() ? current.filter((row) => row.projectionId !== id) : current);
          return;
        }
        if (!response.ok) return;
        const detail = await response.json() as { resident?: ManagerSmsResidentConversation };
        if (!isCurrent() || !detail.resident?.projectionId) return;
        setSmsResidents((current) => isCurrent() ? current.map((row) => row.projectionId === id &&
          (row.stateVersion ?? 0) <= (detail.resident?.stateVersion ?? 0) ? { ...row, ...detail.resident } : row) : current);
      }).catch(() => { /* A failed detail read leaves the row for the next retry. */ });
    }
    };
  }, [adapter, viewerId, workspaceIdentity.id]);

  // SSR and the first client paint must agree — local inbox + contact rows load only after mount.
  const listRows = initialListReady
    ? mergedRows.filter((row) => {
        if (statusFilter === "read") return !row.unread;
        if (statusFilter === "unread") return row.unread;
        return true;
      })
    : [];

  const bulk = useUnifiedCommunicationBulk({
    mergedRows,
    listSegment,
    storageKey: adapter.storageKey,
    emailMutations: adapter.emailMutations,
    emailThreads,
    onEmailThreadsChange: setEmailThreads,
    onSmsArchiveChange: () => {
      setSmsArchivedIds(loadManagerSmsArchivedIds());
      adapter.invalidateSmsConversations(viewerId, workspaceIdentity.id);
      void loadSms({ force: true });
    },
    smsTargets,
    onSmsMutationStart: beginSmsMutation,
    assistantPlaceholder: viewerId
      ? buildManagerAssistantPlaceholderThread(viewerId, assistantWorkspace)
      : undefined,
    onSmsDeleted: () => {
      adapter.invalidateSmsConversations(viewerId, workspaceIdentity.id);
      void loadSms({ force: true });
    },
    showToast: appUi?.showToast,
    onSelectionCleared: () => {
      explicitlyOpened.current = null;
      setSelectedKey(null);
      setMobileThreadOpen(false);
      onRouteThreadChange?.(undefined);
      clearCommunicationThreadUrl(threadListHref());
    },
  });

  /**
   * Archive a resident-directory placeholder row (no stored conversation at
   * all) — the row itself carries no persisted identity, so resolve the
   * underlying contact from the directory and create its archived thread
   * (`archivePlaceholderContactThread`). Optimistic: `emailThreads` updates
   * immediately from the function's own optimistic commit; a failure rolls
   * back and toasts, matching every other archive action.
   */
  const handleArchivePlaceholder = useCallback(
    async (threadId: string) => {
      const contactId = parseContactInboxThreadId(threadId);
      const contact = contactId ? filterContacts?.find((c) => c.id === contactId) : undefined;
      if (!contact) return;
      const { ok, next } = await archivePlaceholderContactThread(adapter.storageKey, contact);
      if (!ok) {
        appUi?.showToast("Could not archive conversation.");
        return;
      }
      setEmailThreads(next);
      appUi?.showToast("Archived.");
    },
    [adapter.storageKey, appUi, filterContacts],
  );

  const selection = useMemo(
    () => (initialListReady && selectedKey ? parseUnifiedInboxKey(selectedKey) : null),
    [initialListReady, selectedKey],
  );

  /**
   * The selected row, matched on ANY key it folded in — a merged conversation
   * is reachable by the key of either channel (a deep link minted before the
   * merge still resolves).
   */
  const selectedRow = useMemo(
    () =>
      initialListReady && selectedKey
        ? (mergedRows.find(
            (row) => row.key === selectedKey || (row.memberKeys ?? []).includes(selectedKey),
          ) ?? null)
        : null,
    [initialListReady, mergedRows, selectedKey],
  );

  /**
   * A conversation that spans both channels renders as ONE thread — the direct
   * chat pane, which already speaks email and SMS for a single person — rather
   * than picking one channel's pane and hiding the other half of the history.
   */
  const mergedPersonEmail = useMemo(() => {
    if (!adapter.directChat) return null;
    if (
      !selectedRow ||
      ((selectedRow.channels?.length ?? 1) < 2 && !(selectedRow.smsBindingKeys?.length))
    ) return null;
    return selectedRow.personEmail?.trim() || null;
  }, [adapter.directChat, selectedRow]);
  const placeholderContact = useMemo(() => {
    if (!selection || !filterContacts) return null;
    const contactId = parseContactInboxThreadId(selection.threadId);
    if (!contactId) return null;
    return filterContacts.find((contact) => contact.id === contactId) ?? null;
  }, [filterContacts, selection]);

  const refreshAfterDirectSend = useCallback(() => {
    const requestViewerId = viewerId;
    const requestViewerAuthority = viewerAuthority;
    const isCurrentViewer = () =>
      currentViewerAuthorityRef.current === requestViewerAuthority &&
      currentViewerIdRef.current === requestViewerId;

    // A retained direct-pane callback can outlive its viewer. Reject it before
    // it creates a refresh, so it cannot use its contact or route context for
    // a later A-B-A session with the same viewer id.
    if (!requestViewerId?.trim() || !isCurrentViewer()) return;

    const requestGeneration = ++directSendRefreshGeneration.current;
    const isCurrentRequest = () =>
      isCurrentViewer() && directSendRefreshGeneration.current === requestGeneration;

    let refresher = directSendInboxRefreshersRef.current.get(requestViewerAuthority);
    if (!refresher) {
      refresher = createCoalescedRefresher(() =>
        adapter.syncThreads({ force: true }),
      );
      directSendInboxRefreshersRef.current.set(requestViewerAuthority, refresher);
    }

    void refresher.run(true).then((inbox) => {
      // Status alone is insufficient for A-B-A: a prior A result may be
      // successful for its own cache slot after the retained component has
      // returned to A. Require both the captured viewer authority and this direct
      // refresh generation before changing rows, selection, or the URL.
      if (!isCurrentRequest() || !inbox.ok || inbox.stale) return;
      const rows = inbox.rows;
      setEmailThreads(rows);
      const contact = placeholderContact;
      if (!contact) return;
      const email = contact.email.trim().toLowerCase();
      const collapsed = collapsePersonInboxThreads(filterEmailInboxThreads(rows, { keepSmsLike: true }), {
        mergeFolders: true,
      });
      const thread = collapsed.find((row) => row.email.trim().toLowerCase() === email);
      if (!thread) return;
      const key = unifiedInboxKey("email", thread.id);
      setSelectedKey(key);
      setMobileThreadOpen(true);
      onRouteThreadChange?.(thread.id);
      selectCommunicationThreadUrl(threadDetailHref(thread.id), { replaceExisting: true });
    }).catch(() => {
      // A failed refresh keeps the currently usable list and selected thread.
    });
    if (smsUiEnabled) void loadSms({ force: true });
  }, [adapter, loadSms, onRouteThreadChange, placeholderContact, smsUiEnabled, threadDetailHref, viewerAuthority, viewerId]);

  const pendingThread = Boolean(routeThreadId || selectedKey) && !selectedRow;
  const threadOpen = Boolean(selectedRow) || pendingThread;
  const canDeleteAllArchived =
    listSegment === "archived" &&
    listRows.some((row) => !isAssistantUnifiedInboxRow(row, emailThreads));

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
    if (!initialListReady || !routeThreadId) return;
    const match = listRows.find((r) => r.threadId === routeThreadId || r.aliasThreadIds?.includes(routeThreadId));
    if (match) {
      explicitlyOpened.current = { key: match.key, context: selectionContext };
      setSelectedKey(match.key);
      setMobileThreadOpen(true);
    }
  }, [initialListReady, listRows, routeThreadId, selectionContext]);

  // A routed conversation need not be on the first list page. Resolve it at
  // the authorized detail endpoint and keep the returned summary in the same
  // list model used for ordinary selection.
  useEffect(() => {
    if (!initialListReady || !routeThreadId || listRows.some((row) => row.threadId === routeThreadId || row.aliasThreadIds?.includes(routeThreadId))) {
      setRoutedSmsError(null);
      return;
    }
    // A surface with no per-conversation read cannot resolve a thread that is not in its list.
    if (!adapter.smsDetailPath) {
      setRoutedSmsError("Conversation not found.");
      return;
    }
    const scope = selectionContext;
    const resolved = resolvedSmsRouteRef.current;
    if (resolved?.requested === routeThreadId && resolved.context === scope &&
        listRows.some((row) => row.threadId === resolved.canonical)) return;
    const controller = new AbortController();
    setRoutedSmsError(null);
    void fetch(adapter.smsDetailPath(routeThreadId), {
      credentials: "same-origin", signal: controller.signal, cache: "no-store",
    }).then(async (response) => {
      if (controller.signal.aborted) return;
      if (!response.ok) {
        setRoutedSmsError(response.status === 409
          ? "This older conversation link is ambiguous. Open it from the list."
          : response.status === 404 || response.status === 403
            ? "Conversation not found."
            : "Could not load conversation.");
        return;
      }
      const detail = await response.json() as { resident?: ManagerSmsResidentConversation };
      const resident = detail.resident;
      if (!resident?.projectionId || controller.signal.aborted) {
        if (!controller.signal.aborted) setRoutedSmsError("Conversation not found.");
        return;
      }
      if (selectionContext !== scope) return;
      const canonical = resident.projectionId;
      resolvedSmsRouteRef.current = { requested: routeThreadId, canonical, context: scope };
      setSmsResidents((current) => {
        const byId = new Map(current.map((row) => [smsConversationId(row), row]));
        byId.set(canonical, resident);
        return [...byId.values()];
      });
      setSelectedKey(unifiedInboxKey("sms", canonical));
      setMobileThreadOpen(true);
      if (canonical !== routeThreadId) {
        onRouteThreadChange?.(canonical);
        selectCommunicationThreadUrl(threadDetailHref(canonical), { replaceExisting: true });
      }
    }).catch(() => {
      if (!controller.signal.aborted) setRoutedSmsError("Could not load conversation.");
    });
    return () => controller.abort();
  }, [adapter, initialListReady, listRows, onRouteThreadChange, routeThreadId, selectionContext, threadDetailHref]);

  // Toggling the segment is a different result set — clear search; return to list on phones.
  useEffect(() => {
    setQuery("");
    if (!routeThreadId) {
      explicitlyOpened.current = null;
      setMobileThreadOpen(false);
      if (listSegment === "unread" || !inboxUsesDesktopSplit()) {
        setSelectedKey(null);
      }
    }
  }, [listSegment, routeThreadId]);

  // Decided from THIS render's committed values — `selectedKey` included — and
  // never from inside a `setSelectedKey` updater. An updater runs in the render
  // phase, where React may replay or re-base it (a discrete click's sync update
  // can skip this effect's pending update and then process it later from the
  // older base state). Replaying the clear below wrote `explicitlyOpened = null`
  // out from under the row the manager had just clicked, so reading that row
  // dropped the pane it was opened in. `listRows` is a fresh array every render,
  // so this effect already ran on every render — reading the state directly
  // changes nothing but the consistency of what it reads.
  useEffect(() => {
    if (!initialListReady) return;
    const cur = selectedKey;
    const retained = explicitlyOpened.current;
    const canRetain =
      listSegment === "unread" &&
      cur !== null &&
      retained?.key === cur &&
      retained.context === selectionContext &&
      selectedRow !== null &&
      !selectedRow.unread;
    const next = ((): string | null => {
      if (routeThreadId) {
        const routed = listRows.find((r) => r.threadId === routeThreadId || r.aliasThreadIds?.includes(routeThreadId));
        if (routed) return routed.key;
        const resolved = resolvedSmsRouteRef.current;
        if (resolved?.requested === routeThreadId && resolved.context === selectionContext) {
          const canonical = listRows.find((row) => row.threadId === resolved.canonical);
          if (canonical) return canonical.key;
        }
        // Do not fall through to the first desktop row while the routed thread
        // is still missing — that is the contact-create race.
        if (cur && listRows.some((r) => r.key === cur)) {
          const current = parseUnifiedInboxKey(cur);
          if (current?.threadId === routeThreadId) return cur;
        }
        const current = cur ? parseUnifiedInboxKey(cur) : null;
        if (canRetain && current?.threadId === routeThreadId) return cur;
        return null;
      }
      if (cur && listRows.some((r) => r.key === cur)) return cur;
      if (canRetain) return cur;
      // Studio (C2-CM1): a first visit opens no conversation. The thread side is the "Select a
      // conversation" card until a row is clicked or the URL names a thread — nothing is opened
      // (and marked read) on the manager's behalf.
      return null;
    })();
    // Only a selection that is actually being closed drops its retention. With
    // nothing selected there is nothing to forget, and a retained key is only
    // ever honoured while it equals the selected one.
    if (next === null && cur !== null) explicitlyOpened.current = null;
    if (next !== cur) setSelectedKey(next);
    if (listRows.length === 0 && !routeThreadId) setMobileThreadOpen(false);
  }, [initialListReady, listRows, listSegment, routeThreadId, selectedKey, selectedRow, selectionContext]);

  // Filter, the round + and "Delete all archived" are the page's own tools: they sit on the
  // title row (the shell's slot). With no slot (a test, /demo) they render beside the search.
  const listControls =
    canDeleteAllArchived || listActions || listPrimary ? (
      <div className="flex shrink-0 items-center gap-1 [&_button]:shrink-0 [&_a]:shrink-0" data-attr="communication-list-actions">
        {canDeleteAllArchived ? (
          <PortalIconAction
            icon={Trash2}
            label="Delete all archived"
            tone="danger"
            data-attr="unified-inbox-delete-all-archived"
            onClick={() => void bulk.handleDeleteAllArchived()}
          />
        ) : null}
        {listActions}
        {listPrimary}
      </div>
    ) : null;
  const listControlsPublished = usePublishTitleActions(listControls, listChrome === "internal" && listControls != null);

  const listPane = (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0" data-attr="communication-list-header-card">
        {adapter.identityBoxes}
        {listChrome === "internal" ? (
          <InboxListHeader
            tabs={
              <InboxListSegmentTabs
                commBase={commBase}
                value={listSegmentProp}
                onChange={onArchivedViewChange}
                counts={listSegmentCounts}
                interceptNavigation
                layout="inline"
              />
            }
            search={{
              value: query,
              onChange: setQuery,
              placeholder: "Search communication",
              ariaLabel: "Search contacts or messages",
              dataAttr: "unified-inbox-search",
            }}
            count={initialListReady ? listRows.length : undefined}
            trailing={listControlsPublished ? null : listControls}
          />
        ) : null}
      </div>
      <div className={`${INBOX_LIST_SCROLL} min-h-0 flex-1`} data-communication-inbox-list>
        {!initialListReady ? (
          <CommunicationInboxInitialState
            error={initialListState === "error"}
            onRetry={retryInitialList}
          />
        ) : listRows.length === 0 ? (
          // The one empty card, compact for the list column (PLAN-0914-1629).
          <div className="p-3">
            {query.trim() ? (
              <PortalListEmptyCard
                compact
                tone="muted"
                section="communication"
                workspaceAware
                title={portalEmptyNoMatchTitle("messages", query)}
                clear={{ label: "Clear search", onClick: () => setQuery(""), dataAttr: "unified-inbox-empty-clear-search" }}
                dataAttr="unified-inbox-empty"
              />
            ) : (
              <PortalListEmptyCard
                compact
                section="communication"
                workspaceAware
                title={portalEmptyCopy(`communication.${listSegment ?? "active"}` as PortalEmptyCopyKey).title}
                sibling={listSegment && listSegment !== "active" ? { label: "Active conversations", href: `${commBase}/active`, dataAttr: "unified-inbox-empty-active" } : null}
                actions={
                  (listSegment ?? "active") === "active" && onAddConversation
                    ? [{ label: "New message", icon: MessageSquarePlus, onClick: onAddConversation, dataAttr: "communication-add-conversation" }]
                    : []
                }
                dataAttr="unified-inbox-empty"
              />
            )}
          </div>
        ) : (
          listRows.map((row) => (
            <InboxConversationRow
              key={row.key}
              listVariant="manager"
              appearance="flat"
              trailing={<CommunicationRowActions row={row} bulk={bulk} archived={listSegment === "archived"} emailThreads={emailThreads} manager={adapter.smsArchivable} onArchivePlaceholder={handleArchivePlaceholder} />}
              name={row.name}
              preview={row.preview}
              previewPrefix={row.previewPrefix}
              time={row.time}
              unread={row.unread}
              unreadCount={row.unreadCount}
              selected={selectedKey === row.key}
              onOpen={() => {
                explicitlyOpened.current = { key: row.key, context: selectionContext };
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
        {smsNextCursor ? (
          <div className="flex justify-center border-t border-border px-3 py-3">
            <button
              type="button"
              className="min-h-10 rounded-lg px-3 text-sm font-medium text-primary disabled:opacity-50"
              data-attr="communication-load-more-sms"
              disabled={smsLoadingMore}
              onClick={loadMoreSms}
            >
              {smsLoadingMore ? "Loading…" : "Load more conversations"}
            </button>
            {smsPageError ? <p className="ml-3 self-center text-xs text-danger" role="alert">{smsPageError}</p> : null}
          </div>
        ) : null}
      </div>

    </div>
  );

  const directChatEmail = placeholderContact?.email ?? mergedPersonEmail;
  const selectedReadSources = selectedRow?.readSourcesComplete === true ? selectedRow.readSources ?? [] : [];
  const selectedEmailThreads = useMemo(() => {
    if (!selectedRow) return [];
    const selectedIds = new Set(
      [selectedRow.key, ...(selectedRow.memberKeys ?? [])]
        .map(parseUnifiedInboxKey)
        .filter((key): key is NonNullable<ReturnType<typeof parseUnifiedInboxKey>> => key?.channel === "email")
        .map((key) => key.threadId),
    );
    if (selectedIds.size === 0) return [];
    return emailThreads.filter((thread) =>
      (thread.sourceThreadIds ?? [thread.id]).some((id) => selectedIds.has(id)),
    );
  }, [emailThreads, selectedRow]);
  const selectedSmsResidents = useMemo(() => {
    if (!selectedRow || !directChatEmail) return [];
    const selectedKeys = [selectedRow.key, ...(selectedRow.memberKeys ?? [])];
    const explicitlySelectedNativeIds = selectedKeys
      .map(parseUnifiedInboxKey)
      .filter((key): key is NonNullable<ReturnType<typeof parseUnifiedInboxKey>> => key?.channel === "sms")
      .map((key) => key.threadId);
    const declaredBindingIds = selectedRow.smsBindingKeys ?? [];
    // A declared email binding is the entire native authority for this
    // selection. Do not let a stale pre-collapse member key add an unrelated
    // same-email conversation beside K1/K2.
    const explicitIds = [...new Set((declaredBindingIds.length > 0
      ? declaredBindingIds
      : [...explicitlySelectedNativeIds, selectedRow.smsBindingKey ?? ""]
    ).filter(Boolean))];
    if (explicitIds.length > 0) {
      return smsResidents.filter((resident) => {
        const aliases = [smsConversationId(resident), resident.conversationKey, ...(resident.memberKeys ?? [])]
          .filter((key): key is string => Boolean(key));
        return explicitIds.some((id) => aliases.includes(id) || aliases.includes(unifiedInboxKey("sms", id)));
      });
    }
    const email = directChatEmail.trim().toLowerCase();
    const matches = smsResidents.filter((resident) => resident.residentEmail?.trim().toLowerCase() === email);
    return matches.length === 1 ? matches : [];
  }, [directChatEmail, selectedRow, smsResidents]);
  const selectedRowSmsResidents = useMemo(() => {
    if (!selectedRow) return [];
    const ids = new Set(
      [selectedRow.key, ...(selectedRow.memberKeys ?? [])]
        .map(parseUnifiedInboxKey)
        .filter((key): key is NonNullable<ReturnType<typeof parseUnifiedInboxKey>> => key?.channel === "sms")
        .map((key) => key.threadId),
    );
    if (ids.size === 0) return [];
    return smsResidents.filter((resident) => ids.has(smsConversationId(resident)));
  }, [selectedRow, smsResidents]);
  const selectedProjectionSignature = selectedSmsResidents
    .map((resident) => resident.projectionId).filter(Boolean).sort().join("\0");
  useEffect(() => {
    if (!selectedProjectionSignature || smsListVersion === 0 || !adapter.smsDetailPath) return;
    const controller = new AbortController();
    const scope = selectionContext;
    const requestEpoch = viewerEpochRef.current;
    for (const id of selectedProjectionSignature.split("\0")) {
      void fetch(adapter.smsDetailPath!(id), {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      }).then(async (response) => {
        if (controller.signal.aborted || scope !== selectionContext || viewerEpochRef.current !== requestEpoch) return;
        if (response.ok) {
          const detail = await response.json() as { resident?: ManagerSmsResidentConversation };
          if (controller.signal.aborted || scope !== selectionContext || viewerEpochRef.current !== requestEpoch || !detail.resident?.projectionId) return;
          setSmsResidents((current) => current.map((resident) => resident.projectionId === id &&
            (resident.stateVersion ?? 0) <= (detail.resident?.stateVersion ?? 0)
              ? { ...resident, ...detail.resident } : resident));
          return;
        }
        if (response.status !== 403 && response.status !== 404) return;
        // A refreshed first page may omit this selected row because its grant
        // was revoked, not because pagination displaced it. Reauthorize the
        // selected detail before retaining its old body indefinitely.
        setSmsResidents((current) => current.filter((resident) => resident.projectionId !== id));
        if (routeThreadId === id) setRoutedSmsError("Conversation not found.");
      }).catch(() => { /* A transient read error keeps the last good page. */ });
    }
    return () => controller.abort();
  }, [adapter, routeThreadId, selectedProjectionSignature, selectionContext, smsListVersion]);
  const selectedBindingKeys = (selectedRow?.smsBindingKeys ?? []).filter(Boolean).join("\0");
  useEffect(() => {
    if (!selectedBindingKeys || !adapter.smsDetailPath) return;
    const controller = new AbortController();
    const scope = selectionContext;
    const known = new Set(smsResidents.flatMap((resident) => [smsConversationId(resident), resident.conversationKey, ...(resident.memberKeys ?? [])].filter(Boolean)));
    const missing = selectedBindingKeys.split("\0").filter((key) => !known.has(key));
    if (!missing.length) return;
    void Promise.all(missing.map(async (key) => {
      const response = await fetch(adapter.smsDetailPath!(key), { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (!response.ok) return null;
      const detail = await response.json() as { resident?: ManagerSmsResidentConversation };
      return detail.resident?.projectionId ? detail.resident : null;
    })).then((residents) => {
      if (controller.signal.aborted || scope !== selectionContext) return;
      setSmsResidents((current) => {
        const byId = new Map(current.map((resident) => [smsConversationId(resident), resident]));
        for (const resident of residents) if (resident) byId.set(resident.projectionId!, resident);
        return [...byId.values()];
      });
    }).catch(() => { /* Keep the bound email conversation; no guessed phone fallback. */ });
    return () => controller.abort();
  }, [adapter, selectedBindingKeys, selectionContext]);
  const AdapterThreadPane = adapter.ThreadPane;
  const pendingReadSignaturesRef = useRef(new Map<string, symbol>());
  const renderedViewerAuthority = viewerAuthority;
  const markSelectedRead = useCallback((sources: { id: string; observation: string; unread?: boolean }[]) => {
    if (document.visibilityState === "hidden") return { kind: "deferred" as const };
    if (currentViewerAuthorityRef.current !== renderedViewerAuthority) return { kind: "deferred" as const };
    const inboundSmsIds = selectedSmsResidents.filter((resident) => !resident.projectionId).flatMap((resident) =>
      (resident.messages ?? []).filter((message) => message.direction === "inbound").map((message) => message.id),
    );
    const requestEpoch = viewerEpochRef.current;
    const applyUnread = (
      unreadById: Map<string, boolean>,
      operation?: { token: string; phase: "optimistic" | "settled" },
    ) => {
      if (viewerEpochRef.current !== requestEpoch || currentViewerIdRef.current !== viewerId) return;
      const current = adapter.loadCachedThreads();
      const next = reconcileObservedInboxReadRows(current, sources, unreadById, operation);
      if (next.some((thread, index) => thread !== current[index])) {
        adapter.stageThreads(next);
        setEmailThreads(next);
      }
    };
    return startObservedInboxReadOperation({
      viewerKey: renderedViewerAuthority.viewerId ?? "anon",
      epoch: requestEpoch,
      sources,
      nativeMessageIds: inboundSmsIds,
      pending: pendingReadSignaturesRef.current,
      isCurrent: () =>
        viewerEpochRef.current === requestEpoch &&
        currentViewerIdRef.current === viewerId &&
        currentViewerAuthorityRef.current === renderedViewerAuthority,
      markNativeRead: () => {
        try {
          const next = markManagerSmsOpenedIds(viewerId, inboundSmsIds, smsOpenedIdsRef.current);
          smsOpenedIdsRef.current = next;
          setSmsOpenedIds((current) => sameStringSet(current, next) ? current : next);
        } catch (error) {
          // A failed device write is a volatile receipt only. It clears the
          // visible dot for this mounted pane but is deliberately retried on a
          // later explicit reopen after storage recovers.
          const next = new Set([...smsOpenedIdsRef.current, ...inboundSmsIds]);
          smsOpenedIdsRef.current = next;
          setSmsOpenedIds((current) => sameStringSet(current, next) ? current : next);
          throw error;
        }
      },
      applyUnread,
      post: (nextSources) => markPersistedInboxSourcesRead(adapter.storageKey, nextSources),
      notifyFailure: () => {
        if (currentViewerAuthorityRef.current === renderedViewerAuthority) {
          appUi?.showToast("Could not mark conversation as read. Reopen it to retry.");
        }
      },
    });
  }, [adapter, appUi, renderedViewerAuthority, selectedSmsResidents, viewerId]);
  const threadPane = pendingThread ? (
    routedSmsError ? <InboxThreadEmpty title={routedSmsError} /> : <InboxThreadSkeleton />
  ) : AdapterThreadPane && selection ? (
    <AdapterThreadPane
      selection={selection}
      selectedRow={selectedRow}
      emailThreads={selectedEmailThreads}
      smsResidents={selectedRowSmsResidents}
      listSegment={listSegment}
      smsUiEnabled={smsUiEnabled}
      closeThread={closeActiveThread}
      archive={async () => {
        if (!selectedRow) return;
        await bulk.handleArchiveKeys([...new Set([selectedRow.key, ...(selectedRow.memberKeys ?? [])])]);
        closeActiveThread();
      }}
      restore={async () => {
        if (!selectedRow) return;
        await bulk.handleRestore([...new Set([selectedRow.key, ...(selectedRow.memberKeys ?? [])])]);
        closeActiveThread();
      }}
      deleteForever={async () => {
        if (!selectedRow) return;
        await bulk.handleDelete([...new Set([selectedRow.key, ...(selectedRow.memberKeys ?? [])])]);
        closeActiveThread();
      }}
      reloadThreads={async () => {
        const result = await adapter.syncThreads({ force: true });
        if (result.ok && !result.stale) setEmailThreads(result.rows);
      }}
      onSmsProjectionStateChanged={handleSmsProjectionStateChanged}
      onSmsConversationOpened={handleSmsConversationOpened}
    />
  ) : directChatEmail ? (
    <ResidentDirectChatPane
      key={`${viewerId}:${workspaceIdentity.id}:${selectedRow?.key ?? ""}`}
      residentEmail={directChatEmail}
      residentName={placeholderContact?.name ?? selectedRow?.name}
      propertyLabel={selectedRow?.address}
      onRestore={selectedRow && listSegment === "archived" ? async () => {
        const keys = [...new Set([selectedRow.key, ...(selectedRow.memberKeys ?? [])])];
        await bulk.handleRestore(keys);
        closeActiveThread();
      } : undefined}
      smsResident={selectedSmsResidents[0] ?? null}
      smsResidents={selectedSmsResidents}
      smsUiEnabled={smsUiEnabled}
      onSent={refreshAfterDirectSend}
      readSources={selectedReadSources}
      emailThreadSnapshot={selectedEmailThreads}
      onViewed={markSelectedRead}
      onProjectionStateChanged={handleSmsProjectionStateChanged}
      projectionScope={`${viewerId}:${workspaceIdentity.id}:${selectedRow?.key ?? ""}`}
      viewActive={mobileThreadOpen || (isClient && inboxUsesDesktopSplit())}
      /*
       * Archive and delete act on THIS conversation, which may be several
       * stored threads folded into one person. Reusing the bulk handlers keyed
       * to the open row's key is what makes that true — and it is now the only
       * entry to those actions from the list, since the per-row checkbox went.
       */
      onArchive={
        selectedRow
          ? async () => {
              const keys = [...new Set([selectedRow.key, ...(selectedRow.memberKeys ?? [])])];
              await bulk.handleArchiveKeys(keys);
              closeActiveThread();
            }
          : undefined
      }
      onDelete={
        selectedRow && listSegment === "archived" && !isAssistantUnifiedInboxRow(selectedRow, emailThreads)
          ? async () => {
              await bulk.handleDelete([...new Set([selectedRow.key, ...(selectedRow.memberKeys ?? [])])]);
              closeActiveThread();
            }
          : selectedRow && isAssistantUnifiedInboxRow(selectedRow, emailThreads)
            ? async () => {
                await bulk.handleClearAssistant(selectedRow);
              }
            : undefined
      }
      onBack={closeActiveThread}
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
        onClearAssistant={
          selectedRow && isAssistantUnifiedInboxRow(selectedRow, emailThreads)
            ? async () => {
                await bulk.handleClearAssistant(selectedRow);
              }
            : undefined
        }
        controlledExpandedId={selection.threadId}
        onControlledExpandedIdChange={(id) => {
          if (!id) {
            closeActiveThread();
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
        smsUiEnabled={smsUiEnabled}
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
        onProjectionStateChanged={handleSmsProjectionStateChanged}
        onProjectionMutationStart={beginSmsMutation}
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
        hint=""
      />
    );

  // The right-hand contact column restates what the open conversation already carries; it
  // fetches nothing (scheduled sends come from the thread pane's own load).
  const contactDetails = useMemo((): CommunicationDetails | null => {
    if (!selectedRow && !placeholderContact) return null;
    if (selectedRow && isAssistantUnifiedInboxRow(selectedRow, emailThreads)) return null;
    const email = (placeholderContact?.email ?? selectedRow?.personEmail ?? "").trim();
    const contact =
      placeholderContact ??
      (email ? filterContacts?.find((c) => c.email?.trim().toLowerCase() === email.toLowerCase()) ?? null : null);
    const sms = selectedSmsResidents[0] ?? null;
    const name = (placeholderContact?.name ?? selectedRow?.name ?? "").trim();
    if (!name) return null;
    const role = (() => {
      if (contact?.role === "resident") {
        return contact.tenancyStatus === "applicant" ? "Applicant" : contact.tenancyStatus === "past" ? "Past resident" : "Resident";
      }
      if (contact?.role === "vendor") return "Vendor";
      if (contact?.role === "manager") return "Manager";
      return sms?.counterpartyRole ? counterpartyRoleLabel(sms.counterpartyRole) : undefined;
    })();
    const place = selectedRow?.address || contact?.propertyLabel || sms?.propertyLabel || "";
    const phone = formatSmsPhoneLabel(sms?.phone ?? contact?.phone ?? null);
    const records: CommunicationDetailsRecord[] = [];
    const ref = selectedRow?.recordRef;
    if (ref) {
      records.push({
        key: `ref-${ref.kind}-${ref.id}`,
        label: ref.label,
        detail: place || undefined,
        href: recordRoutePath("manager", ref.kind, ref.id),
      });
    }
    if (contact?.propertyId && contact.propertyLabel && !(ref?.kind === "property" && ref.id === contact.propertyId)) {
      records.push({
        key: `property-${contact.propertyId}`,
        label: contact.propertyLabel,
        detail: contact.roomLabel || undefined,
        href: recordRoutePath("manager", "property", contact.propertyId),
      });
    }
    return { name, role, phone, email: email || null, records };
  }, [emailThreads, filterContacts, placeholderContact, selectedRow, selectedSmsResidents]);

  return (
    <>
      <InboxTwoPane
        panes="flat"
        details={contactDetails ? <CommunicationDetailsPane details={contactDetails} /> : undefined}
        heightMode="viewport"
        fillViewport={threadOpen}
        fillParent
        mobileCompact
        className="min-h-0 flex-1"
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
