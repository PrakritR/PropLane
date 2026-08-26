"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DestinationNav } from "@/components/ui/destination-nav";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
import {
  MANAGER_TABLE_TH,
  ManagerPortalPageShell,
  PORTAL_HEADER_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  PORTAL_DATA_TABLE,
  PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_LIST_PAGE_BODY,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PortalDataTableEmpty,
} from "@/components/portal/portal-data-table";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { TourProposalsPanel } from "@/components/portal/tour-proposals-panel";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  acceptPartnerInquiryFromServer,
  deletePartnerInquiryFromServer,
  syncScheduleRecordsFromServer,
} from "@/lib/demo-admin-scheduling";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { buildManagerPropertyFilterOptions } from "@/lib/manager-portfolio-access";
import {
  buildManagerTourRows,
  countManagerTourRowsByBucket,
  filterManagerTourRows,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";
import {
  MANAGER_TOUR_BUCKET_LABELS,
  MANAGER_TOUR_BUCKETS,
  managerTourListHref,
  type ManagerTourBucketId,
} from "@/lib/portal-detail-routes";
import { cancelPlannedTourFromServer } from "@/lib/tour-planned-change.client";

const TOUR_BUCKET_LABELS = MANAGER_TOUR_BUCKETS.map((id) => ({
  id,
  label: MANAGER_TOUR_BUCKET_LABELS[id],
}));

function tourStatusTone(row: ManagerTourRow): "pending" | "success" | "neutral" {
  if (row.bucket === "pending") return "pending";
  if (row.statusLabel === "Declined") return "neutral";
  return "success";
}

export function ManagerTours({
  bucket = "pending",
  basePath = "/portal",
}: {
  bucket?: ManagerTourBucketId;
  basePath?: string;
}) {
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const [tick, setTick] = useState(0);
  const [propertyTick, setPropertyTick] = useState(0);
  const [propertyFilters, setPropertyFilters] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [shareTourOpen, setShareTourOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    await syncScheduleRecordsFromServer({ force: true });
    setTick((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!authReady || !userId) return;
    void syncPropertyPipelineFromServer().then(() => setPropertyTick((n) => n + 1));
    void refresh();
  }, [authReady, userId, refresh]);

  useEffect(() => {
    const onStorage = () => setTick((n) => n + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const propertyOptions = useMemo(
    () => buildManagerPropertyFilterOptions(userId),
    [userId, propertyTick],
  );

  const propertyLabelById = useMemo(
    () => new Map(propertyOptions.map((option) => [option.id, option.label])),
    [propertyOptions],
  );

  const shareableProperties = propertyOptions;

  const allRows = useMemo(() => {
    void tick;
    if (!userId) return [];
    return buildManagerTourRows({
      viewerUserId: userId,
      propertyIds: propertyOptions.map((option) => option.id),
    });
  }, [tick, userId, propertyOptions]);

  const counts = useMemo(() => countManagerTourRowsByBucket(allRows), [allRows]);

  const rowsForBucket = useMemo(
    () => filterManagerTourRows(allRows, bucket, propertyFilters, searchQuery),
    [allRows, bucket, propertyFilters, searchQuery],
  );

  const tabs = useMemo(
    () =>
      TOUR_BUCKET_LABELS.map(({ id, label }) => ({
        id,
        label,
        count: counts[id],
        alert: id === "pending" && counts.pending > 0,
      })),
    [counts],
  );

  const filterTouchCount = propertyFilters.length > 0 ? 1 : 0;

  const filterSheet = (
    <PortalFilterSortSheet
      activeCount={filterTouchCount}
      compactPanel
      filterFieldCount={1}
      mobileFlushBody
      constrainDropdownToTitleBand
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
      onReset={() => setPropertyFilters([])}
      dataAttr="tours-filter-sheet-open"
    >
      <ApplicationFilterSortFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        dataAttr="tours-filter-property"
      />
    </PortalFilterSortSheet>
  );

  const activeFilterChips =
    propertyFilters.length > 0 ? (
      <PortalActiveFilterChips
        chips={[
          {
            id: "property",
            label:
              propertyFilters.length === 1
                ? `Property: ${propertyLabelById.get(propertyFilters[0]!) ?? propertyFilters[0]}`
                : `${propertyFilters.length} properties`,
            onRemove: () => setPropertyFilters([]),
          },
        ]}
      />
    ) : null;

  async function approveTour(row: ManagerTourRow) {
    if (!userId || row.source !== "inquiry") return;
    setBusyId(row.id);
    try {
      const result = await acceptPartnerInquiryFromServer(row.sourceId, {
        start: row.startIso,
        end: row.endIso,
        notifyTenant: true,
      });
      if (!result.ok) {
        showToast(result.error ?? "Could not confirm tour.");
        return;
      }
      await refresh();
      showToast("Tour confirmed.");
    } finally {
      setBusyId(null);
    }
  }

  async function declineTour(row: ManagerTourRow) {
    if (!userId || row.source !== "inquiry") return;
    setBusyId(row.id);
    try {
      const ok = await deletePartnerInquiryFromServer(row.sourceId, { notifyTenant: true });
      if (!ok) {
        showToast("Could not decline tour request.");
        return;
      }
      await refresh();
      showToast("Tour request declined.");
    } finally {
      setBusyId(null);
    }
  }

  async function cancelTour(row: ManagerTourRow) {
    if (!userId || row.source !== "planned") return;
    setBusyId(row.id);
    try {
      const result = await cancelPlannedTourFromServer({
        plannedEventId: row.sourceId,
        notifyGuest: true,
      });
      if (!result.ok) {
        showToast(result.error ?? "Could not cancel tour.");
        return;
      }
      await refresh();
      showToast("Tour cancelled.");
    } finally {
      setBusyId(null);
    }
  }

  function rowSubtitle(row: ManagerTourRow): string {
    return [row.propertyTitle, row.roomLabel].filter(Boolean).join(" · ");
  }

  return (
    <ManagerPortalPageShell
      title="Tours"
      hideTitleOnMobileNav
      titleInlineFilter={filterSheet}
      compactFilterRow
      titleAside={
        <>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_HEADER_ACTION_BTN}
            data-attr="tours-settings-open"
            onClick={() => setSettingsOpen(true)}
          >
            Settings
          </Button>
          <Button
            type="button"
            variant="outline"
            className={PORTAL_HEADER_ACTION_BTN}
            disabled={shareableProperties.length === 0}
            data-attr="tours-share-open"
            onClick={() => setShareTourOpen(true)}
          >
            Share tour
          </Button>
        </>
      }
    >
      <PortalListControlStack
        className="mb-2"
        destinationRow={
          <DestinationNav
            items={tabs.map((tab) => ({
              id: tab.id,
              label: tab.label,
              href: managerTourListHref(basePath, tab.id),
              count: tab.count,
              alert: tab.alert,
              dataAttr: `tours-bucket-${tab.id}`,
            }))}
            activeId={bucket}
            ariaLabel="Tour status"
            itemLayout="equal"
            denseEqualRow
            className="max-w-none"
          />
        }
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: "Search tours",
          dataAttr: "tours-search",
        }}
        activeFilterChips={activeFilterChips}
      />

      <div className={PORTAL_LIST_PAGE_BODY}>
        {bucket === "pending" ? <TourProposalsPanel /> : null}

        {!authReady ? (
          <p className="text-sm text-muted">Loading tours…</p>
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
          <div className={PORTAL_DATA_TABLE_WRAP}>
            <div className={PORTAL_DATA_TABLE_SCROLL}>
              <table className={PORTAL_DATA_TABLE}>
                <thead>
                  <tr className={PORTAL_TABLE_HEAD_ROW}>
                    <th className={MANAGER_TABLE_TH}>Guest</th>
                    <th className={`${MANAGER_TABLE_TH} hidden md:table-cell`}>Property</th>
                    <th className={MANAGER_TABLE_TH}>When</th>
                    <th className={`${MANAGER_TABLE_TH} hidden sm:table-cell`}>Status</th>
                    <th className={`${MANAGER_TABLE_TH} text-right`}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rowsForBucket.map((row) => (
                    <tr key={row.id} className="border-b border-border last:border-0">
                      <td className={PORTAL_TABLE_TD}>
                        <div className="font-semibold text-foreground">{row.guestName}</div>
                        {row.guestEmail ? <div className="text-xs text-muted">{row.guestEmail}</div> : null}
                        <div className="mt-2 md:hidden">
                          <div className="text-xs text-muted">{rowSubtitle(row)}</div>
                          <Badge tone={tourStatusTone(row)} className="mt-1">
                            {row.statusLabel}
                          </Badge>
                        </div>
                      </td>
                      <td className={`${PORTAL_TABLE_TD} hidden md:table-cell`}>
                        <div>{row.propertyTitle}</div>
                        {row.roomLabel ? <div className="text-xs text-muted">{row.roomLabel}</div> : null}
                      </td>
                      <td className={PORTAL_TABLE_TD}>
                        <div className="text-sm">{row.whenLabel}</div>
                      </td>
                      <td className={`${PORTAL_TABLE_TD} hidden sm:table-cell`}>
                        <Badge tone={tourStatusTone(row)}>{row.statusLabel}</Badge>
                      </td>
                      <td className={`${PORTAL_TABLE_TD} text-right`}>
                        <div className="flex flex-wrap justify-end gap-2">
                          {row.bucket === "pending" ? (
                            <>
                              <Button
                                type="button"
                                variant="outline"
                                className="h-8 min-h-0 px-3 text-[13px]"
                                disabled={busyId === row.id}
                                data-attr="tour-approve"
                                onClick={() => void approveTour(row)}
                              >
                                Approve
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                className="h-8 min-h-0 px-3 text-[13px] text-rose-800"
                                disabled={busyId === row.id}
                                data-attr="tour-decline"
                                onClick={() => void declineTour(row)}
                              >
                                Decline
                              </Button>
                            </>
                          ) : row.bucket === "upcoming" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              className="h-8 min-h-0 px-3 text-[13px] text-rose-800"
                              disabled={busyId === row.id}
                              data-attr="tour-cancel"
                              onClick={() => void cancelTour(row)}
                            >
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <ShareLeadLinkModal
        open={shareTourOpen}
        onClose={() => setShareTourOpen(false)}
        kind="tour"
        properties={shareableProperties}
      />
      <ManagerPortalSettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} initialTab="calendar" />
    </ManagerPortalPageShell>
  );
}
