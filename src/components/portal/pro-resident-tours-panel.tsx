"use client";

import { type ReactNode, useEffect, useMemo, useState } from "react";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ManagerToursGroupedTable } from "@/components/portal/pro-tours-grouped-table";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { syncScheduleRecordsFromServer } from "@/lib/demo-admin-scheduling";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { type ManagerTourBucketId } from "@/lib/portal-detail-routes";
import {
  buildManagerTourRows,
  clusterManagerTourListRows,
  countManagerTourRowsByBucket,
  filterManagerTourRows,
  sortManagerTourRowsForBucket,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";

const RESIDENT_TOUR_TABS: { id: ManagerTourBucketId; label: string; dataAttr: string }[] = [
  { id: "pending", label: "Scheduled", dataAttr: "resident-tour-bucket-pending" },
  { id: "upcoming", label: "Upcoming", dataAttr: "resident-tour-bucket-upcoming" },
  { id: "past", label: "Past", dataAttr: "resident-tour-bucket-past" },
];

function ResidentTourDetailPanel({ row }: { row: ManagerTourRow }) {
  return (
    <div className="space-y-4 px-3 py-2 text-sm sm:px-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-medium text-muted">When</p>
          <p className="text-foreground">{row.whenLabel}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Status</p>
          <p className="font-medium text-foreground">{row.statusLabel}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-muted">Property</p>
          <p className="text-foreground">{row.propertyTitle || "—"}</p>
        </div>
        {row.roomLabel ? (
          <div>
            <p className="text-xs font-medium text-muted">Room</p>
            <p className="text-foreground">{row.roomLabel}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ManagerResidentToursPanel({
  managerUserId,
  residentEmail,
  residentName,
  bucket = "pending",
  tourId,
  buildTourDetailHref,
  buildTourListHref,
  propertyIds,
  sectionToolbar,
}: {
  managerUserId: string | null;
  residentEmail: string;
  residentName: string;
  bucket?: ManagerTourBucketId;
  tourId?: string;
  buildTourDetailHref?: (row: ManagerTourRow) => string;
  buildTourListHref?: (bucket: ManagerTourBucketId) => string;
  propertyIds?: string[];
  /**
   * The section's header card (title · icon actions). The panel hands it the Scheduled · Upcoming ·
   * Past tabs as `destinationRow`, so the tabs sit inside that one card.
   */
  sectionToolbar?: (destinationRow: ReactNode) => ReactNode;
}) {
  const navigate = usePortalNavigate();
  const normalizedEmail = residentEmail.trim().toLowerCase();
  const [tick, setTick] = useState(0);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!managerUserId) return;
    void syncScheduleRecordsFromServer({ force: true }).then(() => setTick((n) => n + 1));
  }, [managerUserId]);

  useEffect(() => {
    const onStorage = () => setTick((n) => n + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const allRows = useMemo(() => {
    if (!managerUserId || !normalizedEmail.includes("@")) return [];
    return buildManagerTourRows({ viewerUserId: managerUserId, propertyIds: propertyIds ?? null }).filter(
      (row) => row.guestEmail?.trim().toLowerCase() === normalizedEmail,
    );
  }, [managerUserId, normalizedEmail, propertyIds, tick]);

  const bucketCounts = useMemo(() => countManagerTourRowsByBucket(allRows), [allRows]);

  const rows = useMemo(
    () =>
      sortManagerTourRowsForBucket(filterManagerTourRows(allRows, bucket, [], search.trim()), bucket),
    [allRows, bucket, search],
  );

  const detailRow = useMemo(() => {
    if (!tourId) return null;
    const decoded = decodeURIComponent(tourId);
    return allRows.find((row) => row.id === decoded) ?? null;
  }, [allRows, tourId]);

  const clusters = useMemo(() => clusterManagerTourListRows(rows), [rows]);

  if (!managerUserId) {
    return <p className="text-sm text-muted">Sign in to view tours.</p>;
  }

  if (tourId && detailRow) {
    return <ResidentTourDetailPanel row={detailRow} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {(() => {
        const statusTabs = (
          <LocalDestinationNav
            items={RESIDENT_TOUR_TABS.map((tab) => ({
              id: tab.id,
              label: tab.label,
              count: bucketCounts[tab.id],
              dataAttr: tab.dataAttr,
            }))}
            activeId={bucket}
            onChange={(id) => {
              if (buildTourListHref) navigate(buildTourListHref(id as ManagerTourBucketId));
            }}
            ariaLabel="Tour status"
            appearance="command"
            className="w-full"
          />
        );
        return sectionToolbar ? sectionToolbar(statusTabs) : statusTabs;
      })()}
      <PortalListControlStack
        variant="command"
        className="plp-header-card mb-0"
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search tours",
          dataAttr: "resident-tours-search",
        }}
      />
      <PortalRecordListSurface isEmpty={rows.length === 0} className="mt-0">
        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">No tours.</p>
        ) : (
          <ManagerToursGroupedTable
            clusters={clusters}
            groupMode="resident"
            showPropertyColumn
            onRowClick={(row) => {
              if (buildTourDetailHref) navigate(buildTourDetailHref(row));
            }}
          />
        )}
      </PortalRecordListSurface>
    </div>
  );
}
