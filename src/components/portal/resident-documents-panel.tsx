"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ManagerPortalPageShell,
  PORTAL_COMMAND_PRIMARY_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_STYLE,
} from "@/components/portal/portal-metrics";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { ResidentPortalDataList } from "@/components/portal/resident-portal-data-list";
import { ResidentPortalListBottomBar } from "@/components/portal/resident-portal-list-bottom-bar";
import {
  residentDocumentsDownloadAction,
  residentDocumentsOpenAction,
  useResidentDocumentSelection,
} from "@/components/portal/resident-documents-bulk";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import { ReportGeneratePrompt } from "@/components/portal/reports/report-generate-prompt";
import {
  PortalDataTableEmpty,
} from "@/components/portal/portal-data-table";
import {
  DocumentInlineViewer,
  ResidentAddDocumentModal,
  ResidentOtherDocumentsTable,
  triggerDocumentDownload,
} from "@/components/portal/resident-other-documents";
import {
  ApplicationDocumentPreview,
  ApplicationPdfDownloadButton,
  runApplicationPdfDownload,
} from "@/components/portal/manager-applications";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import {
  RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN,
  ResidentDocumentsDetailFooter,
} from "@/components/portal/portal-data-table";
import { Button } from "@/components/ui/button";
import { ResidentLeaseDocumentsListSection } from "@/components/portal/resident-lease-list";
import {
  RESIDENT_LEASE_LIST_LABEL,
  ResidentLeaseBareDocumentPreview,
  residentLeaseDetailSubtitle,
} from "@/components/portal/resident-lease-document-preview";
import { resolveResidentLeaseDocumentView, buildResidentLeaseDocumentRows } from "@/lib/resident-lease-documents";
import { stageResidentComposePrefill } from "@/lib/resident-compose-prefill";
import { residentLeaseManagerMessageDraft } from "@/lib/resident-manager-message-draft";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { buildRentReceiptHtml } from "@/lib/rent-receipt-html";
import { buildReceiptRows, type ReceiptRow } from "@/lib/rent-receipts";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { usePortalSession } from "@/hooks/use-portal-session";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  residentDocumentsApplicationDetailHref,
  residentDocumentsApplicationListHref,
  residentDocumentsLeaseDetailHref,
  residentDocumentsLeaseListHref,
  residentDocumentsReceiptDetailHref,
  residentDocumentsReceiptsListHref,
} from "@/lib/portal-detail-routes";
import {
  MANAGER_APPLICATIONS_EVENT,
  readManagerApplicationRows,
  resolveResidentPortalAxisId,
  syncManagerApplicationsFromServer,
} from "@/lib/manager-applications-storage";
import {
  isWithdrawnApplicationRow,
  sortResidentApplicationRows,
} from "@/lib/rental-application/resident-application-list";
import { residentOwnsApplicationRow } from "@/lib/rental-application/resident-application-ownership";
import type { DemoApplicantRow, ManagerApplicationBucket } from "@/data/demo-portal";
import {
  LEASE_PIPELINE_EVENT,
  runLeaseDownload,
  findLeaseForResidentEmail,
  syncLeasePipelineFromServer,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import {
  readUploadedOwnLeases,
  removeUploadedOwnLease,
  syncUploadedOwnLeasesFromServer,
  type UploadedOwnLease,
} from "@/lib/resident-lease-upload";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { safeFormatDateTime } from "@/lib/pacific-time";
import type { ReportResult } from "@/lib/reports/types";
import { readChargesForResident } from "@/lib/household-charges";
import { DEMO_RESIDENT_NAME, isDemoModeActive } from "@/lib/demo/demo-session";
import { receiptRowLabel, residentLedgerReceiptRange } from "@/lib/resident-recorded-payments";

function applicationStatusLabel(bucket: ManagerApplicationBucket): string {
  if (bucket === "approved") return "Approved";
  if (bucket === "rejected") return "Rejected";
  return "Pending review";
}

/** Documents › Application — the resident's applications as selectable rows. */
function ApplicationDocumentsTable({ basePath }: { basePath: string }) {
  const session = usePortalSession();
  const navigate = usePortalNavigate();
  const { showToast } = useAppUi();
  const email = session.email?.trim().toLowerCase() ?? "";
  const userId = session.userId;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    void syncManagerApplicationsFromServer({ selfScope: true }).then(on);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, on);
    return () => window.removeEventListener(MANAGER_APPLICATIONS_EVENT, on);
  }, []);

  const rows = useMemo<DemoApplicantRow[]>(() => {
    void tick;
    if (!email) return [];
    return sortResidentApplicationRows(
      readManagerApplicationRows().filter(
        (row) =>
          residentOwnsApplicationRow(row, { email, userId }) && !isWithdrawnApplicationRow(row),
      ),
    );
  }, [email, userId, tick]);

  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const { selectedIds, toggleSelected } = useResidentDocumentSelection(rowIds);

  const openApplication = useCallback(
    (row: DemoApplicantRow) => {
      navigate(residentDocumentsApplicationDetailHref(basePath, row.id));
    },
    [basePath, navigate],
  );

  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.has(row.id)),
    [rows, selectedIds],
  );
  const singleSelected = selectedRows.length === 1 ? selectedRows[0]! : null;

  const bulkActions = useMemo(() => {
    const actions = [];
    if (singleSelected) {
      actions.push(
        residentDocumentsOpenAction(
          "Open",
          () => openApplication(singleSelected),
          "resident-documents-application-open",
        ),
        residentDocumentsDownloadAction(
          "Download",
          () => runApplicationPdfDownload(singleSelected, showToast),
          "resident-documents-application-download",
        ),
      );
    }
    return actions;
  }, [openApplication, showToast, singleSelected]);

  return (
    <>
      <div className={PORTAL_LIST_PAGE_BODY} data-attr="resident-documents-application-list">
        <ResidentPortalDataList
          selectable
          rows={rows.map((row) => ({
            id: row.id,
            data: row,
            primary: "Rental application",
            meta: [row.property || "—", applicationStatusLabel(row.bucket)].join(" · "),
            trailing: (
              <span className="text-xs font-medium text-muted">{applicationStatusLabel(row.bucket)}</span>
            ),
            selected: selectedIds.has(row.id),
            onSelectedChange: () => toggleSelected(row.id),
            onClick: () => openApplication(row),
          }))}
          columns={[{ id: "application", header: "Application", cell: () => "—" }]}
          emptyState={
            <PortalDataTableEmpty icon="application" message="No applications are linked to your account yet." />
          }
        />
      </div>
      <ResidentPortalListBottomBar
        selectionCount={selectedIds.size}
        selectionActions={bulkActions}
        selectionBarVariant="payments"
      />
    </>
  );
}

function ResidentApplicationDocumentDetail({
  applicationId,
  basePath,
}: {
  applicationId: string;
  basePath: string;
}) {
  const session = usePortalSession();
  const email = session.email?.trim().toLowerCase() ?? "";
  const userId = session.userId;
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    void syncManagerApplicationsFromServer({ selfScope: true }).then(on);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, on);
    return () => window.removeEventListener(MANAGER_APPLICATIONS_EVENT, on);
  }, []);

  const row = useMemo(() => {
    void tick;
    if (!email) return null;
    return (
      readManagerApplicationRows().find(
        (candidate) =>
          candidate.id === applicationId &&
          residentOwnsApplicationRow(candidate, { email, userId }) &&
          !isWithdrawnApplicationRow(candidate),
      ) ?? null
    );
  }, [applicationId, email, tick, userId]);

  const listHref = residentDocumentsApplicationListHref(basePath);

  if (!row) {
    return (
      <PortalRecordDetailPage
        pageTitle="Documents"
        title="Application"
        backHref={listHref}
        hideBackText
        bareHeader
        dataAttrBack="resident-documents-application-detail-back"
        pinScrollBody
      >
        <div className="px-3 py-6">
          {email ? (
            <PortalDataTableEmpty icon="application" message="Application not found." />
          ) : (
            <ListSkeleton rows={4} showLeading={false} />
          )}
        </div>
      </PortalRecordDetailPage>
    );
  }

  return (
    <PortalRecordDetailPage
      pageTitle="Documents"
      title="Rental application"
      subtitle={applicationStatusLabel(row.bucket)}
      backHref={listHref}
      hideBackText
      bareHeader
      dataAttrBack="resident-documents-application-detail-back"
      pinScrollBody
      footer={
        <ResidentDocumentsDetailFooter>
          <ApplicationPdfDownloadButton
            row={row}
            label="Download application"
            className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
          />
        </ResidentDocumentsDetailFooter>
      }
    >
      <div className="px-3 pb-6 pt-2 sm:px-4">
        <ApplicationDocumentPreview
          row={row}
          collapsible={false}
          showDownload={false}
          variant="pdf"
          bareCanvas
        />
      </div>
    </PortalRecordDetailPage>
  );
}

function receiptPdfHref(date: string): string {
  const params = new URLSearchParams({ from: date, to: date, format: "pdf" });
  return `/api/reports/resident-ledger/export?${params.toString()}`;
}

function useResidentLeaseDocumentSource(): LeasePipelineRow | null {
  const session = usePortalSession();
  const email = session.email?.trim() ?? "";
  const [tick, setTick] = useState(0);
  const [residentAxisId, setResidentAxisId] = useState("");
  const [profileManagerId, setProfileManagerId] = useState<string | null>(null);
  const [axisResolved, setAxisResolved] = useState(false);

  useEffect(() => {
    if (!session.userId) {
      queueMicrotask(() => setAxisResolved(true));
      return;
    }
    let cancelled = false;
    const normalizedEmail = email.trim().toLowerCase();
    const matchingApplication = readManagerApplicationRows()
      .slice()
      .reverse()
      .find((row) => row.email?.trim().toLowerCase() === normalizedEmail);

    if (isDemoModeActive()) {
      queueMicrotask(() => {
        if (cancelled) return;
        setProfileManagerId(null);
        setResidentAxisId(resolveResidentPortalAxisId({ applicationRowId: matchingApplication?.id }));
        setAxisResolved(true);
      });
      return;
    }

    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const [{ data: profile }, { data: authUser }] = await Promise.all([
          supabase.from("profiles").select("manager_id").eq("id", session.userId).maybeSingle(),
          supabase.auth.getUser(),
        ]);
        if (cancelled) return;
        const meta = authUser?.user?.user_metadata as Record<string, unknown> | undefined;
        const metaAxis = typeof meta?.axis_id === "string" ? meta.axis_id : null;
        setProfileManagerId(profile?.manager_id ?? null);
        setResidentAxisId(
          resolveResidentPortalAxisId({
            profileManagerId: profile?.manager_id,
            authUserAxisId: metaAxis,
            applicationRowId: matchingApplication?.id,
          }),
        );
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setAxisResolved(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [email, session.userId]);

  useEffect(() => {
    const on = () => setTick((t) => t + 1);
    void syncLeasePipelineFromServer().then(on);
    window.addEventListener(LEASE_PIPELINE_EVENT, on);
    window.addEventListener("storage", on);
    return () => {
      window.removeEventListener(LEASE_PIPELINE_EVENT, on);
      window.removeEventListener("storage", on);
    };
  }, []);

  return useMemo<LeasePipelineRow | null>(() => {
    void tick;
    if (!email || !axisResolved) return null;
    const row = findLeaseForResidentEmail(email, {
      email,
      residentAxisId,
      profileManagerId,
    });
    return row ?? null;
  }, [axisResolved, email, profileManagerId, residentAxisId, tick]);
}

function ResidentLeaseDocumentDetail({ leaseId, basePath }: { leaseId: string; basePath: string }) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const row = useResidentLeaseDocumentSource();
  const listHref = residentDocumentsLeaseListHref(basePath);
  const view = useMemo(() => resolveResidentLeaseDocumentView(row, leaseId), [row, leaseId]);
  const detailEntry = useMemo(() => {
    if (!row || !leaseId) return null;
    return buildResidentLeaseDocumentRows(row).find((entry) => entry.id === leaseId) ?? null;
  }, [leaseId, row]);

  const openRequestEdits = useCallback(() => {
    if (!row || !view) return;
    stageResidentComposePrefill(
      residentLeaseManagerMessageDraft(row, {
        leaseTitle: view.title,
        requestEdits: true,
      }),
    );
    navigate(`${RESIDENT_PORTAL_BASE_PATH}/communication/active`);
  }, [navigate, row, view]);

  if (!row || !view) {
    return (
      <PortalRecordDetailPage
        pageTitle="Documents"
        title="Lease"
        backHref={listHref}
        hideBackText
        bareHeader
        dataAttrBack="resident-documents-lease-detail-back"
        pinScrollBody
      >
        <div className="px-3 py-6">
          <PortalDataTableEmpty icon="lease" message="Lease document not found." />
        </div>
      </PortalRecordDetailPage>
    );
  }

  const downloadTarget =
    view.pipelineRow ??
    ({
      ...row,
      generatedHtml: view.leaseHtml,
      managerUploadedPdf: view.pdfSrc
        ? { dataUrl: view.pdfSrc, fileName: "lease.pdf", uploadedAt: view.subtitle }
        : row.managerUploadedPdf,
    } as typeof row);

  return (
    <PortalRecordDetailPage
      pageTitle="Documents"
      title={RESIDENT_LEASE_LIST_LABEL}
      subtitle={
        detailEntry
          ? residentLeaseDetailSubtitle(detailEntry.status, safeFormatDateTime(detailEntry.signedAt))
          : view.subtitle
      }
      backHref={listHref}
      hideBackText
      bareHeader
      dataAttrBack="resident-documents-lease-detail-back"
      pinScrollBody
      footer={
        <ResidentDocumentsDetailFooter>
          <Button
            type="button"
            variant="outline"
            className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
            data-attr="resident-documents-lease-request-edits"
            onClick={openRequestEdits}
          >
            Request edits
          </Button>
          <Button
            type="button"
            variant="outline"
            className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
            data-attr="resident-documents-lease-download-pdf"
            onClick={() => runLeaseDownload(downloadTarget, showToast)}
          >
            {view.pdfSrc ? "Download lease" : "Download / print lease"}
          </Button>
        </ResidentDocumentsDetailFooter>
      }
    >
      <div className="px-3 pb-6 pt-2 sm:px-4">
        <ResidentLeaseBareDocumentPreview
          pdfSrc={view.pdfSrc}
          leaseHtml={view.leaseHtml}
          title={RESIDENT_LEASE_LIST_LABEL}
        />
      </div>
    </PortalRecordDetailPage>
  );
}

function ResidentReceiptDocumentDetail({ receiptId, basePath }: { receiptId: string; basePath: string }) {
  const session = usePortalSession();
  const demoMode = isDemoModeActive();
  const demoPdfCache = useRef(new Map<string, string>());
  const sessionEmail = session.email?.trim().toLowerCase() ?? "";
  const sessionUserId = session.userId ?? null;
  const [ledgerReport, setLedgerReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [range] = useState(() => residentLedgerReceiptRange());
  const listHref = residentDocumentsReceiptsListHref(basePath);

  useEffect(() => {
    let cancelled = false;
    if (demoMode) {
      const rows = readChargesForResident(sessionEmail, sessionUserId)
        .filter((charge) => charge.status === "paid" && charge.paidAt)
        .sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)))
        .map((charge) => ({
          date: String(charge.paidAt).slice(0, 10),
          description: `${charge.title} · ${charge.propertyLabel}`,
          payment: charge.amountLabel,
        }));
      setLedgerReport({ id: "resident-ledger", title: "Resident ledger", columns: [], rows });
      setLoading(false);
      return;
    }
    setLoading(true);
    void (async () => {
      try {
        const params = new URLSearchParams({ from: range.from, to: range.to });
        const res = await fetch(`/api/reports/resident-ledger?${params}`);
        const data = await res.json();
        if (!cancelled && res.ok) setLedgerReport(data as ReportResult);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [demoMode, range.from, range.to, sessionEmail, sessionUserId]);

  const receipt = useMemo(
    () => buildReceiptRows(ledgerReport?.rows ?? []).find((row) => row.id === receiptId) ?? null,
    [ledgerReport, receiptId],
  );

  const buildDemoReceipt = useCallback(async (row: ReceiptRow): Promise<string> => {
    const key = `${row.date}:${row.amount}`;
    const cached = demoPdfCache.current.get(key);
    if (cached) return cached;
    const { buildDemoReceiptPdfDataUrl } = await import("@/lib/demo/demo-document-files");
    const url = await buildDemoReceiptPdfDataUrl({
      residentName: DEMO_RESIDENT_NAME,
      description: row.description,
      amountLabel: row.amount,
      dateLabel: row.date,
    });
    demoPdfCache.current.set(key, url);
    return url;
  }, []);

  const downloadReceipt = useCallback(
    (row: ReceiptRow) => {
      if (demoMode) {
        void buildDemoReceipt(row).then((url) => triggerDocumentDownload(url, `payment-receipt-${row.date}.pdf`));
        return;
      }
      triggerDocumentDownload(receiptPdfHref(row.date), `payment-receipt-${row.date}.pdf`);
    },
    [demoMode, buildDemoReceipt],
  );

  if (loading) {
    return (
      <PortalRecordDetailPage
        pageTitle="Documents"
        title="Rent receipt"
        backHref={listHref}
        hideBackText
        bareHeader
        dataAttrBack="resident-documents-receipt-detail-back"
        pinScrollBody
      >
        <div className="px-3 py-6">
          <ReportGeneratePrompt loading loadingTitle="Loading receipt…" />
        </div>
      </PortalRecordDetailPage>
    );
  }

  if (!receipt) {
    return (
      <PortalRecordDetailPage
        pageTitle="Documents"
        title="Rent receipt"
        backHref={listHref}
        hideBackText
        bareHeader
        dataAttrBack="resident-documents-receipt-detail-back"
        pinScrollBody
      >
        <div className="px-3 py-6">
          <PortalDataTableEmpty icon="default" message="Receipt not found." />
        </div>
      </PortalRecordDetailPage>
    );
  }

  const title = receiptRowLabel(receipt.description);

  return (
    <PortalRecordDetailPage
      pageTitle="Documents"
      title={title}
      subtitle={`${receipt.amount} · ${receipt.date}`}
      backHref={listHref}
      hideBackText
      bareHeader
      dataAttrBack="resident-documents-receipt-detail-back"
      pinScrollBody
      footer={
        <ResidentDocumentsDetailFooter>
          <Button
            type="button"
            variant="outline"
            className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
            data-attr="resident-documents-receipt-download"
            onClick={() => downloadReceipt(receipt)}
          >
            Download receipt
          </Button>
        </ResidentDocumentsDetailFooter>
      }
    >
      <div className="px-3 pb-6 pt-2 sm:px-4">
        <DocumentInlineViewer
          embedded
          hideActions
          title={`${title} ${receipt.date}`}
          srcDoc={buildRentReceiptHtml({
            residentName: demoMode ? DEMO_RESIDENT_NAME : sessionEmail || undefined,
            description: receipt.description,
            amountLabel: receipt.amount,
            dateLabel: receipt.date,
          })}
          onDownload={() => downloadReceipt(receipt)}
          downloadLabel="Download receipt"
          downloadAttr="resident-documents-receipt-download"
        />
      </div>
    </PortalRecordDetailPage>
  );
}

/** Documents › Rent receipts — one row per recorded payment; tap opens a detail page with download. */
function RentReceiptsTab({ basePath }: { basePath: string }) {
  const session = usePortalSession();
  const navigate = usePortalNavigate();
  const [ledgerReport, setLedgerReport] = useState<ReportResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [generated, setGenerated] = useState(false);
  const [range, setRange] = useState(() => residentLedgerReceiptRange());
  const demoMode = isDemoModeActive();
  const sessionEmail = session.email?.trim().toLowerCase() ?? "";
  const sessionUserId = session.userId ?? null;

  const loadReceipts = useCallback(async (from: string, to: string) => {
    if (demoMode) {
      const rows = readChargesForResident(sessionEmail, sessionUserId)
        .filter((charge) => charge.status === "paid" && charge.paidAt)
        .sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)))
        .map((charge) => ({
          date: String(charge.paidAt).slice(0, 10),
          description: `${charge.title} · ${charge.propertyLabel}`,
          payment: charge.amountLabel,
        }));
      setLedgerReport({ id: "resident-ledger", title: "Resident ledger", columns: [], rows });
      setGenerated(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      const res = await fetch(`/api/reports/resident-ledger?${params}`);
      const data = await res.json();
      if (res.ok) {
        setLedgerReport(data as ReportResult);
        setGenerated(true);
      }
    } finally {
      setLoading(false);
    }
  }, [demoMode, sessionEmail, sessionUserId]);

  useEffect(() => {
    void loadReceipts(range.from, range.to);
  }, [range.from, range.to, loadReceipts]);

  const receipts = useMemo<ReceiptRow[]>(
    () => buildReceiptRows(ledgerReport?.rows ?? []),
    [ledgerReport],
  );

  const openReceipt = useCallback(
    (row: ReceiptRow) => {
      navigate(residentDocumentsReceiptDetailHref(basePath, row.id));
    },
    [basePath, navigate],
  );

  const demoPdfCache = useRef(new Map<string, string>());

  const buildDemoReceipt = useCallback(async (row: ReceiptRow): Promise<string> => {
    const key = `${row.date}:${row.amount}`;
    const cached = demoPdfCache.current.get(key);
    if (cached) return cached;
    const { buildDemoReceiptPdfDataUrl } = await import("@/lib/demo/demo-document-files");
    const url = await buildDemoReceiptPdfDataUrl({
      residentName: DEMO_RESIDENT_NAME,
      description: row.description,
      amountLabel: row.amount,
      dateLabel: row.date,
    });
    demoPdfCache.current.set(key, url);
    return url;
  }, []);

  const downloadReceipt = useCallback(
    (row: ReceiptRow) => {
      if (demoMode) {
        void buildDemoReceipt(row).then((url) =>
          triggerDocumentDownload(url, `payment-receipt-${row.date}.pdf`),
        );
        return;
      }
      triggerDocumentDownload(receiptPdfHref(row.date), `payment-receipt-${row.date}.pdf`);
    },
    [demoMode, buildDemoReceipt],
  );

  const rowIds = useMemo(() => receipts.map((row) => row.id), [receipts]);
  const { selectedIds, toggleSelected } = useResidentDocumentSelection(rowIds);
  const selectedRows = useMemo(
    () => receipts.filter((row) => selectedIds.has(row.id)),
    [receipts, selectedIds],
  );
  const singleSelected = selectedRows.length === 1 ? selectedRows[0]! : null;

  const bulkActions = useMemo(() => {
    const actions = [];
    if (singleSelected) {
      actions.push(
        residentDocumentsOpenAction(
          "Open",
          () => openReceipt(singleSelected),
          "resident-documents-receipt-open",
        ),
        residentDocumentsDownloadAction(
          "Download",
          () => downloadReceipt(singleSelected),
          "resident-documents-receipt-download",
        ),
      );
    }
    return actions;
  }, [downloadReceipt, openReceipt, singleSelected]);

  return (
    <>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            From
            <input
              type="date"
              value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-muted">
            To
            <input
              type="date"
              value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
            />
          </label>
        </div>
        {loading && !generated ? (
          <ReportGeneratePrompt loading loadingTitle="Loading rent receipts…" />
        ) : receipts.length === 0 ? (
          <PortalDataTableEmpty icon="default" message="No rent receipts in this date range yet." />
        ) : (
          <div className={PORTAL_LIST_PAGE_BODY} data-attr="resident-documents-receipt-list">
            <ResidentPortalDataList
              selectable
              rows={receipts.map((row) => ({
                id: row.id,
                data: row,
                primary: receiptRowLabel(row.description),
                meta: row.date,
                selected: selectedIds.has(row.id),
                onSelectedChange: () => toggleSelected(row.id),
                onClick: () => openReceipt(row),
              }))}
              columns={[{ id: "receipt", header: "Receipt", cell: () => "—" }]}
            />
          </div>
        )}
      </div>
      <ResidentPortalListBottomBar
        selectionCount={selectedIds.size}
        selectionActions={bulkActions}
        selectionBarVariant="payments"
      />
    </>
  );
}

/**
 * Documents › Lease — read-only signed leases; tap a row for the detail page.
 * Signing and renewals live on the standalone Lease tab.
 */
function SignedLeaseDocumentsTable({ basePath }: { basePath: string }) {
  return <ResidentLeaseDocumentsListSection basePath={basePath} />;
}

export function ResidentDocumentsPanel({
  tabId,
  basePath = "/resident",
  tabs,
  applicationId,
  leaseId,
  receiptId,
}: {
  tabId: string;
  basePath?: string;
  tabs: ReadonlyArray<{ id: string; label: string }>;
  applicationId?: string;
  leaseId?: string;
  receiptId?: string;
}) {
  const { showToast } = useAppUi();
  const session = usePortalSession();
  const navigate = usePortalNavigate();
  const email = session.email?.trim().toLowerCase() ?? "";

  const [addOpen, setAddOpen] = useState(false);
  const [uploads, setUploads] = useState<UploadedOwnLease[]>([]);
  const [uploadsLoading, setUploadsLoading] = useState(true);

  const refreshUploads = useCallback(async () => {
    if (!email) {
      setUploads([]);
      setUploadsLoading(false);
      return;
    }
    setUploadsLoading(true);
    try {
      const rows = await syncUploadedOwnLeasesFromServer(email);
      setUploads(rows);
    } finally {
      setUploadsLoading(false);
    }
  }, [email]);

  useEffect(() => {
    queueMicrotask(() => void refreshUploads());
  }, [refreshUploads]);

  const tabItems = useMemo(
    () => tabs.map((tab) => ({ id: tab.id, label: tab.label, href: `${basePath}/documents/${tab.id}` })),
    [tabs, basePath],
  );

  const openAdd = () => {
    if (!email) {
      showToast("Sign in to upload documents.");
      return;
    }
    setAddOpen(true);
  };

  const onDocumentAdded = () => {
    setUploads(readUploadedOwnLeases(email));
    if (tabId !== "other") navigate(`${basePath}/documents/other`);
  };

  const onRemoveUpload = (id: string) => {
    if (!email) return;
    removeUploadedOwnLease(email, id);
    setUploads(readUploadedOwnLeases(email));
    showToast("Removed.");
  };

  if (tabId === "application" && applicationId) {
    return (
      <ResidentApplicationDocumentDetail applicationId={applicationId} basePath={basePath} />
    );
  }

  if (tabId === "lease" && leaseId) {
    return <ResidentLeaseDocumentDetail leaseId={leaseId} basePath={basePath} />;
  }

  if (tabId === "receipts" && receiptId) {
    return <ResidentReceiptDocumentDetail receiptId={receiptId} basePath={basePath} />;
  }

  return (
    <ManagerPortalPageShell title="Documents" hideTitleOnMobileNav compactFilterRow>
      <PortalListControlStack
        className="mb-2 max-lg:mb-1.5"
        variant="command"
        stickyDestinations={false}
        destinations={tabItems.map((tab) => ({
          id: tab.id,
          label: tab.label,
          href: tab.href,
          dataAttr: `resident-documents-tab-${tab.id}`,
        }))}
        activeDestinationId={tabId}
        destinationAriaLabel="Documents"
        actions={
          tabId === "other" ? (
            <Button
              type="button"
              className={PORTAL_COMMAND_PRIMARY_ACTION_BTN}
              style={PORTAL_COMMAND_PRIMARY_ACTION_STYLE}
              data-attr="resident-documents-upload"
              onClick={openAdd}
            >
              <span className="sm:hidden" aria-hidden="true">Upload</span>
              <span className="hidden sm:inline">Upload document</span>
            </Button>
          ) : null
        }
      />
      {tabId === "application" ? <ApplicationDocumentsTable basePath={basePath} /> : null}

      {tabId === "lease" ? <SignedLeaseDocumentsTable basePath={basePath} /> : null}

      {tabId === "receipts" ? <RentReceiptsTab basePath={basePath} /> : null}

      {tabId === "other" ? (
        <>
          <ResidentOtherDocumentsTable
            uploads={uploads}
            loading={uploadsLoading}
            onRemove={onRemoveUpload}
            demo={isDemoModeActive()}
          />
          <ResidentAddDocumentModal
            key={addOpen ? "open" : "closed"}
            open={addOpen}
            email={email}
            onClose={() => setAddOpen(false)}
            onAdded={onDocumentAdded}
          />
        </>
      ) : null}
    </ManagerPortalPageShell>
  );
}
