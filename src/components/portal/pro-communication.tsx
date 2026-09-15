"use client";
import { loadManagerSmsConversationsClient } from "@/lib/manager-sms-conversations-client";

import { PenSquare, Settings2 } from "lucide-react";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { CommunicationFilterSortFields } from "@/components/portal/communication-filter-sort-fields";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";
import { type ManagerInboxHandle } from "@/components/portal/pro-inbox";
import { type ManagerSmsPanelHandle } from "@/components/portal/pro-sms-panel";
import {
  ManagerCommunicationComposeModal,
  type CommunicationComposeChannel,
} from "@/components/portal/pro-communication-compose-modal";
import { ManagerWorkNumberButton } from "@/components/portal/pro-work-number-button";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { getSettingsEntryPoint, settingsDialogTitlePrefix } from "@/components/portal/settings-entry-points";
import {
  axisAdminFilterContact,
  EMPTY_COMMUNICATION_THREAD_FILTERS,
  roleLabel,
  type CommunicationFilterRole,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import { buildManagerInboxLiveContacts } from "@/lib/manager-inbox-contacts";
import {
  buildManagerPropertyFilterOptions,
  MANAGER_PORTFOLIO_REFRESH_EVENTS,
} from "@/lib/manager-portfolio-access";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/demo-property-pipeline";
import { MANAGER_APPLICATIONS_EVENT } from "@/lib/manager-applications-storage";
import type { CommunicationListSort } from "@/lib/unified-inbox-merge";
import {
  normalizeManagerSmsConversationsPayload,
  type ManagerSmsResidentConversation,
} from "@/lib/manager-sms-messages";
import { useCommunicationThreadId } from "@/hooks/use-communication-thread-id";
import { selectCommunicationThreadUrl } from "@/lib/portal-communication-nav";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { consumeManagerComposePrefill, type ManagerComposePrefill } from "@/lib/manager-compose-prefill";
import { loadManagerMessagingNumberStatusClient } from "@/lib/sms/manager-messaging-number-client";

export type ManagerInboxTabId = "unopened" | "opened" | "schedule" | "sent" | "trash";
/** @deprecated Legacy SMS routes redirect to unified inbox. */
export type ManagerCommunicationChannel = "inbox" | "sms";
/** @deprecated Legacy SMS folder URLs redirect to unified inbox. */
export type ManagerSmsTabId = "all" | "unopened" | "opened" | "schedule" | "sent";

const communicationSettingsEntry = getSettingsEntryPoint("communication");

const ROLE_OPTIONS: { value: CommunicationFilterRole; label: string }[] = [
  { value: "resident", label: "Residents & applicants" },
  { value: "management", label: roleLabel("management") },
  { value: "admin", label: roleLabel("admin") },
  { value: "vendor", label: roleLabel("vendor") },
];

export function communicationFilterTouches(
  filters: CommunicationThreadFilters,
  listSort: CommunicationListSort,
): number {
  let n = filters.status && filters.status !== "active" ? 1 : 0;
  if (filters.propertyIds.length > 0) n += 1;
  if (filters.roles.length > 0) n += 1;
  if (filters.contactIds.length > 0) n += 1;
  if (listSort !== "recent") n += 1;
  return n;
}

export function ManagerCommunication({
  listSegment = "active",
  threadId,
  inboxTabId = "unopened",
  smsUiEnabled = false,
}: {
  /** Routed conversation list segment (Active / Unread / Archived). */
  listSegment?: "active" | "unread" | "archived";
  /** Deep-linked thread id from `/communication/{segment}/{threadId}`. */
  threadId?: string;
  /** @deprecated Channel is always unified; kept for route compatibility. */
  channel?: ManagerCommunicationChannel;
  /** @deprecated Folder tabs removed — kept so legacy routes still resolve. */
  inboxTabId?: ManagerInboxTabId;
  /** @deprecated SMS folders merged into unified inbox. */
  smsTabId?: ManagerSmsTabId;
  /**
   * Server-resolved SMS Communication UI flag (`isSmsCommUiEnabled()`). When
   * false, SMS compose channel / rows / panel are hidden — transport, webhooks,
   * and both SMS agents are unaffected. Default false ("hide now").
   */
  smsUiEnabled?: boolean;
}) {
  const portalBase = usePaidPortalBasePath();
  const commBase = `${portalBase}/communication`;
  const { userId, ready: sessionReady } = useManagerUserId();
  const { activeThreadId, setActiveThreadId } = useCommunicationThreadId(commBase, threadId);
  const inboxRef = useRef<ManagerInboxHandle>(null);
  const smsRef = useRef<ManagerSmsPanelHandle>(null);
  const [filters, setFilters] = useState<CommunicationThreadFilters>({ ...EMPTY_COMMUNICATION_THREAD_FILTERS, status: listSegment });
  useEffect(() => { setFilters((current) => ({ ...current, status: listSegment })); }, [listSegment]);
  const [listSort, setListSort] = useState<CommunicationListSort>("recent");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeChannel, setComposeChannel] = useState<CommunicationComposeChannel>("email");
  const [composeDraft, setComposeDraft] = useState<ManagerComposePrefill | null>(null);
  const [communicationSettingsOpen, setCommunicationSettingsOpen] = useState(false);
  const [smsDirectory, setSmsDirectory] = useState<{ viewer: string | null; rows: ManagerSmsResidentConversation[] }>({ viewer: null, rows: [] });
  const smsRecipients = smsDirectory.viewer === userId ? smsDirectory.rows : [];
  const [smsCanSend, setSmsCanSend] = useState(false);
  const smsOutboundEnabled = smsUiEnabled || smsCanSend;
  const [threadOpen, setThreadOpen] = useState(Boolean(threadId));
  const [threadSelected, setThreadSelected] = useState(Boolean(threadId));
  const [propertyTick, setPropertyTick] = useState(0);
  const refreshDirectory = useCallback(() => setPropertyTick((n) => n + 1), []);

  // Rebuilt on every portfolio / applications event (`propertyTick`): the
  // directory is read from the applications cache, which is usually still
  // syncing when this mounts, and a list built once from an empty cache left
  // every thread header without its person — no role, house, room or phone.
  const filterContacts = useMemo(() => {
    void propertyTick;
    const live = buildManagerInboxLiveContacts(userId);
    return [axisAdminFilterContact(), ...live];
  }, [userId, propertyTick]);

  const liveContacts = useMemo(() => {
    void propertyTick;
    return buildManagerInboxLiveContacts(userId);
  }, [userId, propertyTick]);

  useEffect(() => {
    const events = [...MANAGER_PORTFOLIO_REFRESH_EVENTS, PROPERTY_PIPELINE_EVENT, MANAGER_APPLICATIONS_EVENT];
    for (const eventName of events) window.addEventListener(eventName, refreshDirectory);
    return () => {
      for (const eventName of events) window.removeEventListener(eventName, refreshDirectory);
    };
  }, [refreshDirectory]);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId).map((option) => ({ value: option.id, label: option.label })),
    [userId, propertyTick],
  );

  const smsRecipientViewer = useRef(userId);
  const smsRecipientEpoch = useRef(0);
  useLayoutEffect(() => {
    smsRecipientViewer.current = userId;
    smsRecipientEpoch.current += 1;
  }, [userId]);
  const loadSmsRecipients = useCallback(async () => {
    // Load conversation directory when SMS UI is on OR the work number can send
    // (inbox replies to inbound texts need rows even while the SMS panel is hidden).
    if (!sessionReady || !userId || !smsOutboundEnabled) return;
    const requestEpoch = smsRecipientEpoch.current;
    try {
      const res = await loadManagerSmsConversationsClient(userId);
      if (!res.ok) return;
      const body = (await res.json()) as { residents?: ManagerSmsResidentConversation[] };
      const normalized = normalizeManagerSmsConversationsPayload(body);
      if (smsRecipientViewer.current === userId && smsRecipientEpoch.current === requestEpoch) {
        setSmsDirectory({ viewer: userId, rows: normalized.residents });
      }
    } catch {
      /* keep prior list */
    }
  }, [sessionReady, smsOutboundEnabled, userId]);

  useEffect(() => {
    if (!sessionReady || !userId) return;
    let cancelled = false;
    void loadManagerMessagingNumberStatusClient(userId).then((result) => {
      if (cancelled || !result.ok) return;
      setSmsCanSend(result.status.canSend === true);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionReady, userId]);

  useEffect(() => {
    void loadSmsRecipients();
  }, [loadSmsRecipients]);

  useEffect(() => {
    const prefill = consumeManagerComposePrefill();
    if (!prefill) return;
    setComposeDraft(prefill);
    setComposeChannel("email");
    setComposeOpen(true);
  }, []);

  const openCompose = useCallback(
    (preferred: CommunicationComposeChannel) => {
      setComposeChannel(preferred);
      setComposeOpen(true);
      void loadSmsRecipients();
    },
    [loadSmsRecipients],
  );

  const handleComposeSent = useCallback(
    async (result: { email: boolean; sms: boolean; primaryRecipientEmail?: string }) => {
      if (result.email) {
        if (result.primaryRecipientEmail) {
          await inboxRef.current?.reloadInboxAsync?.();
          const threadId = inboxRef.current?.findThreadForRecipient?.(result.primaryRecipientEmail);
          if (threadId) {
            setActiveThreadId(threadId);
            selectCommunicationThreadUrl(`${commBase}/active/${encodeURIComponent(threadId)}`);
          }
        } else {
          inboxRef.current?.reloadInbox?.();
        }
      }
      if (result.sms) {
        smsRef.current?.reload?.();
        void loadSmsRecipients();
      }
    },
    [commBase, loadSmsRecipients, setActiveThreadId],
  );

  const filterTouchCount = communicationFilterTouches(filters, listSort);

  const activeFilterChips = useMemo((): PortalActiveFilterChip[] => {
    const chips: PortalActiveFilterChip[] = [];
    if (filters.status && filters.status !== "active") chips.push({ id: "status", label: filters.status === "read" ? "Read" : filters.status === "unread" ? "Unread" : "Archived", onRemove: () => setFilters((f) => ({ ...f, status: "active" })) });
    for (const propertyId of filters.propertyIds) {
      const label = propertyOptions.find((p) => p.value === propertyId)?.label ?? propertyId;
      chips.push({
        id: `house-${propertyId}`,
        label: `House: ${label}`,
        onRemove: () =>
          setFilters((f) => ({
            ...f,
            propertyIds: f.propertyIds.filter((id) => id !== propertyId),
          })),
      });
    }
    for (const role of filters.roles) {
      const label = ROLE_OPTIONS.find((r) => r.value === role)?.label ?? roleLabel(role);
      chips.push({
        id: `role-${role}`,
        label: `Role: ${label}`,
        onRemove: () =>
          setFilters((f) => ({
            ...f,
            roles: f.roles.filter((r) => r !== role),
            contactIds: [],
          })),
      });
    }
    if (listSort !== "recent") {
      const sortLabel = listSort === "resident" ? "Resident (A–Z)" : listSort;
      chips.push({
        id: "sort",
        label: `Sort: ${sortLabel}`,
        onRemove: () => setListSort("recent"),
      });
    }
    return chips;
  }, [filters, listSort, propertyOptions]);

  const filterControls = (
    <CommunicationFilterSortFields
      propertyOptions={propertyOptions}
      roleOptions={ROLE_OPTIONS}
      filters={{ ...filters, status: filters.status ?? listSegment }}
      onFiltersChange={setFilters}
      listSort={listSort}
      onListSortChange={setListSort}
    />
  );

  const communicationFilterSheet = (
    <PortalFilterSortSheet
      activeCount={filterTouchCount}
      compactPanel
      filterFieldCount={4}
      // Three filter fields plus sort do not fit inside the title band's own
      // height. Constraining the panel to the band clips the last field, which
      // is what tests/unit/finance-documents-title-row-controls.test.ts pins.
      constrainDropdownToTitleBand={false}
      // The same plain filter glyph every list bar uses; the word lives in the
      // tooltip and the active count in the accessible name.
      commandStripTrigger
      mobileFlushBody={true}
      onReset={() => {
        setFilters({ ...EMPTY_COMMUNICATION_THREAD_FILTERS, status: "active" });
        setListSort("recent");
      }}
      dataAttr="communication-filter-sheet-open"
    >
      {filterControls}
    </PortalFilterSortSheet>
  );

  const communicationNewMessageButton = (
    <PortalPrimaryIconAction
      icon={PenSquare}
      label="New message"
      data-attr="communication-new-message"
      onClick={() => openCompose("email")}
    />
  );

  const communicationCommandActions = (
    <>
      {communicationFilterSheet}
      {/* Plan-gated SETUP cta. It self-hides once a number is assigned, at
          which point ManagerWorkNumberCard shows the number itself at the top
          of the conversation list — so the two never appear together, and
          deleting this would remove the only entry to work-number setup (and
          the free-tier upsell behind it). */}
      <ManagerWorkNumberButton />
      {/*
        Every other section has a settings gear; Communication didn't. The
        panel this used to point at was phone verification — the resident's
        own Settings → Messaging, which really was a duplicate — but the
        settings tab now holds real Communication-wide preferences
        (`CommunicationSettingsPanel`), so the gear belongs back on the
        toolbar. Label/title/data-attr all come from one registry entry
        (`settings-entry-points.ts`) so they cannot drift from each other.
      */}
      <PortalIconAction
        icon={Settings2}
        label={communicationSettingsEntry.label}
        data-attr={communicationSettingsEntry.dataAttr}
        onClick={() => setCommunicationSettingsOpen(true)}
      />
      {communicationNewMessageButton}
    </>
  );

  // The chips stay on the page background between the title band and the cards.
  // PortalActiveFilterChips returns null when empty, and the shell drops its
  // wrapper with it, so there is no phantom gap when nothing is filtered.
  const controlStack = <PortalActiveFilterChips chips={activeFilterChips} />;

  return (
    <PortalCommunicationShell
      title="Communication"
      hideTitleOnMobileNav
      controlStack={controlStack}
      hideMobileFilterRow={threadOpen}
      mobileThreadReading={threadOpen}
      threadSelected={threadSelected}
    >
      <ManagerCommunicationComposeModal
        open={composeOpen}
        onClose={() => {
          setComposeOpen(false);
          setComposeDraft(null);
        }}
        initialChannel={composeChannel}
        initialDraft={composeDraft}
        liveContacts={liveContacts}
        smsRecipients={smsRecipients}
        smsUiEnabled={smsUiEnabled}
        onStageOptimistic={(thread) => inboxRef.current?.stageOptimisticSentThread(thread)}
        onClearOptimistic={(threadId) => inboxRef.current?.clearPendingSend(threadId)}
        onSent={handleComposeSent}
      />

      <ManagerUnifiedInbox
        tabId={inboxTabId}
        commBase={commBase}
        listSegment={listSegment}
        routeThreadId={activeThreadId}
        onRouteThreadChange={setActiveThreadId}
        threadFilters={filters}
        filterContacts={filterContacts}
        listSort={listSort}
        smsUiEnabled={smsUiEnabled}
        inboxRef={inboxRef}
        smsRef={smsRef}
        onThreadOpenChange={setThreadOpen}
        onThreadSelectedChange={setThreadSelected}
        listChrome="internal"
        // The tools sit beside the list's own search, not in a bare pill row
        // above the split view (PLAN-0914-1345).
        listActions={communicationCommandActions}
        onAddConversation={() => openCompose("email")}
        onApplicationsLoaded={refreshDirectory}
      />
      <ManagerPortalSettingsModal
        open={communicationSettingsOpen}
        onClose={() => setCommunicationSettingsOpen(false)}
        initialTab="communication"
        scopedTitle={settingsDialogTitlePrefix(communicationSettingsEntry)}
      />
    </PortalCommunicationShell>
  );
}
