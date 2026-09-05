"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import { ProPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import { ManagerBookingsListView } from "@/components/portal/manager-bookings-list-view";
import {
  ManagerPortalPageShell,
  PORTAL_COMMAND_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_STYLE,
} from "@/components/portal/portal-metrics";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ManagerPortfolioBookingsCalendar } from "@/components/portal/pro-portfolio-bookings-calendar";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerBookingEntries } from "@/hooks/use-manager-booking-entries";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import {
  bookingEntryKey,
  bookingsForListBucket,
  countBookingsByListBucket,
  type ManagerBookingListBucketId,
} from "@/lib/channel-calendar/bookings-ui";
import { filterBookingEntriesByRoom } from "@/lib/channel-calendar/property-bookings";
import { buildManagerPropertyFilterOptions, MANAGER_PORTFOLIO_REFRESH_EVENTS } from "@/lib/manager-portfolio-access";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  MANAGER_BOOKING_BUCKETS,
  MANAGER_BOOKING_BUCKET_LABELS,
  managerBookingListHref,
  type ManagerBookingBucketId,
} from "@/lib/portal-detail-routes";
import { dateKey, startOfLocalDay } from "@/lib/room-availability-calendar";
import { PortalFormSingleSelect } from "@/components/portal/filter-field-lists";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { LocalDestinationNav } from "@/components/ui/destination-nav";

const BULK_BAR_BTN = PORTAL_BULK_BAR_BTN;

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
  const navigate = usePortalNavigate();
  const { userId, ready: authReady } = useManagerUserId();
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);

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

  const { entries: rawEntries, loading } = useManagerBookingEntries({
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
  const listEntries = useMemo(
    () => (isListBucket(bucket) ? bookingsForListBucket(entries, listBucket, todayKey) : []),
    [bucket, entries, listBucket, todayKey],
  );

  const { selectedIds, setSelectedIds } = usePortalRowSelection(bucket);

  const tabs = useMemo(
    () =>
      BOOKING_BUCKET_LABELS.map(({ id, label }) => ({
        id,
        label,
        count: counts[id],
      })),
    [counts],
  );

  const propertyFilterSheet =
    showPropertyFilter && propertyOptions.length > 1 ? (
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

  const openCalendarForDay = useCallback(
    (dayKey: string) => {
      void dayKey;
      if (basePath) {
        navigate(managerBookingListHref(basePath, "calendar"));
        return;
      }
      onBucketChange?.("calendar");
    },
    [basePath, navigate, onBucketChange],
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
            if (first) openCalendarForDay(first.start);
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
      actions={
        <>
          {propertyFilterSheet}
          {roomFilterSheet}
          <Button
            type="button"
            variant="outline"
            className={PORTAL_COMMAND_ACTION_BTN}
            data-attr="bookings-settings-open"
            disabled={linkDisabled}
            onClick={() => setSettingsModalOpen(true)}
          >
            Settings
          </Button>
          <Button
            type="button"
            className={PORTAL_COMMAND_PRIMARY_ACTION_BTN}
            style={PORTAL_COMMAND_PRIMARY_ACTION_STYLE}
            disabled={linkDisabled}
            data-attr="portfolio-bookings-link-airbnb"
            onClick={() => setLinkModalOpen(true)}
          >
            Link Airbnb
          </Button>
        </>
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
        roomFilterId={roomFilterId}
        emptyMessage={emptyMessage}
        variant="standalone"
        calendarOnly
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
        onOpenDay={openCalendarForDay}
        bulkActions={listBulkActions}
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
      <ChannelCalendarLinkModal
        open={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        propertyIds={propertyIds}
        propertyOptions={propertyOptions}
        initialPropertyId={
          propertyFilters.length === 1 ? propertyFilters[0] : propertyIds.length === 1 ? propertyIds[0] : undefined
        }
        showToast={showToast}
        onChanged={() => onRefreshSignal?.()}
      />
      <ProPortalSettingsModal
        open={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        initialTab="bookings"
        scoped
        propertyOptions={propertyOptions}
        initialPropertyId={propertyFilters.length === 1 ? propertyFilters[0] : undefined}
      />
    </>
  );

  return { controlStack, content, modals };
}

/**
 * Embedded Bookings (one house's Bookings tab) — chrome and body as siblings in
 * the panel's own flex column.
 */
export function ManagerBookingsWorkspace(props: BookingsWorkspaceProps) {
  const { controlStack, content, modals } = useBookingsWorkspace(props);
  return (
    <>
      {controlStack}
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">{content}</div>
      {modals}
    </>
  );
}

export function ManagerBookings({
  bucket = "upcoming",
  basePath = "/portal",
}: {
  bucket?: ManagerBookingBucketId;
  basePath?: string;
}) {
  const { userId, ready: authReady } = useManagerUserId();
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
    return () => {
      for (const eventName of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
        window.removeEventListener(eventName, bump);
      }
    };
  }, []);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, propertyTick],
  );

  const propertyIds = useMemo(() => propertyOptions.map((option) => option.id), [propertyOptions]);

  const { controlStack, content, modals } = useBookingsWorkspace({
    bucket,
    basePath,
    propertyIds,
    propertyOptions,
    propertyTick,
    refreshSignal,
    onRefreshSignal: () => setRefreshSignal((n) => n + 1),
  });

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
    <ManagerPortalPageShell title="Bookings" hideTitleOnMobileNav titleInlineFilter={null} compactFilterRow>
      {controlStack}
      {modals}
      <PortalPageScrollBody>{content}</PortalPageScrollBody>
    </ManagerPortalPageShell>
  );
}
