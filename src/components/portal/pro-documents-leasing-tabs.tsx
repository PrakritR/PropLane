"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApplicationDocumentPreview,
} from "@/components/portal/pro-applications";
import { DocumentInlineViewer } from "@/components/portal/resident-other-documents";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { DataList } from "@/components/ui/data-list";
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
import {
  LEASE_PIPELINE_EVENT,
  runLeaseDownload,
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

export function ManagerApplicationDocumentsTab({
  userId,
  basePath = "/portal",
}: {
  userId: string | null;
  basePath?: string;
}) {
  const navigate = usePortalNavigate();
  const [tick, setTick] = useState(0);

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
    return readManagerApplicationRows()
      .filter((row) => applicationVisibleToPortalUser(row, userId))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }, [userId, tick]);

  const openApplication = useCallback(
    (row: DemoApplicantRow) => {
      navigate(managerDocumentsApplicationDetailHref(basePath, row.id));
    },
    [basePath, navigate],
  );

  if (!userId) {
    return <PortalDataTableEmpty icon="application" message="Sign in to view application documents." />;
  }

  if (rows.length === 0) {
    return <PortalDataTableEmpty icon="application" message="No application documents yet." />;
  }

  return (
    <DataList
      hideColumnHeaders
      rows={rows.map((row) => {
        const status = applicationStatusLabel(row.bucket);
        const room = applicationRoomLabel(row);
        const metaParts = [status, row.property || null, room || null].filter(Boolean);
        return {
          id: row.id,
          data: row,
          primary: applicantDisplayName(row, "—"),
          meta: metaParts.join(" · ") || undefined,
          trailing: applicantSecondaryEmail(row) ? (
            <span className="hidden text-xs text-muted sm:inline">{applicantSecondaryEmail(row)}</span>
          ) : (
            <span className="text-xs text-muted">{status}</span>
          ),
          onClick: () => openApplication(row),
        };
      })}
      columns={[
        {
          id: "applicant",
          header: "Applicant",
          cell: (row) => (
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground">{applicantDisplayName(row, "—")}</p>
              {applicantSecondaryEmail(row) ? (
                <p className="mt-0.5 truncate text-xs text-muted">{applicantSecondaryEmail(row)}</p>
              ) : null}
            </div>
          ),
        },
        {
          id: "status",
          header: "Status",
          cell: (row) => applicationStatusLabel(row.bucket),
          cellClassName: "text-muted",
        },
        {
          id: "property",
          header: "Property",
          cell: (row) => (
            <div className="min-w-0">
              <p className="truncate">{row.property || "—"}</p>
              {applicationRoomLabel(row) ? (
                <p className="mt-0.5 truncate text-xs text-muted">{applicationRoomLabel(row)}</p>
              ) : null}
            </div>
          ),
        },
      ]}
    />
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

export function ManagerLeaseDocumentsTab({ userId }: { userId: string | null }) {
  const { showToast } = useAppUi();
  const [tick, setTick] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);

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
      .sort((a, b) => b.updatedAtIso.localeCompare(a.updatedAtIso));
  }, [userId, tick]);

  const togglePreview = useCallback((row: LeasePipelineRow) => {
    setPreviewId((cur) => (cur === row.id ? null : row.id));
  }, []);

  if (!userId) {
    return <PortalDataTableEmpty icon="lease" message="Sign in to view lease documents." />;
  }

  if (rows.length === 0) {
    return <PortalDataTableEmpty icon="lease" message="No lease documents yet." />;
  }

  return (
    <DataList
      hideColumnHeaders
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
  );
}
