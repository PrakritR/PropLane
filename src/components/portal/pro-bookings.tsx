"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { BookingsBlockDatesModal, type BlockDatesDraft, type BookingsSheetPane } from "@/components/portal/bookings-block-dates-modal";
import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import {
  getSettingsEntryPoint,
  settingsDialogTitlePrefix,
} from "@/components/portal/settings-entry-points";
import { ManagerBookingsListView } from "@/components/portal/manager-bookings-list-view";
import { BookingsDayPage } from "@/components/portal/bookings-day-page";
import { BookingsRecordPage } from "@/components/portal/bookings-record-page";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalIconAction, PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { portalEmptyCopy, portalEmptyNoMatchTitle, portalEmptySibling } from "@/lib/portal-empty-copy";
import { CalendarOff, CalendarSync, Settings } from "lucide-react";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortfolioBookingsCalendar } from "@/components/portal/pro-portfolio-bookings-calendar";
import { Button } from "@/components/ui/button";
import { useAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { useManagerBookingEntries } from "@/hooks/use-manager-booking-entries";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import {
  bookingEntryKey,
  bookingsForListBucket,
  countBookingsByListBucket,
  filterBookingsBySearch,
  type ManagerBookingListBucketId,
} from "@/lib/channel-calendar/bookings-ui";
import { filterBookingEntriesByRoom, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { deleteRoomDateBlock, saveRoomDateBlock } from "@/lib/channel-calendar/room-date-blocks";
import { sendBookingResidentInviteRequest } from "@/lib/booking-resident-invite-client";
import { buildManagerPropertyFilterOptions, MANAGER_PORTFOLIO_REFRESH_EVENTS } from "@/lib/manager-portfolio-access";
import { WORKSPACE_SELECTION_EVENT, activeWorkspacePropertyIds } from "@/lib/workspaces/selection";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  MANAGER_BOOKING_BUCKETS,
  MANAGER_BOOKING_BUCKET_LABELS,
  managerBookingDayHref,
  managerBookingListHref,
  type ManagerBookingBucketId,
} from "@/lib/portal-detail-routes";
import { dateKey, startOfLocalDay } from "@/lib/room-availability-calendar";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { LocalDestinationNav } from "@/components/ui/destination-nav";

const BULK_BAR_BTN = PORTAL_BULK_BAR_BTN;

const bookingsSettingsEntry = getSettingsEntryPoint("bookings");

const BOOKING_BUCKET_LABELS = MANAGER_BOOKING_BUCKETS.map((id) => ({
  id,
  label: MANAGER_BOOKING_BUCKET_LABELS[id],
}));

function isListBucket(bucket: ManagerBookingBucketId): bucket is ManagerBookingListBucketId {
  return bucket !== "calendar";
}

type BookingsWorkspaceProps = {
  bucket: ManagerBookingBucketId;
  /** When set, tab destinations use routed hrefs; otherwise `onBucketChange` handles tabs. */
  basePath?: string;
  onBucketChange?: (bucket: ManagerBookingBucketId) => void;
  propertyIds: string[];
  propertyOptions: ManagerPropertyFilterOption[];
  showPropertyFilter?: boolean;
  showRoomFilter?: boolean;
  roomOptions?: { id: string; label: string }[];
  roomFilterId?: string;
  onRoomFilterIdChange?: (next: string) => void;
  emptyMessage?: string;
  propertyTick: number;
  refreshSignal: number;
  onRefreshSignal?: () => void;
};

/**
 * The Bookings chrome and body, built as separate nodes.
 *
 * They are returned rather than rendered together because the page shell pins
 * its chrome by inspecting its OWN children — a component that renders both
 * halves internally hides them from that split.
 */
function useBookingsWorkspace({
  bucket,
  basePath,
  onBucketChange,
  propertyIds,
  propertyOptions,
  showPropertyFilter = true,
  showRoomFilter = false,
  roomOptions = [],
  roomFilterId = "",
  onRoomFilterIdChange,
  emptyMessage,
  propertyTick,
  refreshSignal,
  onRefreshSignal,
}: BookingsWorkspaceProps) {
  const { showToast } = useAppUi();
  const confirm = useConfirm();
  const navigate = usePortalNavigate();
  const { userId, ready: authReady } = useManagerUserId();
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [listSearch, setListSearch] = useState("");
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [sheet, setSheet] = useState<{
    open: boolean;
    pane: BookingsSheetPane;
    dayKey: string | null;
    editingBlock: PropertyBookingEntry | null;
  }>({ open: false, pane: "block", dayKey: null, editingBlock: null });

  const scopedPropertyIds = useMemo(() => {
    if (propertyFilters.length === 0) return propertyIds;
    const allowed = new Set(propertyFilters);
    return propertyIds.filter((id) => allowed.has(id));
  }, [propertyFilters, propertyIds]);

  const scopedPropertyOptions = useMemo(
    () =>
      propertyOptions.filter((option) =>
        propertyFilters.length === 0 ? propertyIds.includes(option.id) : propertyFilters.includes(option.id),
      ),
    [propertyFilters, propertyIds, propertyOptions],
  );

  const { entries: rawEntries, loading, residentOptions } = useManagerBookingEntries({
    userId,
    propertyIds: scopedPropertyIds,
    propertyOptions: scopedPropertyOptions,
    propertyTick,
    refreshSignal,
    showToast,
  });

  const entries = useMemo(
    () => filterBookingEntriesByRoom(rawEntries, roomFilterId),
    [rawEntries, roomFilterId],
  );

  /**
   * The calendar fetches Airbnb itself; everything PropLane knows — signed
   * stays, approved-application holds, blocked dates — rides in here. Without
   * this the grid showed only the channel import and reported a let room free.
   */
  const calendarExtraEntries = useMemo(
    () => rawEntries.filter((entry) => entry.source !== "airbnb"),
    [rawEntries],
  );

  const saveBlock = useCallback(
    async (draft: BlockDatesDraft) => {
      if (!userId) throw new Error("Sign in again to block dates.");
      const saved = await saveRoomDateBlock(userId, draft);
      // A brand-new resident on a fresh hold gets an invite — the link that
      // creates their account and skips application/lease
      // (src/lib/booking-resident-invite.server.ts). Editing an existing
      // hold, or holding for no one / an existing pick, never re-invites.
      if (draft.isNewResident && (draft.residentEmail || draft.residentPhone)) {
        const property = propertyOptions.find((option) => option.id === draft.propertyId);
        const invite = await sendBookingResidentInviteRequest({
          blockId: saved.id,
          propertyId: draft.propertyId,
          propertyLabel: property?.label ?? "",
          residentName: draft.residentName,
          residentEmail: draft.residentEmail,
          residentPhone: draft.residentPhone ?? "",
        });
        if (invite.ok) {
          showToast(`Held for ${draft.residentName}.`);
          return { message: invite.message };
        }
        showToast(`Held for ${draft.residentName} — ${invite.error}`);
        return { message: `Booking added, but the invite didn’t go out: ${invite.error}` };
      }
      showToast(draft.residentName ? `Held for ${draft.residentName}.` : "Dates blocked.");
    },
    [userId, showToast, propertyOptions],
  );

  const removeBlock = useCallback(
    async (blockId: string) => {
      try {
        await deleteRoomDateBlock(blockId);
        showToast("Block removed.");
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not remove that block.");
      }
    },
    [showToast],
  );

  const deleteBlockEntry = useCallback(
    async (entry: PropertyBookingEntry) => {
      if (!entry.blockId) return;
      if (
        !(await confirm({
          title: "Delete hold",
          description: `Delete ${entry.summary || "this hold"}?`,
          confirmLabel: "Delete",
          tone: "danger",
          dataAttr: "bookings-delete-block-confirm",
        }))
      ) {
        return;
      }
      await removeBlock(entry.blockId);
    },
    [confirm, removeBlock],
  );

  const todayKey = useMemo(() => dateKey(startOfLocalDay(new Date())), []);

  const counts = useMemo(() => {
    const listCounts = countBookingsByListBucket(entries, todayKey);
    return {
      upcoming: listCounts.upcoming,
      inhouse: listCounts.inhouse,
      past: listCounts.past,
      calendar: 0,
    };
  }, [entries, todayKey]);

  const listBucket = isListBucket(bucket) ? bucket : "upcoming";
  const listEntries = useMemo(() => {
    if (!isListBucket(bucket)) return [];
    return filterBookingsBySearch(bookingsForListBucket(entries, listBucket, todayKey), listSearch);
  }, [bucket, entries, listBucket, listSearch, todayKey]);

  const { selectedIds, setSelectedIds } = usePortalRowSelection(bucket);

  const tabs = useMemo(
    () =>
      BOOKING_BUCKET_LABELS.map(({ id, label }) => ({
        id,
        label,
        // The calendar is a view, not a bucket — a "0" beside it reads as empty.
        count: id === "calendar" ? undefined : counts[id],
      })),
    [counts],
  );

  const propertyFilterSheet = showPropertyFilter ? (
      <PortalFilterSortSheet
        activeCount={portalFilterActiveCount([propertyFilters])}
        compactPanel
        commandStripTrigger
        dropdownAlign="start"
        filterFieldCount={1}
        mobileFlushBody
        onReset={() => setPropertyFilters([])}
        dataAttr="bookings-filter-sheet-open"
      >
        <ApplicationFilterSortFields
          propertyOptions={propertyOptions}
          propertyFilters={propertyFilters}
          onPropertyFiltersChange={setPropertyFilters}
          dataAttr="bookings-filter-property"
        />
      </PortalFilterSortSheet>
    ) : null;

  const roomFilterSheet =
    showRoomFilter && roomOptions.length > 1 && onRoomFilterIdChange ? (
      <PortalFilterSortSheet
        activeCount={portalFilterActiveCount([roomFilterId])}
        compactPanel
        commandStripTrigger
        dropdownAlign="start"
        filterFieldCount={1}
        constrainDropdownToTitleBand={false}
        mobileFlushBody
        className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
        onReset={() => onRoomFilterIdChange("")}
        dataAttr="property-bookings-room-filter-sheet-open"
      >
        <PortalFormSingleSelect
          label="Room"
          value={roomFilterId}
          onChange={onRoomFilterIdChange}
          options={[
            { value: "", label: "All rooms" },
            ...roomOptions.map((room) => ({ value: room.id, label: room.label })),
          ]}
          placeholder="All rooms"
          dataAttr="property-bookings-room-filter"
        />
      </PortalFilterSortSheet>
    ) : null;

  const activeFilterChips = useMemo(() => {
    const chips: { id: string; label: string; onRemove: () => void }[] = [];
    if (showPropertyFilter && propertyFilters.length > 0) {
      const labelById = new Map(propertyOptions.map((option) => [option.id, option.label]));
      chips.push({
        id: "property",
        label:
          propertyFilters.length === 1
            ? `Property: ${labelById.get(propertyFilters[0]!) ?? propertyFilters[0]}`
            : `${propertyFilters.length} properties`,
        onRemove: () => setPropertyFilters([]),
      });
    }
    if (showRoomFilter && roomFilterId && onRoomFilterIdChange) {
      const roomLabel = roomOptions.find((room) => room.id === roomFilterId)?.label ?? roomFilterId;
      chips.push({
        id: "room",
        label: `Room: ${roomLabel}`,
        onRemove: () => onRoomFilterIdChange(""),
      });
    }
    return chips.length > 0 ? <PortalActiveFilterChips chips={chips} /> : null;
  }, [
    onRoomFilterIdChange,
    propertyFilters,
    propertyOptions,
    roomFilterId,
    roomOptions,
    showPropertyFilter,
    showRoomFilter,
  ]);

  /**
   * The day page always lives at `/portal/bookings/<date>` regardless of
   * whether this workspace is the portfolio page or a house's embedded
   * Bookings tab — there is no property-scoped day route.
   */
  const goToDayPage = useCallback(
    (dayKey: string) => navigate(managerBookingDayHref(basePath ?? "/portal", dayKey)),
    [basePath, navigate],
  );

  const listBulkActions =
    selectedIds.size > 0 ? (
      <>
        <Button
          type="button"
          variant="outline"
          className={BULK_BAR_BTN}
          data-attr="bookings-bulk-view-calendar"
          onClick={() => {
            const first = listEntries.find((entry) => selectedIds.has(bookingEntryKey(entry)));
            if (first) goToDayPage(first.start);
          }}
        >
          View on calendar
        </Button>
      </>
    ) : null;

  const navigateBucket = useCallback(
    (next: ManagerBookingBucketId) => {
      if (basePath) {
        navigate(managerBookingListHref(basePath, next));
        return;
      }
      onBucketChange?.(next);
    },
    [basePath, navigate, onBucketChange],
  );

  const linkDisabled = propertyOptions.length === 0;

  const destinationRow = !basePath ? (
    <LocalDestinationNav
      items={tabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        count: tab.count,
        dataAttr: `bookings-bucket-${tab.id}`,
      }))}
      activeId={bucket}
      onChange={(id) => navigateBucket(id as ManagerBookingBucketId)}
      ariaLabel="Booking views"
      appearance="command"
    />
  ) : undefined;

  const controlStack = (
    <PortalListControlStack
      className="mb-2 max-lg:mb-1.5"
      variant="command"
      destinationRow={destinationRow}
      destinations={
        basePath
          ? tabs.map((tab) => ({
              id: tab.id,
              label: tab.label,
              href: managerBookingListHref(basePath, tab.id),
              count: tab.count,
              dataAttr: `bookings-bucket-${tab.id}`,
            }))
          : undefined
      }
      activeDestinationId={bucket}
      destinationAriaLabel="Booking views"
      search={{
        value: listSearch,
        onChange: setListSearch,
        placeholder: "Search bookings",
        dataAttr: "bookings-search",
      }}
      actions={
        <>
          {propertyFilterSheet}
          {roomFilterSheet}
          <PortalIconAction
            icon={CalendarOff}
            label="Add booking"
            data-attr="bookings-block-dates-open"
            disabled={linkDisabled}
            onClick={() => setSheet({ open: true, pane: "block", dayKey: null, editingBlock: null })}
          />
          <PortalIconAction
            icon={Settings}
            label={bookingsSettingsEntry.label}
            data-attr={bookingsSettingsEntry.dataAttr}
            disabled={linkDisabled}
            onClick={() => setSettingsModalOpen(true)}
          />
        </>
      }
      primary={
        <PortalPrimaryIconAction
          label="Link calendars"
          icon={CalendarSync}
          disabled={linkDisabled}
          data-attr="portfolio-bookings-link-airbnb"
          onClick={() => setSheet({ open: true, pane: "airbnb", dayKey: null, editingBlock: null })}
        />
      }
      activeFilterChips={activeFilterChips}
    />
  );

  const content =
    bucket === "calendar" ? (
      <ManagerPortfolioBookingsCalendar
        propertyIds={scopedPropertyIds}
        showToast={showToast}
        refreshSignal={refreshSignal}
        extraEntries={calendarExtraEntries}
        roomFilterId={roomFilterId}
        emptyMessage={emptyMessage}
        variant="standalone"
        calendarOnly
        onDayClick={goToDayPage}
        searchQuery={listSearch}
      />
    ) : (
      <ManagerBookingsListView
        entries={listEntries}
        loading={!authReady || loading}
        bucket={listBucket}
        selectedKeys={selectedIds}
        onToggleSelected={(key, selected) => {
          setSelectedIds((prev) => {
            const next = new Set(prev);
            if (selected) next.add(key);
            else next.delete(key);
            return next;
          });
        }}
        onEditBlock={(entry) => setSheet({ open: true, pane: "block", dayKey: null, editingBlock: entry })}
        onDeleteBlock={(entry) => void deleteBlockEntry(entry)}
        bulkActions={listBulkActions}
        basePath={basePath ?? "/portal"}
        showToast={showToast}
        emptyCard={
          propertyFilters.length > 0 || roomFilterId || listSearch.trim()
            ? {
                title: portalEmptyNoMatchTitle("bookings", listSearch),
                section: "bookings",
                tone: "muted",
                clear: {
                  label: "Clear filters",
                  onClick: () => {
                    setPropertyFilters([]);
                    setListSearch("");
                    onRoomFilterIdChange?.("");
                  },
                  dataAttr: "bookings-empty-clear-filters",
                },
              }
            : {
                title: portalEmptyCopy(`bookings.${listBucket}`).title,
                section: "bookings",
                sibling: basePath
                  ? portalEmptySibling(
                      tabs.map((tab) => ({ id: tab.id, label: tab.label, count: tab.count, href: managerBookingListHref(basePath, tab.id) })),
                      listBucket,
                    )
                  : null,
                actions:
                  listBucket === "upcoming"
                    ? [
                        {
                          label: "Link calendars",
                          icon: CalendarSync,
                          onClick: () => setSheet({ open: true, pane: "airbnb", dayKey: null, editingBlock: null }),
                          disabled: linkDisabled,
                          reason: linkDisabled ? "List a property first, then link its rooms." : undefined,
                          dataAttr: "bookings-empty-link-airbnb",
                        },
                      ]
                    : [],
              }
        }
      />
    );

  /*
   * Settings and Link Airbnb are two different dialogs.
   *
   * Settings used to open the Link Airbnb modal as well, so the section had two
   * buttons that led to the same place and nowhere to put a booking preference.
   * Settings is now the section's own scoped settings — booking reminders.
   */
  const modals = (
    <>
      <BookingsBlockDatesModal
        open={sheet.open}
        onClose={() => setSheet({ open: false, pane: "block", dayKey: null, editingBlock: null })}
        propertyOptions={propertyOptions}
        initialPropertyId={
          propertyFilters.length === 1 ? propertyFilters[0] : propertyIds.length === 1 ? propertyIds[0] : undefined
        }
        initialRoomId={roomFilterId}
        initialDayKey={sheet.dayKey}
        initialPane={sheet.pane}
        pane={sheet.pane}
        onPaneChange={(pane) => setSheet((current) => ({ ...current, pane }))}
        editingBlock={sheet.editingBlock}
        entries={rawEntries}
        residentOptions={residentOptions}
        onSave={saveBlock}
        onDeleteBlock={removeBlock}
        propertyIds={propertyIds}
        showToast={showToast}
        onAirbnbChanged={() => onRefreshSignal?.()}
      />
      <ProPortalSettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        initialTab="bookings"
        scoped
        scopedTitle={settingsDialogTitlePrefix(bookingsSettingsEntry)}
        propertyOptions={propertyOptions}
        initialPropertyId={propertyFilters.length === 1 ? propertyFilters[0] : undefined}
      />
    </>
  );

  return {
    controlStack,
    content,
    modals,
    /** Unfiltered by the workspace's own property/room filters — what a record or day page looks a booking up in. */
    rawEntries,
    entriesLoading: !authReady || loading,
    residentOptions,
    saveBlock,
    removeBlock,
  };
}

/**
 * Embedded Bookings (one house's Bookings tab) — chrome and body as siblings in
 * the panel's own flex column.
 */
export function ManagerBookingsWorkspace(props: BookingsWorkspaceProps) {
  const { controlStack, content, modals } = useBookingsWorkspace(props);
  return (
    <>
      {/* Link Airbnb rides in the command bar with the other tools — nothing above the tabs. */}
      {controlStack}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">{content}</div>
      {modals}
    </>
  );
}

export function ManagerBookings({
  bucket = "calendar",
  basePath = "/portal",
  bookingId,
  bookingTab,
  dayKey,
}: {
  bucket?: ManagerBookingBucketId;
  basePath?: string;
  /** Present for the booking record page (`/bookings/<id>/<tab>`) — routes here instead of a bucket. */
  bookingId?: string;
  bookingTab?: string;
  /** Present for the day page (`/bookings/<yyyy-mm-dd>`) — routes here instead of a bucket. */
  dayKey?: string;
}) {
  const { userId, ready: authReady } = useManagerUserId();
  const { showToast } = useAppUi();
  const [propertyTick, setPropertyTick] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);

  useEffect(() => {
    if (!authReady || !userId) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
  }, [authReady, userId]);

  useEffect(() => {
    const bump = () => setPropertyTick((n) => n + 1);
    for (const eventName of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
      window.addEventListener(eventName, bump);
    }
    window.addEventListener(WORKSPACE_SELECTION_EVENT, bump);
    return () => {
      for (const eventName of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
        window.removeEventListener(eventName, bump);
      }
      window.removeEventListener(WORKSPACE_SELECTION_EVENT, bump);
    };
  }, []);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, propertyTick],
  );

  const workspacePropertyIds = activeWorkspacePropertyIds();
  const propertyIds = useMemo(() => {
    if (workspacePropertyIds !== null) return workspacePropertyIds;
    return propertyOptions.map((option) => option.id);
  }, [workspacePropertyIds, propertyOptions]);

  const workspace = useBookingsWorkspace({
    bucket,
    basePath,
    propertyIds,
    propertyOptions,
    propertyTick,
    refreshSignal,
    onRefreshSignal: () => setRefreshSignal((n) => n + 1),
  });
  const { controlStack, content, modals, rawEntries, entriesLoading, residentOptions, saveBlock, removeBlock } = workspace;

  if (dayKey) {
    return (
      <BookingsDayPage
        dayKey={dayKey}
        basePath={basePath}
        entries={rawEntries}
        loading={entriesLoading}
        propertyOptions={propertyOptions}
        residentOptions={residentOptions}
        onSaveBlock={saveBlock}
        onRemoveBlock={removeBlock}
        showToast={showToast}
      />
    );
  }

  if (bookingId) {
    return (
      <BookingsRecordPage
        bookingId={bookingId}
        tab={bookingTab}
        basePath={basePath}
        entries={rawEntries}
        loading={entriesLoading}
        residentOptions={residentOptions}
        onSaveBlock={saveBlock}
        onRemoveBlock={removeBlock}
        showToast={showToast}
      />
    );
  }

  /*
   * Tabs and the action row are DIRECT children of the shell, with the list in
   * its own PortalPageScrollBody beside them.
   *
   * `partitionPortalPageChildren` splits pinned chrome from the scrolling body
   * by inspecting the shell's own children, and React cannot see through a
   * component boundary — so handing the shell a single <ManagerBookingsWorkspace/>
   * put the whole page, tabs and Link Airbnb included, inside the scroller and
   * they scrolled away with the rows.
   */
  return (
    <ManagerPortalPageShell
      title="Bookings"
      hideTitleOnMobileNav
      titleInlineFilter={null}
      compactFilterRow
    >
      {controlStack}
      {modals}
      <PortalPageScrollBody>{content}</PortalPageScrollBody>
    </ManagerPortalPageShell>
  );
}
