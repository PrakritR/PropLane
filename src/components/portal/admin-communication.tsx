"use client";

/**
 * Admin Communication: the manager's Communication page, mounted over admin's
 * own conversations (captain, 2026-10-08: "copy manager communication for
 * admin").
 *
 * It is the same `ManagerUnifiedInbox` the manager page mounts - identity boxes
 * (support email and the admin number), Active | Archived tabs, one list that
 * merges email and text conversations, the two-pane thread with the shared
 * composer, scheduled sends inline in the thread, Unread under Filter, the round
 * blue + for New message - fed by the admin adapter
 * (`communication-adapters/admin-inbox-adapter.tsx`). There is no admin-only
 * inbox component any more, and no table exception.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import { CommunicationFilterSortFields } from "@/components/portal/communication-filter-sort-fields";
import { createAdminInboxAdapter } from "@/components/portal/communication-adapters/admin-inbox-adapter";
import { AdminComposeModal, type AdminComposeRecipient } from "@/components/portal/admin-compose-modal";
import { PortalActiveFilterChips, type PortalActiveFilterChip } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { ManagerUnifiedInbox } from "@/components/portal/pro-unified-inbox";
import { useCommunicationListSegment } from "@/hooks/use-communication-list-segment";
import { useCommunicationThreadId } from "@/hooks/use-communication-thread-id";
import { refreshAdminScheduled } from "@/lib/admin-inbox-source";
import {
  EMPTY_COMMUNICATION_THREAD_FILTERS,
  type CommunicationThreadFilters,
} from "@/lib/communication-thread-filters";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { selectCommunicationSegmentUrl } from "@/lib/portal-communication-nav";
import type { CommunicationListSort } from "@/lib/unified-inbox-merge";

const ADMIN_COMM_BASE = "/admin/communication";

export function AdminCommunication({
  listSegment: listSegmentProp = "active",
  threadId,
  smsUiEnabled = false,
}: {
  /** Routed conversation list segment (`/admin/communication/{active|unread|archived}`). */
  listSegment?: "active" | "unread" | "archived";
  /** Deep-linked conversation from `/admin/communication/{segment}/{threadId}`. */
  threadId?: string;
  /**
   * Server-resolved SMS Communication UI flag. When false the text stream is not
   * read at all and no text rows are drawn - transport, webhooks and both SMS
   * agents are unaffected.
   */
  smsUiEnabled?: boolean;
}) {
  const adapter = useMemo(() => createAdminInboxAdapter({ smsUiEnabled }), [smsUiEnabled]);
  const { activeThreadId, setActiveThreadId } = useCommunicationThreadId(ADMIN_COMM_BASE, threadId);
  // Client-tracked segment, as on the manager page: a plain-click tab switch is a
  // history push, never a remount, so the already-loaded list does not refetch.
  const { segment: listSegment, setSegment: setListSegment } = useCommunicationListSegment(
    ADMIN_COMM_BASE,
    listSegmentProp,
  );
  const [filters, setFilters] = useState<CommunicationThreadFilters>({
    ...EMPTY_COMMUNICATION_THREAD_FILTERS,
    status: listSegmentProp === "unread" ? "unread" : "active",
  });
  useEffect(() => {
    setFilters((current) => {
      if (listSegment === "unread") {
        return current.status === "unread" ? current : { ...current, status: "unread" };
      }
      if (current.status === "archived") return { ...current, status: "active" };
      return current;
    });
  }, [listSegment]);
  const [listSort, setListSort] = useState<CommunicationListSort>("recent");
  const [threadOpen, setThreadOpen] = useState(Boolean(threadId));
  const [threadSelected, setThreadSelected] = useState(Boolean(threadId));

  const handleSegmentNavigate = useCallback(
    (next: "active" | "archived") => {
      setListSegment(next);
      // A thread open in one folder never exists in the other.
      setActiveThreadId(undefined);
      selectCommunicationSegmentUrl(`${ADMIN_COMM_BASE}/${next}`);
    },
    [setActiveThreadId, setListSegment],
  );

  // New message: the audience picker, the message, send now or schedule.
  const [composeOpen, setComposeOpen] = useState(false);
  const [recipients, setRecipients] = useState<{
    managers: AdminComposeRecipient[];
    residents: AdminComposeRecipient[];
  }>({ managers: [], residents: [] });
  const [recipientsLoaded, setRecipientsLoaded] = useState(false);
  useEffect(() => {
    // The people admin can write to are read when the compose first opens.
    if (!composeOpen || recipientsLoaded || isDemoModeActive()) return;
    setRecipientsLoaded(true);
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/admin/portal-users", { credentials: "include" });
        const body = (await res.json()) as { managers?: AdminComposeRecipient[]; residents?: AdminComposeRecipient[] };
        if (!res.ok || cancelled) return;
        setRecipients({ managers: body.managers ?? [], residents: body.residents ?? [] });
      } catch {
        if (!cancelled) setRecipientsLoaded(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [composeOpen, recipientsLoaded]);

  const filterTouchCount = (filters.status && filters.status !== "active" ? 1 : 0) + (listSort !== "recent" ? 1 : 0);

  const activeFilterChips = useMemo((): PortalActiveFilterChip[] => {
    const chips: PortalActiveFilterChip[] = [];
    if (filters.status && filters.status !== "active" && filters.status !== "archived") {
      chips.push({
        id: "status",
        label: filters.status === "read" ? "Read" : "Unread",
        onRemove: () => setFilters((f) => ({ ...f, status: "active" })),
      });
    }
    if (listSort !== "recent") {
      chips.push({
        id: "sort",
        label: `Sort: ${listSort === "resident" ? "Resident (A–Z)" : listSort}`,
        onRemove: () => setListSort("recent"),
      });
    }
    return chips;
  }, [filters, listSort]);

  // Unread lives in Filter. House, Role and About are the manager's dimensions -
  // admin has no houses and its conversations carry no record link.
  const filterSheet = (
    <PortalFilterSortSheet
      activeCount={filterTouchCount}
      compactPanel
      filterFieldCount={2}
      constrainDropdownToTitleBand={false}
      commandStripTrigger
      mobileFlushBody
      onReset={() => {
        setFilters({ ...EMPTY_COMMUNICATION_THREAD_FILTERS, status: "active" });
        setListSort("recent");
      }}
      dataAttr="communication-filter-sheet-open"
    >
      <CommunicationFilterSortFields
        propertyOptions={[]}
        roleOptions={[]}
        filters={{ ...filters, status: filters.status ?? (listSegment === "unread" ? "unread" : "active") }}
        onFiltersChange={setFilters}
        listSort={listSort}
        onListSortChange={setListSort}
        hideArchived
        hideHouse
        hideRole
        hideAbout
      />
    </PortalFilterSortSheet>
  );

  const newMessage = (
    <PortalPrimaryIconAction
      icon={MessageSquarePlus}
      label="New message"
      data-attr="communication-new-message"
      onClick={() => setComposeOpen(true)}
    />
  );

  return (
    <PortalCommunicationShell
      title="Communication"
      hideTitleOnMobileNav
      controlStack={<PortalActiveFilterChips chips={activeFilterChips} />}
      hideMobileFilterRow={threadOpen}
      mobileThreadReading={threadOpen}
      threadSelected={threadSelected}
    >
      <AdminComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        onSent={() => {
          // The sent message is already in the store (the list re-derives from it);
          // a scheduled one is read back so it shows in its conversation.
          void refreshAdminScheduled();
        }}
        recipients={recipients}
      />
      <ManagerUnifiedInbox
        adapter={adapter}
        tabId="all"
        commBase={ADMIN_COMM_BASE}
        listSegment={listSegment}
        routeThreadId={activeThreadId}
        onRouteThreadChange={setActiveThreadId}
        threadFilters={filters}
        listSort={listSort}
        smsUiEnabled={smsUiEnabled}
        onThreadOpenChange={setThreadOpen}
        onThreadSelectedChange={setThreadSelected}
        listChrome="internal"
        listActions={filterSheet}
        listPrimary={newMessage}
        onAddConversation={() => setComposeOpen(true)}
        onArchivedViewChange={handleSegmentNavigate}
      />
    </PortalCommunicationShell>
  );
}
