"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommunicationStatusFilterDraft, type CommunicationStatus } from "@/components/portal/communication-status-filter";

import { CommunicationRowActions } from "@/components/portal/communication-row-actions";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { useUnifiedCommunicationBulk } from "@/hooks/use-unified-communication-bulk";
import { House, PenSquare, ShieldCheck, Smartphone, Users } from "lucide-react";
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
  retryWhileStale,
  syncPersistedInboxFromServerWithStatus,
} from "@/lib/portal-inbox-storage";
import { buildActiveCommunicationThreads, emailThreadJoinKeys } from "@/lib/communication-active-rows";
import {
  assistantUnifiedListItemFromThread,
  communicationInboxListPreview,
  propLaneAssistantThreadIdForPortal,
  resolveCommunicationViewerId,
} from "@/lib/communication-assistant-inbox-list";
import { useAssistantConversationIfMounted } from "@/lib/axis-assistant/assistant-conversation-context";
import { AxisAssistantChatIcon } from "@/components/portal/assistant-shared";
import { ResidentAssistantThread } from "@/components/portal/resident-assistant-thread";
import {
  PROPLANE_AGENT_NAME,
  isHouseStarterId,
  isResidentPropLaneAgentThread,
  orderResidentConversationRows,
  residentConversationLabel,
  residentConversationKind,
  residentHouseStarters,
  residentHouseWorkPhone,
  type ResidentConversationKind,
} from "@/lib/communication/resident-conversation-names";
import { usePortalSession } from "@/hooks/use-portal-session";
import { useResidentManagerContacts } from "@/hooks/use-resident-manager-contacts";
import {
  inboxThreadCategoryLabel,
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
import { formatInboxStamp, type PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { isHouseThreadId } from "@/lib/house-thread-id";
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
  // The PropLane agent is ONE conversation per resident: the row pinned here, the top bar's side panel / phone sheet,
  // the dashboard's Ask card and the phone's Ask tab all read this same provider state (`/api/agent/resident-chat`,
  // id `resident-agent-<uid>`). No provider (the demo, a "View as" session) means no pinned row.
  const assistantConversation = useAssistantConversationIfMounted();
  const assistantAvailable = assistantConversation !== null;
  const assistantId = viewerId ? propLaneAssistantThreadIdForPortal("resident", viewerId) : null;
  const hydrateAssistantRef = useRef(assistantConversation?.hydrateArchive);
  useEffect(() => {
    hydrateAssistantRef.current = assistantConversation?.hydrateArchive;
  });
  // Opening Communication restores the latest saved conversation, so the pinned row previews what the resident
  // last said to PropLane from any door, not an empty placeholder.
  useEffect(() => {
    void hydrateAssistantRef.current?.();
  }, [assistantAvailable]);
  const assistantMessages = assistantConversation?.messages;
  const assistantLastTurn = useMemo(() => {
    const visible = (assistantMessages ?? []).filter((m) => m.content.trim().length > 0);
    return visible[visible.length - 1] ?? null;
  }, [assistantMessages]);
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
      retryWhileStale(() => syncPersistedInboxFromServerWithStatus(RESIDENT_INBOX_STORAGE_KEY)),
      smsUiEnabled ? loadResidentSms(requestGeneration) : Promise.resolve(true),
    ]);
    if (requestGeneration !== initialLoadGeneration.current) return;
    // Still stale after the retries: surface the Retry state rather than a skeleton that never resolves.
    if (inbox.stale) {
      setInitialListState("error");
      return;
    }
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
    // A list scoped to one record (or an "About" kind) is not the place for the agent: it has no record.
    if (!threadFilters) return assistantAvailable ? rows : rows.filter((t) => !isResidentPropLaneAgentThread(t));
    return rows
      .filter((t) => !isResidentPropLaneAgentThread(t))
      .filter((t) =>
        threadPassesCommunicationFilters({ filters: threadFilters, contacts: [], counterpartyEmail: t.email, recordRef: t.recordRef }),
      );
  }, [assistantAvailable, emailThreads, smsUiEnabled, threadFilters, viewerId]);

  /** What each stored row IS (agent, house chat, my number, house), read once per list. */
  const rowKinds = useMemo(
    () => new Map<string, ResidentConversationKind>(filteredEmail.map((t) => [t.id, residentConversationKind(t)])),
    [filteredEmail],
  );
  const kindOfRow = useCallback(
    (row: { threadId: string }): ResidentConversationKind =>
      isHouseStarterId(row.threadId) ? "house" : rowKinds.get(row.threadId) ?? (isHouseThreadId(row.threadId) ? "house_chat" : "house"),
    [rowKinds],
  );

  // Houses with no conversation yet: the list offers each one as a place to start (the existing New message path).
  const houseStarters = useMemo(() => {
    const covered = filteredEmail
      .filter((t) => t.folder !== "trash" && residentConversationKind(t) === "house")
      .map((t) => resolveResidentThreadManager(t, managerContacts).homeLabel)
      .filter((label): label is string => Boolean(label));
    return residentHouseStarters(managerContacts, filteredEmail, covered);
  }, [filteredEmail, managerContacts]);
  const workPhoneByThreadId = useMemo(() => {
    const byId = new Map<string, string>();
    for (const t of filteredEmail) {
      if (residentConversationKind(t) !== "house") continue;
      const phone = residentHouseWorkPhone(t, managerContacts);
      if (phone) byId.set(t.id, phone);
    }
    return byId;
  }, [filteredEmail, managerContacts]);

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
          const label = residentConversationLabel(t, manager, managerContacts);
          const hay = [label.title, t.from, manager.name, manager.workspaceName, manager.homeLabel, t.email, t.subject, t.body, t.preview]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        });
      }

      const emailItems = rows.map((t): UnifiedInboxListItem => {
        const msgs = inboxThreadMessages(t);
        const lastMsg = msgs[msgs.length - 1];
        // Every row is NAMED by what it is: "PropLane" for the agent, the house for a manager / work-number
        // conversation, "My PropLane agent" for the resident's own number. Never a phone number.
        const manager = resolveResidentThreadManager(t, managerContacts);
        const label = residentConversationLabel(t, manager, managerContacts);
        if (label.kind === "proplane_agent") {
          // The agent row shows the latest turn of the shared conversation (the one the top bar types into).
          const base = assistantUnifiedListItemFromThread(t, segment);
          return {
            ...base,
            name: PROPLANE_AGENT_NAME,
            subtitle: undefined,
            ...(assistantLastTurn
              ? {
                  preview: communicationInboxListPreview(assistantLastTurn.content, segment, 160),
                  previewPrefix: assistantLastTurn.role === "user" ? "You: " : undefined,
                }
              : {}),
          };
        }
        // The house chat is its own row, with no manager workspace to join or fold into.
        if (label.kind === "house_chat") {
          return {
            key: unifiedInboxKey("email", t.id),
            channel: "email" as const,
            threadId: t.id,
            name: label.title,
            preview: communicationInboxListPreview(lastMsg?.body ?? t.preview ?? "", segment, 80),
            previewPrefix: inboxThreadLastTurnDirection(t) === "outbound" ? "You: " : undefined,
            time: t.time,
            unread: t.folder === "inbox" && t.unread,
            sortMs: inboxThreadSortMs(t.id, t.time),
          };
        }
        return {
          key: unifiedInboxKey("email", t.id),
          channel: "email" as const,
          threadId: t.id,
          name: label.title,
          subtitle: t.subject,
          // The manager (or the texter, for the resident's own number): a plain line under the preview.
          ...(label.withName ? { placeLine: label.withName } : {}),
          preview: communicationInboxListPreview(lastMsg?.body ?? t.preview ?? "", segment, 80),
          previewPrefix: inboxThreadLastTurnDirection(t) === "outbound" ? "You: " : undefined,
          time: t.time,
          unread: t.folder === "inbox" && t.unread,
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
      const visibleEmailItems = segment === "unread" ? emailItems.filter((item) => item.unread) : emailItems;
      // House chats sit together near the top and never take part in the one-workspace text fold.
      const houseItems = visibleEmailItems.filter((item) => isHouseThreadId(item.threadId));
      const filteredEmailItems = visibleEmailItems.filter((item) => !isHouseThreadId(item.threadId));

      let smsItems: UnifiedInboxListItem[] = [];
      if (smsUiEnabled && segment !== "archived" && smsMessages.length > 0) {
        const matches =
          !q || smsMessages.some((m) => m.body.toLowerCase().includes(q)) || "text messages".includes(q);
        if (matches) {
          const last = [...smsMessages].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]!;
          const unread = smsMessages.some((m) => m.direction === "inbound" && smsMessageBucket(m, smsOpened) === "unopened");
          if (segment !== "unread" || unread) {
            // A text row that folds into the one workspace row is titled like it; a stray one is the texts, not a number.
            const houseRowNames = new Set(
              filteredEmailItems.filter((item) => (item.joinKeys?.length ?? 0) > 0).map((item) => item.name),
            );
            const smsName = houseRowNames.size === 1 ? [...houseRowNames][0]! : "Text messages";
            smsItems = [
              {
                key: unifiedInboxKey("sms", SMS_THREAD_ID),
                channel: "sms",
                threadId: SMS_THREAD_ID,
                name: smsName,
                subtitle: "Property manager",
                preview: communicationInboxListPreview(last.body, segment, 80),
                previewPrefix: last.direction === "outbound" ? "You: " : undefined,
                time: formatInboxStamp(new Date(last.createdAt)),
                unread,
                sortMs: Date.parse(last.createdAt) || 0,
              },
            ];
          }
        }
      }

      // The PropLane agent first, always; then the house chats; then every house conversation by recency.
      const ordered = orderResidentConversationRows(
        [
          ...mergeUnifiedInboxItems(houseItems, "recent"),
          ...mergeUnifiedInboxItems(
            [...filteredEmailItems, ...foldTextRowIntoSoleWorkspace(filteredEmailItems, smsItems)],
            "recent",
          ),
        ],
        (row) => (row.threadId === assistantId ? "proplane_agent" : kindOfRow(row)),
      );

      // A house with no conversation yet is offered last, only on Active and never inside a record-scoped list.
      const starterItems: UnifiedInboxListItem[] =
        segment === "active" && !threadFilters
          ? houseStarters
              .filter((starter) => !q || [starter.houseLabel, starter.managerName].filter(Boolean).join(" ").toLowerCase().includes(q))
              .map((starter) => ({
                key: unifiedInboxKey("email", starter.id),
                channel: "email" as const,
                threadId: starter.id,
                name: starter.houseLabel,
                ...(starter.managerName ? { placeLine: starter.managerName } : {}),
                preview: "No messages yet.",
                time: "",
                unread: false,
                sortMs: 0,
              }))
          : [];
      return [...ordered, ...starterItems];
    },
    [assistantId, assistantLastTurn, filteredEmail, houseStarters, kindOfRow, managerContacts, smsMessages, smsOpened, smsUiEnabled, threadFilters],
  );

  const merged = useMemo(
    () => rowsForSegment(listSegment, query, includeArchived).filter((row) => !readOnly || !row.unread),
    [includeArchived, listSegment, query, readOnly, rowsForSegment],
  );

  // The tabs' counts are the conversations each tab would list, search aside.
  const tabCounts = useMemo(
    () => ({
      // A "start a conversation" row for a house is an offer, not a conversation: it is not counted.
      active: rowsForSegment("active", "", false).filter((row) => !isHouseStarterId(row.threadId)).length,
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
      // By default the desktop opens the first CONVERSATION, which is the PropLane agent: a chat is always there.
      const firstConversation = merged.find((row) => !isHouseStarterId(row.threadId));
      if (inboxUsesDesktopSplit() && firstConversation) return firstConversation.key;
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

  // Start the conversation about a house through the one New message path (authorize, then append): the manager reads
  // it in the same conversation as this resident's texts.
  const startConversationAboutHouse = (starterId: string) => {
    const target = houseStarters.find((entry) => entry.id === starterId);
    if (!target) return;
    inboxRef.current?.openCompose({
      subject: `Question about ${target.houseLabel}`,
      body: "",
      recipientEmail: target.email,
    });
  };

  const listPane = (
    <div className="flex h-full min-h-0 flex-1 flex-col min-w-0 overflow-clip">
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
        count={initialListReady ? merged.filter((row) => !isHouseStarterId(row.threadId)).length : undefined}
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
          merged.map((row) => {
            const kind = kindOfRow(row);
            const starter = isHouseStarterId(row.threadId);
            const isAgent = row.threadId === assistantId;
            return (
              <InboxConversationRow
                key={row.key}
                appearance="messages"
                avatarShape={isAgent || kind === "my_agent" ? "circle" : "tile"}
                avatar={
                  isAgent ? (
                    <AxisAssistantChatIcon className="size-6" />
                  ) : kind === "my_agent" ? (
                    <Smartphone className="size-6" aria-hidden />
                  ) : kind === "house_chat" ? (
                    <Users className="size-6" aria-hidden />
                  ) : (
                    <House className="size-6" aria-hidden />
                  )
                }
                // A text-only conversation is derived, read-only: nothing to archive. The agent cannot be archived
                // away and a house still to be started has nothing to archive.
                trailing={
                  isAgent || starter || emailThreads.find((t) => t.id === row.threadId)?.smsOnly ? undefined : (
                    <CommunicationRowActions row={row} bulk={bulk} archived={listSegment === "archived"} emailThreads={emailThreads} />
                  )
                }
                name={row.name}
                subtitle={row.subtitle}
                placeLine={row.placeLine}
                preview={row.preview}
                previewPrefix={row.previewPrefix}
                time={row.time}
                unread={row.unread}
                category={row.category}
                recordChip={
                  row.recordRef
                    ? { label: row.recordRef.label, href: recordRoutePath("resident", row.recordRef.kind, row.recordRef.id) }
                    : undefined
                }
                selected={!starter && selectedKey === row.key}
                onOpen={() => {
                  if (starter) {
                    startConversationAboutHouse(row.threadId);
                    return;
                  }
                  setSelectedKey(row.key);
                  onRouteThreadChange?.(row.threadId);
                  const href = `${commBase}/${listSegment}/${encodeURIComponent(row.threadId)}`;
                  if (routeThreadId !== row.threadId) {
                    selectCommunicationThreadUrl(href, { replaceExisting: Boolean(routeThreadId) });
                  }
                }}
              />
            );
          })
        )}
      </div>
    </div>
  );

  const selectedRow = useMemo(
    () => (selectedKey ? merged.find((row) => row.key === selectedKey || (row.memberKeys ?? []).includes(selectedKey)) ?? null : null),
    [merged, selectedKey],
  );
  const contactDetails = useMemo(() => {
    if (!selectedRow) return null;
    // The house's work number, copyable here and in the thread header; never the row's title.
    const members = [selectedRow.key, ...(selectedRow.memberKeys ?? [])];
    const workPhone = members
      .map((key) => parseUnifiedInboxKey(key))
      .map((parsed) => (parsed ? workPhoneByThreadId.get(parsed.threadId) : undefined))
      .find(Boolean);
    return communicationDetailsFromRow({ ...selectedRow, ...(workPhone ? { workPhone } : {}) }, (kind, id) =>
      recordRoutePath("resident", kind as RecordKind, id),
    );
  }, [selectedRow, workPhoneByThreadId]);

  const smsSelected = selection?.channel === "sms";
  // The pinned PropLane row opens the SHARED assistant conversation, not a stored inbox thread: what a resident
  // types here is what the top bar's panel shows, and the other way round.
  const assistantSelected = Boolean(
    assistantAvailable && assistantId && selection?.channel === "email" && selection.threadId === assistantId,
  );
  const threadPane = (
    <>
      {assistantSelected ? (
        <div className="flex min-h-0 flex-1 flex-col" data-attr="resident-assistant-thread">
          <ResidentAssistantThread
            // The desktop split always has an open conversation, so there is nothing to close to there.
            onClose={
              inboxUsesDesktopSplit()
                ? undefined
                : () => {
                    setSelectedKey(null);
                    onRouteThreadChange?.(undefined);
                    clearCommunicationThreadUrl(`${commBase}/${listSegment}`);
                  }
            }
          />
        </div>
      ) : null}
      {smsSelected ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
          <RoleSmsPanel apiPath="/api/resident/sms-conversations" storageScope="resident" tabId={"all" as ManagerSmsBucketId} />
        </div>
      ) : null}
      {/* Inline display: the thread pane's own `> div` rule would otherwise win over the `hidden` class and
          leave the email pane's "Select a conversation" under an open text thread. */}
      <div
        className="flex min-h-0 flex-1 flex-col"
        style={smsSelected || assistantSelected ? { display: "none" } : undefined}
        aria-hidden={smsSelected || assistantSelected || undefined}
      >
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
