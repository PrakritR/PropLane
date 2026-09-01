"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { ResidentPortalDataList } from "@/components/portal/resident-portal-data-list";
import { ResidentPortalListBottomBar } from "@/components/portal/resident-portal-list-bottom-bar";
import {
  residentDocumentsDownloadAction,
  residentDocumentsOpenAction,
  useResidentDocumentSelection,
} from "@/components/portal/resident-documents-bulk";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  ResidentPortalGroupedDataList,
  type ResidentPortalGroupableRow,
} from "@/components/portal/resident-portal-grouped-data-list";
import type { PortalListGroupMode } from "@/lib/portal-list-grouping";
import {
  RESIDENT_LEASE_LIST_LABEL,
  residentLeaseDetailSubtitle,
} from "@/components/portal/resident-lease-document-preview";
import { usePortalSession } from "@/hooks/use-portal-session";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  LEASE_PIPELINE_EVENT,
  findLeaseForResidentEmail,
  residentLeaseAuthorized,
  runLeaseDownload,
  syncLeasePipelineFromServer,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  resolveResidentPortalAxisId,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import { getPropertyById } from "@/lib/rental-application/data";
import {
  buildResidentLeaseDocumentRows,
  filterResidentLeaseDocumentRows,
  residentLeaseStatusFilterTabs,
  type ResidentLeaseDocumentRow,
  type ResidentLeaseStatusFilter,
} from "@/lib/resident-lease-documents";
import {
  residentDocumentsLeaseDetailHref,
  residentLeaseDetailHref,
  type ResidentLeaseBucketId,
} from "@/lib/portal-detail-routes";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import { safeFormatDateTime } from "@/lib/pacific-time";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function useResidentLeasePipelineRow(): LeasePipelineRow | null {
  const session = usePortalSession();
  const email = session.email?.trim().toLowerCase() ?? "";
  const userId = session.userId ?? null;
  const [tick, setTick] = useState(0);
  const [residentAxisId, setResidentAxisId] = useState<string | null>(null);
  const [profileManagerId, setProfileManagerId] = useState<string | null>(null);
  const [axisResolved, setAxisResolved] = useState(false);

  useEffect(() => {
    const on = () => setTick((value) => value + 1);
    void syncLeasePipelineFromServer().then(on);
    window.addEventListener(LEASE_PIPELINE_EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(LEASE_PIPELINE_EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);

  useEffect(() => {
    if (!email) {
      queueMicrotask(() => {
        setResidentAxisId(null);
        setProfileManagerId(null);
        setAxisResolved(true);
      });
      return;
    }

    let cancelled = false;
    void (async () => {
      const matchingApplication = readManagerApplicationRows()
        .filter((row) => row.email?.trim().toLowerCase() === email)
        .sort((a, b) => {
          const aTs =
            (a.application as { submittedAt?: string } | undefined)?.submittedAt?.trim() ?? "";
          const bTs =
            (b.application as { submittedAt?: string } | undefined)?.submittedAt?.trim() ?? "";
          return bTs.localeCompare(aTs);
        })[0];

      await syncManagerApplicationsFromServer({ selfScope: true }).catch(() => undefined);

      const supabase = createSupabaseBrowserClient();
      const { data: profile } = await supabase
        .from("profiles")
        .select("manager_id")
        .eq("id", userId ?? "")
        .maybeSingle();

      if (cancelled) return;
      setResidentAxisId(resolveResidentPortalAxisId({ applicationRowId: matchingApplication?.id }));
      setProfileManagerId(typeof profile?.manager_id === "string" ? profile.manager_id : null);
      setAxisResolved(true);
    })();

    const onApps = () => setTick((value) => value + 1);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, onApps);
    return () => {
      cancelled = true;
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, onApps);
    };
  }, [email, userId]);

  return useMemo(() => {
    void tick;
    if (!email || !axisResolved) return null;
    const row = findLeaseForResidentEmail(email, {
      email,
      residentAxisId,
      profileManagerId,
    });
    if (!row) return null;
    if (!residentLeaseAuthorized(row, { email, residentAxisId, profileManagerId })) return null;
    return row;
  }, [axisResolved, email, profileManagerId, residentAxisId, tick]);
}

function leaseDocumentPropertyFields(
  entry: ResidentLeaseDocumentRow,
  fallbackPipelineRow: LeasePipelineRow | null,
): { propertyId: string; propertyLabel: string } {
  const row = entry.pipelineRow ?? fallbackPipelineRow;
  const propertyId = row?.propertyId?.trim() || row?.application?.propertyId?.trim() || "";
  return {
    propertyId,
    propertyLabel: leaseDocumentPropertyLabel(row),
  };
}

function filterLeaseRowsByProperty(
  rows: ResidentLeaseDocumentRow[],
  pipelineRow: LeasePipelineRow | null,
  propertyFilters: string[],
): ResidentLeaseDocumentRow[] {
  if (propertyFilters.length === 0) return rows;
  const allowed = new Set(propertyFilters);
  return rows.filter((entry) => {
    const { propertyId } = leaseDocumentPropertyFields(entry, pipelineRow);
    return allowed.has(propertyId);
  });
}
function leaseDocumentPropertyLabel(pipelineRow: LeasePipelineRow | null): string {
  if (!pipelineRow) return "—";
  const propertyId = pipelineRow.propertyId ?? pipelineRow.application?.propertyId ?? "";
  const title = propertyId ? getPropertyById(propertyId)?.title?.trim() : "";
  if (title) return title;
  const unit = pipelineRow.unit?.trim();
  return unit && unit !== "—" ? unit : "—";
}

function resolveLeaseDetailHref(
  basePath: string,
  entry: ResidentLeaseDocumentRow,
  detailHref: (basePath: string, bucket: ResidentLeaseBucketId, leaseDetailId: string) => string,
  routePendingToLeaseSection: boolean,
  bucket?: ResidentLeaseBucketId,
): string {
  if (routePendingToLeaseSection && entry.filterBucket === "pending") {
    return residentLeaseDetailHref(RESIDENT_PORTAL_BASE_PATH, "pending", entry.id);
  }
  if (bucket) {
    return detailHref(basePath, bucket, entry.id);
  }
  return detailHref(basePath, entry.filterBucket, entry.id);
}

export function ResidentLeaseListTable({
  basePath,
  bucket,
  detailHref,
  emptyMessage = "Your lease will appear here once your manager sends it for review.",
  routePendingToLeaseSection = false,
  statusFilter,
  selectable = false,
  selectedIds,
  onToggleSelected,
  documentsListSurface = false,
  groupMode = "house",
  propertyFilters = [],
}: {
  basePath: string;
  bucket?: ResidentLeaseBucketId;
  detailHref: (basePath: string, bucket: ResidentLeaseBucketId, leaseDetailId: string) => string;
  emptyMessage?: string;
  routePendingToLeaseSection?: boolean;
  /** Documents tab only — when set, overrides `bucket`. */
  statusFilter?: ResidentLeaseStatusFilter;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  /** Portal record list + floating bulk bar (Documents tab). */
  documentsListSurface?: boolean;
  groupMode?: PortalListGroupMode;
  propertyFilters?: string[];
}) {
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const pipelineRow = useResidentLeasePipelineRow();
  const documentRows = useMemo(() => {
    const rows = buildResidentLeaseDocumentRows(pipelineRow);
    const filtered =
      statusFilter != null
        ? filterResidentLeaseDocumentRows(rows, statusFilter)
        : bucket
          ? filterResidentLeaseDocumentRows(rows, bucket)
          : rows;
    return filterLeaseRowsByProperty(filtered, pipelineRow, propertyFilters);
  }, [bucket, pipelineRow, propertyFilters, statusFilter]);

  const leaseDetailPath = useCallback(
    (entry: ResidentLeaseDocumentRow) =>
      resolveLeaseDetailHref(basePath, entry, detailHref, routePendingToLeaseSection, bucket),
    [basePath, bucket, detailHref, routePendingToLeaseSection],
  );

  const openLease = useCallback(
    (entry: ResidentLeaseDocumentRow) => {
      navigate(leaseDetailPath(entry));
    },
    [leaseDetailPath, navigate],
  );

  const rowIds = useMemo(() => documentRows.map((row) => row.id), [documentRows]);
  const internalSelection = useResidentDocumentSelection(documentsListSurface ? rowIds : []);
  const activeSelectedIds = documentsListSurface ? internalSelection.selectedIds : selectedIds;
  const activeToggleSelected = documentsListSurface
    ? internalSelection.toggleSelected
    : onToggleSelected;

  const selectedEntries = useMemo(
    () => documentRows.filter((row) => activeSelectedIds?.has(row.id)),
    [activeSelectedIds, documentRows],
  );
  const singleSelected = selectedEntries.length === 1 ? selectedEntries[0]! : null;

  const bulkActions = useMemo(() => {
    if (!documentsListSurface || !activeSelectedIds || activeSelectedIds.size === 0) return [];
    const actions = [];
    if (singleSelected) {
      const downloadTarget = singleSelected.pipelineRow ?? pipelineRow;
      actions.push(
        residentDocumentsOpenAction(
          "Open",
          () => openLease(singleSelected),
          "resident-documents-lease-open",
        ),
        residentDocumentsDownloadAction(
          "Download",
          () => {
            if (downloadTarget) runLeaseDownload(downloadTarget, showToast);
            else showToast("Lease document is not ready to download yet.");
          },
          "resident-documents-lease-download",
          !downloadTarget,
        ),
      );
    }
    return actions;
  }, [
    activeSelectedIds,
    documentsListSurface,
    openLease,
    pipelineRow,
    showToast,
    singleSelected,
  ]);

  const groupedItems = useMemo((): ResidentPortalGroupableRow<ResidentLeaseDocumentRow>[] => {
    return documentRows.map((entry) => {
      const statusLabel = entry.status;
      const metaLabel = residentLeaseDetailSubtitle(statusLabel, safeFormatDateTime(entry.signedAt));
      const { propertyId, propertyLabel } = leaseDocumentPropertyFields(entry, pipelineRow);
      const showPropertyInMeta = groupMode !== "house";
      return {
        id: entry.id,
        propertyId,
        propertyLabel,
        dataListRow: {
          id: entry.id,
          data: entry,
          primary: RESIDENT_LEASE_LIST_LABEL,
          meta: [showPropertyInMeta ? propertyLabel : null, metaLabel].filter(Boolean).join(" · "),
          trailing: <span className="text-xs text-muted">{statusLabel}</span>,
          onClick: () => openLease(entry),
        },
      };
    });
  }, [documentRows, groupMode, openLease, pipelineRow]);

  if (documentRows.length === 0) {
    const bucketLabel = bucket === "signed" ? "signed" : "pending";
    return (
      // Inside the house body like the populated list, so the tab does not
      // change its gutters just because the resident has no lease yet.
      <div className={PORTAL_LIST_PAGE_BODY}>
        <PortalDataTableEmpty
          icon="lease"
          message={
            bucket || statusFilter
              ? `No ${statusFilter && statusFilter !== "all" ? statusFilter : bucketLabel} leases yet.`
              : emptyMessage
          }
        />
      </div>
    );
  }

  if (documentsListSurface) {
    return (
      <>
        <div className={PORTAL_LIST_PAGE_BODY} data-attr="resident-documents-lease-list">
          <ResidentPortalDataList
            selectable
            rows={documentRows.map((entry) => {
              const statusLabel = entry.status;
              const metaLabel = residentLeaseDetailSubtitle(statusLabel, safeFormatDateTime(entry.signedAt));
              const { propertyLabel } = leaseDocumentPropertyFields(entry, pipelineRow);
              return {
                id: entry.id,
                data: entry,
                primary: RESIDENT_LEASE_LIST_LABEL,
                meta: [propertyLabel, metaLabel].filter(Boolean).join(" · "),
                trailing: <span className="text-xs font-medium text-muted">{statusLabel}</span>,
                selected: activeSelectedIds?.has(entry.id) ?? false,
                onSelectedChange: () => activeToggleSelected?.(entry.id),
                onClick: () => openLease(entry),
              };
            })}
            columns={[{ id: "lease", header: "Lease", cell: () => "—" }]}
          />
        </div>
        <ResidentPortalListBottomBar
          selectionCount={activeSelectedIds?.size ?? 0}
          selectionActions={bulkActions}
          selectionBarVariant="payments"
        />
      </>
    );
  }

  return (
    <div className={PORTAL_LIST_PAGE_BODY}>
      <ResidentPortalGroupedDataList
        items={groupedItems}
        groupMode={groupMode}
        selectable={selectable}
        selectedIds={selectedIds}
        onToggleSelected={onToggleSelected}
        dataAttr="resident-lease-grouped-list"
        columns={[
          { id: "name", header: "Name", cell: () => RESIDENT_LEASE_LIST_LABEL },
          { id: "status", header: "Status", cell: (row) => row.status },
          {
            id: "property",
            header: "Property",
            cell: (row) => leaseDocumentPropertyFields(row, pipelineRow).propertyLabel,
          },
        ]}
      />
    </div>
  );
}

/** Documents › Lease — in-section All / Pending / Signed pills. */
export function ResidentLeaseDocumentsListSection({ basePath }: { basePath: string }) {
  const pipelineRow = useResidentLeasePipelineRow();
  const allRows = useMemo(() => buildResidentLeaseDocumentRows(pipelineRow), [pipelineRow]);
  const filterTabs = useMemo(() => residentLeaseStatusFilterTabs(allRows), [allRows]);
  const showFilters = filterTabs.some((tab) => tab.id !== "all" && tab.count > 0) && allRows.length > 1;
  const [statusFilter, setStatusFilter] = useState<ResidentLeaseStatusFilter>("all");

  useEffect(() => {
    if (statusFilter === "all") return;
    const active = filterTabs.find((tab) => tab.id === statusFilter);
    if (!active || active.count === 0) {
      queueMicrotask(() => setStatusFilter("all"));
    }
  }, [filterTabs, statusFilter]);

  return (
    <div className="space-y-3">
      {showFilters ? (
        <ManagerPortalStatusPills
          tabs={filterTabs}
          activeId={statusFilter}
          onChange={(id) => setStatusFilter(id as ResidentLeaseStatusFilter)}
          activeTone="monochrome"
          compact
          selectAriaLabel="Lease status"
        />
      ) : null}
      <ResidentLeaseListTable
        basePath={basePath}
        detailHref={(base, _bucket, leaseDetailId) => residentDocumentsLeaseDetailHref(base, leaseDetailId)}
        routePendingToLeaseSection
        statusFilter={statusFilter}
        documentsListSurface
        emptyMessage="Your signed lease will appear here once it's signed."
      />
    </div>
  );
}

export function residentLeaseListMeta(entry: ResidentLeaseDocumentRow): string {
  return [entry.status, safeFormatDateTime(entry.signedAt)].filter(Boolean).join(" · ");
}
