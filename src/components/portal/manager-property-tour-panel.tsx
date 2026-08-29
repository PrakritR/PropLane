"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ManagerToursGroupedTable } from "@/components/portal/manager-tours-grouped-table";
import { PortalCalendarPanels } from "@/components/portal/portal-calendar-panels";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPropertyDetailSection } from "@/components/portal/portal-property-detail-section";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { managerPropertyAvailabilityStorageKey, syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  DEFAULT_MANAGER_TOUR_SETTINGS,
  managerTourSettingsToDefaultAvailability,
  type ManagerTourSettings,
} from "@/lib/manager-tour-settings";
import {
  isGoogleBusyIncompleteWarning,
  useGoogleCalendarBusyMeetings,
} from "@/hooks/use-google-calendar-busy";
import {
  buildManagerTourRows,
  clusterManagerTourListRows,
  countManagerTourRowsByBucket,
  filterManagerTourRows,
  sortManagerTourClustersForBucket,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
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
  onRegisterSetAvailability,
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
  /** Parent footer "Set availability" — opens the block-schedule modal. */
  onRegisterSetAvailability?: (openAvailability: (() => void) | null) => void;
}) {
  const navigate = usePortalNavigate();
  const [sendTourOpen, setSendTourOpen] = useState(false);
  const [availabilityOpen, setAvailabilityOpen] = useState(false);
  const [availabilityModalFooter, setAvailabilityModalFooter] = useState<ReactNode>(null);
  const [bucket, setBucket] = useState<ManagerTourBucketId>("pending");
  const [searchQuery, setSearchQuery] = useState("");
  const [tick, setTick] = useState(0);
  const [tourSettings, setTourSettings] = useState<ManagerTourSettings>(DEFAULT_MANAGER_TOUR_SETTINGS);

  const loadTourSettings = useCallback(async () => {
    if (!managerUserId || isDemoModeActive()) {
      setTourSettings(DEFAULT_MANAGER_TOUR_SETTINGS);
      return;
    }
    try {
      const res = await fetch("/api/portal/manager-tour-settings", {
        credentials: "include",
        cache: "no-store",
      });
      const body = (await res.json().catch(() => ({}))) as { settings?: ManagerTourSettings };
      if (res.ok && body.settings) setTourSettings(body.settings);
    } catch {
      /* keep prior */
    }
  }, [managerUserId]);

  useEffect(() => {
    void loadTourSettings();
  }, [loadTourSettings]);

  const defaultTourAvailability = useMemo(
    () => managerTourSettingsToDefaultAvailability(tourSettings),
    [tourSettings],
  );

  const openSendTour = useCallback(() => setSendTourOpen(true), []);
  const openAvailability = useCallback(() => setAvailabilityOpen(true), []);
  const handleAvailabilityModalFooterChange = useCallback((footer: ReactNode | null) => {
    setAvailabilityModalFooter(footer);
  }, []);

  useEffect(() => {
    onRegisterSendTour?.(openSendTour);
    return () => onRegisterSendTour?.(null);
  }, [onRegisterSendTour, openSendTour]);

  useEffect(() => {
    onRegisterSetAvailability?.(openAvailability);
    return () => onRegisterSetAvailability?.(null);
  }, [onRegisterSetAvailability, openAvailability]);

  const refresh = useCallback(async () => {
    await syncScheduleRecordsFromServer({ force: true });
    setTick((n) => n + 1);
  }, []);

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

  // This is the screen where a manager PUBLISHES tour availability, so it has to
  // show the conflicts that availability would collide with. It used to render
  // no busy overlay at all while /portal/calendar showed the same half hour as
  // "Blocked" — a slot you could publish straight on top of (F-CAL-6).
  //
  // It therefore has to say when the overlay is INCOMPLETE — truncated, or a
  // read that failed — because a manager who reached this panel from Properties
  // may never open /portal/calendar, and an incomplete grid is indistinguishable
  // from a free one. The connection-SETUP warnings (not connected, OAuth not
  // configured, API disabled) stay with the portfolio calendar so the same
  // account-level problem is not toasted twice.
  //
  // KNOWN, ACCEPTED consequence (ticket `axis-busy-time-advisory-availability`):
  // `renderSlotButton` bails on any cell a meeting covers, so a busy half hour is
  // not just marked — it is non-selectable, and the manager cannot publish
  // availability over a personal Google event. As of F-CAL-6 that is true on BOTH
  // manager calendars, the portfolio one at /portal/calendar and this per-property
  // one; it is the pre-existing portfolio behaviour now applied consistently, not
  // a restriction unique to this screen.
  //
  // The OPEN product question that ticket holds is whether a manager may
  // deliberately publish tour availability OVER their own busy time — i.e. whether
  // Google busy should be advisory (marked, still selectable) rather than blocking.
  // Answering it yes is a product change and must land on both calendars at once,
  // never on this one alone.
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
            selectedIds={new Set()}
            onToggleSelected={() => {}}
            onRowClick={openTourDetail}
            showPropertyColumn={false}
            selectable={false}
          />
        )}
      </PortalPropertyDetailSection>

      <Modal
        open={availabilityOpen}
        title="Set availability"
        onClose={() => {
          setAvailabilityOpen(false);
          setAvailabilityModalFooter(null);
        }}
        scrollableContent={false}
        // A seven-day grid does not fit in max-w-3xl — Sunday was clipped off the right edge with
        // no way to scroll to it. Wider, and capped in height so the grid scrolls inside the panel
        // instead of the panel growing past the viewport.
        panelClassName="max-w-6xl"
        footer={
          availabilityModalFooter ? (
            <ModalFooter className="justify-start">{availabilityModalFooter}</ModalFooter>
          ) : undefined
        }
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <p className="mb-3 shrink-0 text-xs text-muted">
            Tour availability for this property. Click an empty slot or drag across a range, then confirm in
            the schedule dialog. Use Add availability for a recurring block.
          </p>
          <PortalCalendarPanels
            inlineFooter
            delegateFooterToModal
            embeddedInModal
            onModalFooterChange={handleAvailabilityModalFooterChange}
            key={storageKey ?? "property-calendar-unavailable"}
            storageKey={storageKey}
            bareSurface
            compactAvailability
            defaultViewMode="week"
            availabilityHeading="Tour availability"
            defaultTourAvailability={defaultTourAvailability}
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
        </div>
      </Modal>

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
