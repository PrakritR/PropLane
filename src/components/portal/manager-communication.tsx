"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_MULTI_FIELD_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { CommunicationFilterSortFields } from "@/components/portal/communication-filter-sort-fields";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { ManagerUnifiedInbox } from "@/components/portal/manager-unified-inbox";
import { type ManagerInboxHandle } from "@/components/portal/manager-inbox";
import { type ManagerSmsPanelHandle } from "@/components/portal/manager-sms-panel";
import {
  ManagerCommunicationComposeModal,
  type CommunicationComposeChannel,
} from "@/components/portal/manager-communication-compose-modal";
import { ManagerWorkNumberButton } from "@/components/portal/manager-work-number-button";
import { ManagerSmsContactModal } from "@/components/portal/manager-sms-contact-modal";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
import {
  PORTAL_HEADER_ACTION_BTN,
  PORTAL_HEADER_PRIMARY_ACTION_BTN,
} from "@/components/portal/portal-metrics";
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
  dispatchManagerSmsContactsChanged,
  normalizeManagerSmsConversationsPayload,
  type ManagerSmsResidentConversation,
} from "@/lib/manager-sms-messages";
import { useCommunicationThreadId } from "@/hooks/use-communication-thread-id";
import { selectCommunicationThreadUrl } from "@/lib/portal-communication-nav";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { consumeManagerComposePrefill, type ManagerComposePrefill } from "@/lib/manager-compose-prefill";

export type ManagerInboxTabId = "unopened" | "opened" | "schedule" | "sent" | "trash";
/** @deprecated Legacy SMS routes redirect to unified inbox. */
export type ManagerCommunicationChannel = "inbox" | "sms";
/** @deprecated Legacy SMS folder URLs redirect to unified inbox. */
export type ManagerSmsTabId = "all" | "unopened" | "opened" | "schedule" | "sent";

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
  let n = 0;
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
  const { userId } = useManagerUserId();
  const { activeThreadId, setActiveThreadId } = useCommunicationThreadId(commBase, threadId);
  const inboxRef = useRef<ManagerInboxHandle>(null);
  const smsRef = useRef<ManagerSmsPanelHandle>(null);
  const [filters, setFilters] = useState<CommunicationThreadFilters>(EMPTY_COMMUNICATION_THREAD_FILTERS);
  const [listSort, setListSort] = useState<CommunicationListSort>("recent");
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeChannel, setComposeChannel] = useState<CommunicationComposeChannel>("email");
  const [composeDraft, setComposeDraft] = useState<ManagerComposePrefill | null>(null);
  const [contactOpen, setContactOpen] = useState(false);
  const [communicationSettingsOpen, setCommunicationSettingsOpen] = useState(false);
  const [smsRecipients, setSmsRecipients] = useState<ManagerSmsResidentConversation[]>([]);
  const [smsCanSend, setSmsCanSend] = useState(false);
  const smsOutboundEnabled = smsUiEnabled || smsCanSend;
  const [threadOpen, setThreadOpen] = useState(Boolean(threadId));
  const [threadSelected, setThreadSelected] = useState(Boolean(threadId));
  const [searchQuery, setSearchQuery] = useState("");
  const [propertyTick, setPropertyTick] = useState(0);

  const filterContacts = useMemo(() => {
    const live = buildManagerInboxLiveContacts(userId);
    return [axisAdminFilterContact(), ...live];
  }, [userId]);

  const liveContacts = useMemo(() => buildManagerInboxLiveContacts(userId), [userId]);

  useEffect(() => {
    const bump = () => setPropertyTick((n) => n + 1);
    const events = [...MANAGER_PORTFOLIO_REFRESH_EVENTS, PROPERTY_PIPELINE_EVENT, MANAGER_APPLICATIONS_EVENT];
    for (const eventName of events) window.addEventListener(eventName, bump);
    return () => {
      for (const eventName of events) window.removeEventListener(eventName, bump);
    };
  }, []);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId).map((option) => ({ value: option.id, label: option.label })),
    [userId, propertyTick],
  );

  const loadSmsRecipients = useCallback(async () => {
    // Load conversation directory when SMS UI is on OR the work number can send
    // (inbox replies to inbound texts need rows even while the SMS panel is hidden).
    if (!smsOutboundEnabled) return;
    try {
      const res = await fetch("/api/manager/sms-conversations", { credentials: "include", cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { residents?: ManagerSmsResidentConversation[] };
      const normalized = normalizeManagerSmsConversationsPayload(body);
      setSmsRecipients(normalized.residents);
    } catch {
      /* keep prior list */
    }
  }, [smsOutboundEnabled]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/manager/messaging-number", { credentials: "include", cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (cancelled || !body || typeof body !== "object") return;
        setSmsCanSend((body as { canSend?: boolean }).canSend === true);
      })
      .catch(() => {
        if (!cancelled) setSmsCanSend(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      filters={filters}
      onFiltersChange={setFilters}
      listSort={listSort}
      onListSortChange={setListSort}
    />
  );

  const communicationFilterSheet = (
    <PortalFilterSortSheet
      activeCount={filterTouchCount}
      compactPanel
      filterFieldCount={3}
      constrainDropdownToTitleBand
      className={PORTAL_MULTI_FIELD_FILTER_SHEET_CLASS}
      mobileFlushBody={true}
      onReset={() => {
        setFilters(EMPTY_COMMUNICATION_THREAD_FILTERS);
        setListSort("recent");
      }}
      dataAttr="communication-filter-sheet-open"
    >
      {filterControls}
    </PortalFilterSortSheet>
  );

  const communicationNewMessageButton = (
    <Button
      type="button"
      variant="outline"
      className={`shrink-0 ${PORTAL_HEADER_PRIMARY_ACTION_BTN}`}
      data-attr="communication-new-message"
      aria-label="New message"
      onClick={() => openCompose("email")}
    >
      <span className="sm:hidden" aria-hidden="true">
        Message
      </span>
      <span className="hidden sm:inline">New message</span>
    </Button>
  );

  const communicationHeaderActions = (
    <>
      {/* Plan-gated setup CTA: shown regardless of the SMS-inbox A2P flag so a
          paid manager can begin work-number setup (and a free manager sees the
          upsell) before the inbox surface is switched on. It self-hides once a
          number is assigned. */}
      <ManagerWorkNumberButton />
      {smsUiEnabled ? (
        <Button
          type="button"
          variant="outline"
          className={`shrink-0 ${PORTAL_HEADER_PRIMARY_ACTION_BTN}`}
          data-attr="communication-add-phone-contact"
          aria-label="Add contact"
          onClick={() => setContactOpen(true)}
        >
          <span className="sm:hidden" aria-hidden="true">
            Contact
          </span>
          <span className="hidden sm:inline">Add contact</span>
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        className={PORTAL_HEADER_ACTION_BTN}
        data-attr="communication-settings-open"
        onClick={() => setCommunicationSettingsOpen(true)}
      >
        Settings
      </Button>
      {communicationNewMessageButton}
    </>
  );

  const controlStack = (
    <PortalListControlStack
      destinations={[
        { id: "active", label: "Active", href: `${commBase}/active`, dataAttr: "communication-segment-active" },
        {
          id: "unread",
          label: "Unread",
          href: `${commBase}/unread`,
          dataAttr: "communication-segment-unread",
        },
        {
          id: "archived",
          label: "Archived",
          href: `${commBase}/archived`,
          dataAttr: "communication-segment-archived",
        },
      ]}
      activeDestinationId={listSegment}
      destinationAriaLabel="Conversation folders"
      destinationNavSize="toolbar"
      search={{
        value: searchQuery,
        onChange: setSearchQuery,
        placeholder: "Search contacts or messages",
        dataAttr: "unified-inbox-search",
      }}
      activeFilterChips={<PortalActiveFilterChips chips={activeFilterChips} />}
    />
  );

  return (
    <PortalCommunicationShell
      title="Communication"
      titleInlineFilter={communicationFilterSheet}
      titleAside={communicationHeaderActions}
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

      <ManagerSmsContactModal
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        onSaved={(contact) => {
          // Seed or rename immediately so selection resolves before the SMS
          // conversations refetch returns — including when this number already
          // had a sidebar thread under another role.
          dispatchManagerSmsContactsChanged({
            optimisticResident: {
              residentUserId: null,
              residentEmail: null,
              name: contact.displayName,
              directoryName: null,
              savedContactName: contact.displayName,
              phone: contact.phone,
              propertyLabel: null,
              counterpartyRole: contact.counterpartyRole,
              conversationKey: contact.conversationKey,
              memberKeys: [contact.conversationKey],
              messages: [],
            },
          });
          void loadSmsRecipients();
          setActiveThreadId(contact.conversationKey);
          selectCommunicationThreadUrl(
            `${commBase}/active/${encodeURIComponent(contact.conversationKey)}`,
          );
        }}
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
        listChrome="external"
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        onAddConversation={() => openCompose("email")}
      />
      <ManagerPortalSettingsModal
        open={communicationSettingsOpen}
        onClose={() => setCommunicationSettingsOpen(false)}
        initialTab="communication"
        scopedTitle="Communication"
      />
    </PortalCommunicationShell>
  );
}
