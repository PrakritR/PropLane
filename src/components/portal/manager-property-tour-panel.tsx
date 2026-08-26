"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ManagerToursGroupedTable } from "@/components/portal/manager-tours-grouped-table";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { TourProposalsPanel } from "@/components/portal/tour-proposals-panel";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { managerPropertyAvailabilityStorageKey, syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import {
  isGoogleBusyIncompleteWarning,
  useGoogleCalendarBusyMeetings,
} from "@/hooks/use-google-calendar-busy";
import { useScheduledTourReminders } from "@/hooks/use-scheduled-tour-reminders";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import {
  buildManagerTourRows,
  clusterManagerTourListRows,
  countManagerTourRowsByBucket,
  filterManagerTourRows,
  sortManagerTourClustersForBucket,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";
import {
  MANAGER_TOUR_BUCKET_LABELS,
  MANAGER_TOUR_BUCKETS,
  managerTourDetailHref,
  type ManagerTourBucketId,
} from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";

const PROPERTY_TOUR_BUCKET_LABELS = MANAGER_TOUR_BUCKETS.map((id) => ({
  id,
  label: MANAGER_TOUR_BUCKET_LABELS[id],
}));

export function ManagerPropertyTourPanel({
  listingId,
  managerUserId,
  propertyLabel,
  showToast,
  onRegisterSendTour,
}: {
  listingId: string;
  managerUserId: string | null;
  propertyLabel: string;
  /**
   * REQUIRED: this panel publishes availability, so it must be able to tell the
   * manager when its conflict overlay is incomplete. Optional, it could be
   * dropped by a new call site and the warning would vanish silently.
   */
  showToast: (message: string) => void;
  /** Parent header "Send tour link" — same handler as the former section footer button. */
  onRegisterSendTour?: (openSendTour: (() => void) | null) => void;
}) {
  const navigate = usePortalNavigate();
  const [sendTourOpen, setSendTourOpen] = useState(false);
  const [bucket, setBucket] = useState<ManagerTourBucketId>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [tick, setTick] = useState(0);
  const { reminders, reload: reloadReminders } = useScheduledTourReminders();

  const openSendTour = useCallback(() => setSendTourOpen(true), []);

  useEffect(() => {
    onRegisterSendTour?.(openSendTour);
    return () => onRegisterSendTour?.(null);
  }, [onRegisterSendTour, openSendTour]);

  const refresh = useCallback(async () => {
    await syncScheduleRecordsFromServer({ force: true });
    await reloadReminders();
    setTick((n) => n + 1);
  }, [reloadReminders]);

  useEffect(() => {
    if (!managerUserId) return;
    void refresh();
  }, [managerUserId, refresh]);

  useEffect(() => {
    const onStorage = () => setTick((n) => n + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const storageKey = useMemo(() => {
    if (!managerUserId || !listingId) return null;
    return managerPropertyAvailabilityStorageKey(managerUserId, listingId);
  }, [managerUserId, listingId]);

  const shareProperties = useMemo<ManagerPropertyFilterOption[]>(
    () => [{ id: listingId, label: propertyLabel }],
    [listingId, propertyLabel],
  );

  const allRows = useMemo(() => {
    void tick;
    if (!managerUserId) return [];
    return buildManagerTourRows({
      viewerUserId: managerUserId,
      propertyIds: [listingId],
    });
  }, [tick, managerUserId, listingId]);

  const counts = useMemo(() => countManagerTourRowsByBucket(allRows), [allRows]);

  const rowsForBucket = useMemo(
    () => filterManagerTourRows(allRows, bucket, [], searchQuery),
    [allRows, bucket, searchQuery],
  );

  const clusters = useMemo(
    () =>
      sortManagerTourClustersForBucket(clusterManagerTourListRows(rowsForBucket), bucket),
    [rowsForBucket, bucket],
  );

  const tabs = useMemo(
    () =>
      PROPERTY_TOUR_BUCKET_LABELS.map(({ id, label }) => ({
        id,
        label,
        count: counts[id],
        alert: id === "pending" && counts.pending > 0,
        dataAttr: `property-tours-bucket-${id}`,
      })),
    [counts],
  );

  const openTourDetail = useCallback(
    (row: ManagerTourRow) => {
      navigate(managerTourDetailHref("/portal", bucket, row.id));
    },
    [bucket, navigate],
  );

  const googleBusyMeetings = useGoogleCalendarBusyMeetings({
    enabled: Boolean(managerUserId),
    onWarning: ({ warning, hint }) => {
      if (!isGoogleBusyIncompleteWarning(warning)) return;
      showToast(
        hint ??
          "PropLane could not load all your Google Calendar busy time, so this grid may be missing conflicts.",
      );
    },
  });

  return (
    <>
      <PortalPropertyDetailSection>
        <PortalListControlStack
          className="mb-3"
          destinationRow={
            <LocalDestinationNav
              items={tabs}
              activeId={bucket}
              onChange={(id) => setBucket(id as ManagerTourBucketId)}
              ariaLabel="Tour status"
              className="max-w-none"
            />
          }
          search={{
            value: searchQuery,
            onChange: setSearchQuery,
            placeholder: "Search tours",
            dataAttr: "property-tours-search",
          }}
        />

        {bucket === "pending" ? <TourProposalsPanel /> : null}

        {!managerUserId ? (
          <p className="text-sm text-muted">Sign in to view tours for this property.</p>
        ) : rowsForBucket.length === 0 ? (
          <PortalDataTableEmpty
            message={
              bucket === "pending"
                ? "No pending tour requests"
                : bucket === "upcoming"
                  ? "No upcoming tours"
                  : "No past tours"
            }
          />
        ) : (
          <ManagerToursGroupedTable
            clusters={clusters}
            reminders={reminders}
            selectedIds={new Set()}
            onToggleSelected={() => {}}
            onRowClick={openTourDetail}
            showPropertyColumn={false}
            selectable={false}
          />
        )}
      </PortalPropertyDetailSection>

      <PortalPropertyDetailSection>
        <PortalCollapsibleSection
          title="Tour availability"
          subtitle="Open slots prospects can book for this property"
          defaultExpanded={false}
          toggleDataAttr="property-tour-availability-toggle"
          bareSurface
        >
          <PortalCalendarPanels
            key={storageKey ?? "property-calendar-unavailable"}
            storageKey={storageKey}
            bareSurface
            compactAvailability
            flowScroll
            defaultViewMode="week"
            availabilityHeading="Your availability"
            tourScopeLabel={propertyLabel}
            unavailableMessage="Sign in to manage tour availability for this property."
            externalMeetings={googleBusyMeetings}
            scheduledTourFilter={
              managerUserId
                ? {
                    viewerUserId: managerUserId,
                    propertyId: listingId,
                    peers: [],
                  }
                : undefined
            }
          />
        </PortalCollapsibleSection>
      </PortalPropertyDetailSection>

      <ShareLeadLinkModal
        open={sendTourOpen}
        onClose={() => setSendTourOpen(false)}
        kind="tour"
        properties={shareProperties}
        preselectedPropertyId={listingId}
      />
    </>
  );
}
