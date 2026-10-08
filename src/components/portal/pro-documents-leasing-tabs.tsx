"use client";
import { RecordActionItems } from "@/components/ui/record-action-menu";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApplicationDocumentPreview,
  downloadApplicationPdf,
} from "@/components/portal/pro-applications";
import { DocumentInlineViewer } from "@/components/portal/resident-other-documents";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { FilterCollapsibleSection, FilterFieldsAccordion, FilterSingleSelectList, filterSingleSelectSummary } from "@/components/portal/filter-field-lists";
import { DataList } from "@/components/ui/data-list";
import { Mail } from "lucide-react";
import { PortalGroupedRecordList } from "@/components/portal/portal-grouped-record-list";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { matchesPortalListSearch } from "@/lib/portal-list-search";
import {
  HOUSE_LIST_DEFAULT_SORT,
  sortHouseListItems,
  type HouseListSort,
} from "@/lib/portal-grouped-list";
import { applicationRowSortMs } from "@/lib/manager-application-list";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { portalEmptyCopy, portalEmptyNoMatchTitle } from "@/lib/portal-empty-copy";
import { Button } from "@/components/ui/button";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import type { DemoApplicantRow, ManagerApplicationBucket } from "@/data/demo-portal";
import { applicantDisplayName, applicantSecondaryEmail } from "@/lib/rental-application/applicant-name";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  MANAGER_PORTFOLIO_REFRESH_EVENTS,
  applicationVisibleToPortalUser,
  leaseVisibleToPortalUser,
} from "@/lib/manager-portfolio-access";
import { syncPropertyPipelineFromServer } from "@/lib/demo-property-pipeline";
import { getRoomChoiceLabel } from "@/lib/rental-application/data";
import { managerDocumentsApplicationDetailHref, managerDocumentsApplicationsListHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { portalDownloadToastMessage } from "@/lib/portal-document-download";
import {
  LEASE_PIPELINE_EVENT,
  runLeaseDownload,
  downloadLeaseFromRow,
  getLeaseDocumentHtml,
  readLeasePipeline,
  syncLeasePipelineFromServer,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { safeFormatDateTime } from "@/lib/pacific-time";

function applicationStatusLabel(bucket: ManagerApplicationBucket): string {
  if (bucket === "approved") return "Approved";
  if (bucket === "rejected") return "Rejected";
  return "Pending review";
}

function applicationRoomLabel(row: DemoApplicantRow): string {
  const roomChoice = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  return getRoomChoiceLabel(roomChoice);
}

function leaseHasDownloadableDocument(row: LeasePipelineRow): boolean {
  return Boolean(row.generatedHtml || row.managerUploadedPdf?.dataUrl);
}

function applicationPropertyId(row: DemoApplicantRow): string {
  return (
    row.assignedPropertyId?.trim() ||
    row.propertyId?.trim() ||
    row.application?.propertyId?.trim() ||
    ""
  );
}


export function LeasingDocumentsPropertyFilterFields({
  propertyFilter,
  onPropertyFilterChange,
  propertyOptions,
  dataAttr,
  fieldLabel = "Property",
  allLabel = "All properties",
}: {
  propertyFilter: string;
  onPropertyFilterChange: (value: string) => void;
  propertyOptions: { id: string; label: string }[];
  dataAttr: string;
  /** "House" on the Applications tab, which is grouped by house. */
  fieldLabel?: string;
  allLabel?: string;
}) {
  if (propertyOptions.length === 0) return null;
  // The filter primitives key on `value`; the shared portfolio builder returns
  // `id`. Map at the boundary, as every other caller does — matching on `id`
  // makes filterSingleSelectSummary's lookup miss and shows the raw id.
  const options = [
    { value: "", label: allLabel },
    ...propertyOptions.map((p) => ({ value: p.id, label: p.label })),
  ];
  return (
    <FilterFieldsAccordion>
      <FilterCollapsibleSection
        sectionId={`${dataAttr}-property`}
        label={fieldLabel}
        summary={filterSingleSelectSummary(propertyFilter, options, allLabel)}
        empty={!propertyFilter}
        menuOptionCount={options.length}
        dataAttr={`${dataAttr}-trigger`}
      >
        <FilterSingleSelectList
          options={options}
          value={propertyFilter}
          onChange={onPropertyFilterChange}
          dataAttr={dataAttr}
        />
      </FilterCollapsibleSection>
    </FilterFieldsAccordion>
  );
}

function LeasingDocumentsBulkBar({
  count,
  exporting,
  onExport,
  dataAttr,
}: {
  count: number;
  exporting: boolean;
  onExport: () => void;
  dataAttr: string;
}) {
  if (count <= 0) return null;
  return (
    <RecordActionItems>
      <Button
        type="button"
        variant="primary"
        className={PORTAL_BULK_BAR_BTN}
        data-attr={dataAttr}
        disabled={exporting}
        onClick={onExport}
      >
        {exporting ? "Exporting…" : count === 1 ? "Export" : `Export (${count})`}
      </Button>
    </RecordActionItems>
  );
}

/**
 * One Properties-style row per application (tile, applicant, place line, email,
 * the list surface's own ⋯), the same shape and inset as Residents. Under a house
 * header the place line drops the house the header already says.
 */
function ApplicationDocumentRows({
  rows,
  groupByHouse,
  searchActive,
  selectedIds,
  onToggle,
  onOpen,
}: {
  rows: DemoApplicantRow[];
  groupByHouse: boolean;
  searchActive: boolean;
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onOpen: (row: DemoApplicantRow) => void;
}) {
  const renderRow = (row: DemoApplicantRow, includeProperty: boolean) => {
    const email = applicantSecondaryEmail(row);
    const place = [applicationStatusLabel(row.bucket), includeProperty ? row.property || null : null, applicationRoomLabel(row) || null]
      .filter(Boolean)
      .join(" · ");
    return (
      <PortalApplicantRecordRow
        name={applicantDisplayName(row, "—")}
        address={place || undefined}
        facts={
          email ? (
            <PortalRowFact icon={Mail} srLabel="Email">
              {email}
            </PortalRowFact>
          ) : undefined
        }
        checked={selectedIds.has(row.id)}
        onSelectedChange={() => onToggle(row.id)}
        onOpen={() => onOpen(row)}
        dataAttr="documents-application-row"
      />
    );
  };
  if (groupByHouse) {
    return (
      <PortalGroupedRecordList
        items={rows}
        groupLabel={applicationDocumentHouseLabel}
        groupId={applicationDocumentHouseId}
        otherLabel={APPLICATION_DOCUMENT_NO_HOUSE_LABEL}
        itemKey={(row) => row.id}
        renderItem={(row) => renderRow(row, false)}
        listKey="documents-applications"
        searchActive={searchActive}
      />
    );
  }
  return (
    <div data-attr="documents-applications-flat-list">
      {rows.map((row) => (
        <div key={row.id}>{renderRow(row, true)}</div>
      ))}
    </div>
  );
}

/** The catch-all house header: an application whose property is not known. */
const APPLICATION_DOCUMENT_NO_HOUSE_LABEL = "No house";
const applicationDocumentHouseLabel = (row: DemoApplicantRow) => row.property?.trim() ?? "";
const applicationDocumentHouseId = (row: DemoApplicantRow) => applicationPropertyId(row) || applicationDocumentHouseLabel(row);

export function ManagerApplicationDocumentsTab({
  userId,
  basePath = "/portal",
  propertyFilter = "",
  sort = HOUSE_LIST_DEFAULT_SORT,
  search = "",
  onClearFilter,
  onClearSearch,
}: {
  userId: string | null;
  basePath?: string;
  propertyFilter?: string;
  /** House groups the list by house (the default); Name and Recently updated are flat. */
  sort?: HouseListSort;
  /** The command bar's search box; narrows rows and opens the houses that still match. */
  search?: string;
  onClearSearch?: () => void;
  /** Clears the parent-owned property filter from the no-match card. */
  onClearFilter?: () => void;
}) {
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const [tick, setTick] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(propertyFilter);

  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    void syncManagerApplicationsFromServer().then(refresh);
    void syncPropertyPipelineFromServer();
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, refresh);
    for (const event of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
      window.addEventListener(event, refresh);
    }
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, refresh);
      for (const event of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
        window.removeEventListener(event, refresh);
      }
    };
  }, []);

  const rows = useMemo(() => {
    void tick;
    if (!userId) return [];
    const visible = readManagerApplicationRows()
      .filter((row) => applicationVisibleToPortalUser(row, userId))
      .filter((row) => !propertyFilter || applicationPropertyId(row) === propertyFilter)
      .filter((row) =>
        matchesPortalListSearch(
          search,
          applicantDisplayName(row, ""),
          applicantSecondaryEmail(row),
          row.property,
          applicationRoomLabel(row),
          applicationStatusLabel(row.bucket),
        ),
      );
    return sortHouseListItems(visible, sort, {
      name: (row) => applicantDisplayName(row, "—"),
      updatedMs: applicationRowSortMs,
      tieBreak: (row) => row.id,
    });
  }, [userId, tick, propertyFilter, search, sort]);

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds],
  );

  const openApplication = useCallback(
    (row: DemoApplicantRow) => {
      navigate(managerDocumentsApplicationDetailHref(basePath, row.id));
    },
    [basePath, navigate],
  );

  const exportSelected = useCallback(async () => {
    if (selectedRows.length === 0) return;
    setExporting(true);
    let exported = 0;
    for (const row of selectedRows) {
      const result = await downloadApplicationPdf(row);
      const message = portalDownloadToastMessage(result, "application");
      if (result === "failed") {
        if (message) showToast(message);
        break;
      }
      exported += 1;
    }
    if (exported > 0) {
      showToast(
        exported === 1 ? "Exported 1 application." : `Exported ${exported} applications.`,
      );
      clearSelection();
    }
    setExporting(false);
  }, [clearSelection, selectedRows, showToast]);

  if (!userId) {
    return <PortalDataTableEmpty icon="application" message="Sign in to view application documents." />;
  }

  return (
    <>
      <PortalRecordListSurface className="mt-0" onBulkClear={clearSelection} bulkCount={selectedIds.size} bulkActions={<LeasingDocumentsBulkBar
        count={selectedIds.size}
        exporting={exporting}
        onExport={() => void exportSelected()}
        dataAttr="documents-applications-bulk-export"
      />}>{rows.length === 0 ? (
        search.trim() ? (
          <PortalListEmptyCard
            section="documents"
            tone="muted"
            title={portalEmptyNoMatchTitle("application documents", search)}
            clear={onClearSearch ? { label: "Clear search", onClick: onClearSearch, dataAttr: "documents-applications-empty-clear-search" } : null}
          />
        ) : propertyFilter ? (
          <PortalListEmptyCard
            section="documents"
            tone="muted"
            title={portalEmptyNoMatchTitle("application documents")}
            clear={onClearFilter ? { label: "Clear filters", onClick: onClearFilter, dataAttr: "documents-applications-empty-clear" } : null}
          />
        ) : (
          <PortalListEmptyCard
            section="documents"
            title={portalEmptyCopy("documents.applications").title}
          />
        )
      ) : (
        <ApplicationDocumentRows
          // A different question (house, sort) starts the open / closed state over.
          key={`${propertyFilter}:${sort}`}
          rows={rows}
          groupByHouse={sort === "house"}
          searchActive={search.trim().length > 0}
          selectedIds={selectedIds}
          onToggle={toggleSelected}
          onOpen={openApplication}
        />
      )}</PortalRecordListSurface>

    </>
  );
}

export function ManagerApplicationDocumentDetail({
  applicationId,
  basePath = "/portal",
  userId,
  ready = true,
}: {
  applicationId: string;
  basePath?: string;
  userId: string | null;
  ready?: boolean;
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    void syncManagerApplicationsFromServer().then(refresh);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, refresh);
    return () => window.removeEventListener(MANAGER_APPLICATIONS_EVENT, refresh);
  }, []);

  const row = useMemo(() => {
    void tick;
    if (!userId) return null;
    return (
      readManagerApplicationRows().find(
        (candidate) =>
          candidate.id === applicationId && applicationVisibleToPortalUser(candidate, userId),
      ) ?? null
    );
  }, [applicationId, tick, userId]);

  const listHref = managerDocumentsApplicationsListHref(basePath);

  if (!ready) {
    return (
      <PortalRecordDetailPage
        pageTitle="Documents"
        title="Application"
        backHref={listHref}
        hideBackText
        bareHeader
        dataAttrBack="documents-application-detail-back"
        pinScrollBody
      >
        <div className="px-3 py-6">
          <ListSkeleton rows={4} showLeading={false} />
        </div>
      </PortalRecordDetailPage>
    );
  }

  if (!userId || !row) {
    return (
      <PortalRecordDetailPage
        pageTitle="Documents"
        title="Application"
        backHref={listHref}
        hideBackText
        bareHeader
        dataAttrBack="documents-application-detail-back"
        pinScrollBody
      >
        <div className="px-3 py-6">
          <PortalDataTableEmpty
            icon="application"
            message={userId ? "Application not found." : "Sign in to view application documents."}
          />
        </div>
      </PortalRecordDetailPage>
    );
  }

  return (
    <PortalRecordDetailPage
      pageTitle="Documents"
      title={applicantDisplayName(row, "Application")}
      subtitle={applicantSecondaryEmail(row) || applicationStatusLabel(row.bucket)}
      avatarName={applicantDisplayName(row, "Application")}
      backHref={listHref}
      hideBackText
      bareHeader
      dataAttrBack="documents-application-detail-back"
      pinScrollBody
    >
      <div className="px-3 pb-6 pt-2 sm:px-4">
        <ApplicationDocumentPreview
          row={row}
          collapsible={false}
          showDownload
          variant="pdf"
          downloadPlacement="bottom"
          bareCanvas
        />
      </div>
    </PortalRecordDetailPage>
  );
}

export function ManagerLeaseDocumentsTab({
  userId,
  propertyFilter = "",
  onClearFilter,
}: {
  userId: string | null;
  propertyFilter?: string;
  /** Clears the parent-owned property filter from the no-match card. */
  onClearFilter?: () => void;
}) {
  const { showToast } = useAppUi();
  const [tick, setTick] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(propertyFilter);

  useEffect(() => {
    const refresh = () => setTick((t) => t + 1);
    void syncLeasePipelineFromServer(userId ?? undefined).then(refresh);
    void syncPropertyPipelineFromServer();
    window.addEventListener(LEASE_PIPELINE_EVENT, refresh);
    for (const event of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
      window.addEventListener(event, refresh);
    }
    return () => {
      window.removeEventListener(LEASE_PIPELINE_EVENT, refresh);
      for (const event of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
        window.removeEventListener(event, refresh);
      }
    };
  }, [userId]);

  const rows = useMemo(() => {
    void tick;
    if (!userId) return [];
    return readLeasePipeline(userId)
      .filter((row) => leaseVisibleToPortalUser(row, userId))
      .filter((row) => !propertyFilter || (row.propertyId ?? "") === propertyFilter)
      .sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso));
  }, [userId, tick, propertyFilter]);

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds],
  );

  const togglePreview = useCallback((row: LeasePipelineRow) => {
    setPreviewId((cur) => (cur === row.id ? null : row.id));
  }, []);

  // Await each download rather than calling the fire-and-forget runLeaseDownload:
  // that fired all N at once and reported "Exported N" before any had finished,
  // so per-row failure toasts arrived afterwards contradicting the count, and
  // setExporting(true/false) in one synchronous tick meant "Exporting…" never
  // rendered. Mirrors the applications export above.
  const exportSelected = useCallback(async () => {
    if (selectedRows.length === 0) return;
    setExporting(true);
    let exported = 0;
    let failed = false;
    for (const row of selectedRows) {
      if (!leaseHasDownloadableDocument(row)) continue;
      const result = await downloadLeaseFromRow(row);
      const message = portalDownloadToastMessage(result, "lease");
      if (result === "failed") {
        if (message) showToast(message);
        failed = true;
        break;
      }
      exported += 1;
    }
    if (exported > 0) {
      showToast(exported === 1 ? "Exported 1 lease." : `Exported ${exported} leases.`);
      clearSelection();
    } else if (!failed) {
      // Only when nothing was exportable — a failure already toasted its own
      // reason, and adding "no document to export yet" contradicted it.
      showToast("Selected leases do not have a document to export yet.");
    }
    setExporting(false);
  }, [clearSelection, selectedRows, showToast]);

  if (!userId) {
    return <PortalDataTableEmpty icon="lease" message="Sign in to view lease documents." />;
  }

  return (
    <>
      <PortalRecordListSurface className="mt-0" onBulkClear={clearSelection} bulkCount={selectedIds.size} bulkActions={<LeasingDocumentsBulkBar
        count={selectedIds.size}
        exporting={exporting}
        onExport={exportSelected}
        dataAttr="documents-leases-bulk-export"
      />}>{rows.length === 0 ? (
        propertyFilter ? (
          <PortalListEmptyCard
            section="documents"
            tone="muted"
            title={portalEmptyNoMatchTitle("lease documents")}
            clear={onClearFilter ? { label: "Clear filters", onClick: onClearFilter, dataAttr: "documents-leases-empty-clear" } : null}
          />
        ) : (
          <PortalListEmptyCard
            section="documents"
            title={portalEmptyCopy("documents.leases").title}
          />
        )
      ) : (
        <DataList
          hideColumnHeaders
          selectable
          rows={rows.map((row) => {
            const isOpen = previewId === row.id;
            const status = row.stageLabel || row.status;
            const metaParts = [row.unit || null, status, safeFormatDateTime(row.updatedAtIso)].filter(Boolean);
            const pdfSrc = row.managerUploadedPdf?.dataUrl ?? null;
            const html = pdfSrc ? null : getLeaseDocumentHtml(row);
            const label = `Lease · ${row.residentName || row.residentEmail}${row.unit ? ` · ${row.unit}` : ""}`;
            return {
              id: row.id,
              data: row,
              primary: row.residentName || row.residentEmail,
              meta: metaParts.join(" · "),
              trailing: (
                <span className="text-xs text-muted tabular-nums">{safeFormatDateTime(row.updatedAtIso)}</span>
              ),
              selected: selectedIds.has(row.id),
              onSelectedChange: () => toggleSelected(row.id),
              onClick: () => togglePreview(row),
              expanded: isOpen,
              expandedContent: isOpen ? (
                <DocumentInlineViewer
                  embedded
                  actionsPlacement="bottom"
                  title={label}
                  src={pdfSrc}
                  srcDoc={html}
                  onDownload={() => runLeaseDownload(row, showToast)}
                  downloadLabel={pdfSrc ? "Download PDF" : "Download / print"}
                  downloadAttr="manager-documents-lease-download"
                />
              ) : undefined,
            };
          })}
          columns={[
            {
              id: "resident",
              header: "Resident",
              cell: (row) => (
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{row.residentName || "—"}</p>
                  <p className="mt-0.5 truncate text-xs text-muted">{row.residentEmail}</p>
                </div>
              ),
            },
            {
              id: "unit",
              header: "Property / unit",
              cell: (row) => row.unit || "—",
            },
            {
              id: "status",
              header: "Status",
              cell: (row) => (
                <div>
                  <p>{row.stageLabel || row.status}</p>
                  {!leaseHasDownloadableDocument(row) ? (
                    <p className="mt-0.5 text-xs text-muted">No document yet</p>
                  ) : null}
                </div>
              ),
              cellClassName: "text-muted",
            },
            {
              id: "updated",
              header: "Updated",
              cell: (row) => safeFormatDateTime(row.updatedAtIso),
              cellClassName: "text-muted tabular-nums",
            },
          ]}
        />
      )}</PortalRecordListSurface>

    </>
  );
}
