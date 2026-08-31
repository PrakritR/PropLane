"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { LeaseAmendMoveOutModal, LeaseRenewModal } from "@/components/portal/lease-amend-move-out-modal";
import { LeaseSigningModal } from "@/components/portal/lease-signing-modal";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalEmptyState } from "@/components/portal/portal-empty-state";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import {
  RESIDENT_LEASE_LIST_LABEL,
  ResidentLeaseBareDocumentPreview,
  residentLeaseDetailSubtitle,
} from "@/components/portal/resident-lease-document-preview";
import { ResidentLeaseListTable, useResidentLeasePipelineRow } from "@/components/portal/resident-lease-list";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { ResidentPortalListBottomBar } from "@/components/portal/resident-portal-list-bottom-bar";
import type { PortalAdaptiveAction } from "@/components/portal/portal-adaptive-action-row";
import {
  PortalDataTableEmpty,
  RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN,
  ResidentDocumentsDetailFooter,
} from "@/components/portal/portal-data-table";
import {
  residentLeaseDetailHref,
  residentLeaseListHref,
  type ResidentLeaseBucketId,
} from "@/lib/portal-detail-routes";
import { decodeLeaseDocumentDetailId, buildResidentLeaseDocumentRows, filterResidentLeaseDocumentRows, resolveResidentLeaseDocumentView } from "@/lib/resident-lease-documents";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import { stageResidentComposePrefill } from "@/lib/resident-compose-prefill";
import { residentLeaseManagerMessageDraft } from "@/lib/resident-manager-message-draft";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import {
  shortToLongTermUpgradeBreakdown,
} from "@/lib/household-charges";
import {
  downloadAiGeneratedLeaseHtml,
  gatherLeaseGenerationContext,
  leaseContextFromApplication,
} from "@/lib/generated-lease";
import {
  hasBothLeaseSignatures,
  runLeaseDownload,
  residentCanViewLeaseRow,
  residentLeaseAuthorized,
  residentSendLeaseToManager,
  residentSignLease,
  residentUploadLeasePdf,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";
import { safeFormatDateTime } from "@/lib/pacific-time";
import { useResidentPortalAxisContext } from "@/hooks/use-resident-portal-axis";

/**
 * Resident Lease section — list of all lease records (current, prior, in progress);
 * each row opens a detail page like Documents › Application.
 */
export function ResidentLeasePanel({
  leaseDetailId,
  bucket = "pending",
  basePath = RESIDENT_PORTAL_BASE_PATH,
}: {
  leaseDetailId?: string;
  bucket?: ResidentLeaseBucketId;
  basePath?: string;
}) {
  const { showToast } = useAppUi();
  const navigate = usePortalNavigate();
  const uploadRef = useRef<HTMLInputElement>(null);
  const { email, residentAxisId, profileManagerId, axisResolved } = useResidentPortalAxisContext();
  const pipelineRow = useResidentLeasePipelineRow();
  const { selectedIds, toggleSelected } = usePortalRowSelection(bucket);
  const listDocumentRows = useMemo(() => {
    if (!pipelineRow) return [];
    return filterResidentLeaseDocumentRows(buildResidentLeaseDocumentRows(pipelineRow), bucket);
  }, [bucket, pipelineRow]);

  const openSelectedLease = useCallback(() => {
    const id = [...selectedIds][0];
    if (!id) return;
    const entry = listDocumentRows.find((row) => row.id === id);
    if (entry) {
      navigate(residentLeaseDetailHref(basePath, entry.filterBucket, entry.id));
    }
  }, [basePath, listDocumentRows, navigate, selectedIds]);

  const leaseSelectionActions = useMemo((): PortalAdaptiveAction[] => {
    if (selectedIds.size !== 1) return [];
    return [
      {
        id: "open",
        keepPriority: 10,
        alwaysVisible: true,
        node: (
          <Button
            type="button"
            variant="primary"
            className={PORTAL_BULK_BAR_BTN}
            data-attr="resident-lease-open-selected"
            onClick={openSelectedLease}
          >
            Open
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="resident-lease-open-selected" onSelect={openSelectedLease}>
            Open
          </DropdownMenuItem>
        ),
      },
    ];
  }, [openSelectedLease, selectedIds.size]);
  const [showSigningModal, setShowSigningModal] = useState(false);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [showMoveOutModal, setShowMoveOutModal] = useState(false);
  const [showRenewModal, setShowRenewModal] = useState(false);
  const [renewInitialTerm, setRenewInitialTerm] = useState<string | undefined>(undefined);

  const detailEntry = useMemo(() => {
    if (!leaseDetailId || !pipelineRow) return null;
    return buildResidentLeaseDocumentRows(pipelineRow).find((row) => row.id === leaseDetailId) ?? null;
  }, [leaseDetailId, pipelineRow]);
  const activeBucket = detailEntry?.filterBucket ?? bucket;
  const listHref = residentLeaseListHref(basePath, activeBucket);
  const documentView = useMemo(
    () => (leaseDetailId && pipelineRow ? resolveResidentLeaseDocumentView(pipelineRow, leaseDetailId) : null),
    [leaseDetailId, pipelineRow],
  );
  const snapshotId = leaseDetailId ? decodeLeaseDocumentDetailId(leaseDetailId).snapshotId : null;
  const isHistoricalDetail = Boolean(snapshotId);
  const isCurrentLeaseDetail = Boolean(leaseDetailId && documentView && !isHistoricalDetail);
  const isPendingDetail = Boolean(
    isCurrentLeaseDetail && pipelineRow && !hasBothLeaseSignatures(pipelineRow),
  );
  const isSignedCurrentDetail = Boolean(
    isCurrentLeaseDetail && pipelineRow && hasBothLeaseSignatures(pipelineRow),
  );

  const leaseAuthorized = useMemo(() => {
    if (!pipelineRow || !email) return false;
    return residentLeaseAuthorized(pipelineRow, {
      email,
      residentAxisId,
      profileManagerId,
    });
  }, [pipelineRow, email, residentAxisId, profileManagerId]);

  const leaseCtx = useMemo(() => {
    if (pipelineRow?.application && Object.keys(pipelineRow.application).length > 0) {
      return leaseContextFromApplication(pipelineRow.application);
    }
    return gatherLeaseGenerationContext();
  }, [pipelineRow]);

  const leaseFullyExecuted = Boolean(pipelineRow && hasBothLeaseSignatures(pipelineRow));
  const leaseVisibleToResident = residentCanViewLeaseRow(pipelineRow) && leaseAuthorized;
  const isPreparingLease = Boolean(email && (!pipelineRow || !leaseVisibleToResident));
  const showSigningWorkflowActions = !leaseFullyExecuted && pipelineRow?.status !== "Fully Signed";

  const residentAlreadySigned = Boolean(pipelineRow?.residentSignature);

  const upgradeBreakdown = useMemo(() => {
    const propertyId = pipelineRow?.propertyId ?? pipelineRow?.application?.propertyId ?? leaseCtx.application?.propertyId;
    if (!propertyId) return null;
    const leaseTerm = pipelineRow?.application?.leaseTerm ?? leaseCtx.application?.leaseTerm ?? "";
    const isShortTerm = leaseTerm.toLowerCase().includes("short") || leaseTerm.toLowerCase().includes("daily");
    if (!isShortTerm) return null;
    return shortToLongTermUpgradeBreakdown(propertyId, false);
  }, [pipelineRow, leaseCtx.application]);

  const upgradeBreakdownMtm = useMemo(() => {
    const propertyId = pipelineRow?.propertyId ?? pipelineRow?.application?.propertyId ?? leaseCtx.application?.propertyId;
    if (!propertyId) return null;
    const leaseTerm = pipelineRow?.application?.leaseTerm ?? leaseCtx.application?.leaseTerm ?? "";
    const isShortTerm = leaseTerm.toLowerCase().includes("short") || leaseTerm.toLowerCase().includes("daily");
    if (!isShortTerm) return null;
    return shortToLongTermUpgradeBreakdown(propertyId, true);
  }, [pipelineRow, leaseCtx.application]);

  const onDownloadAiLease = useCallback(() => {
    downloadAiGeneratedLeaseHtml(leaseCtx);
    showToast("Downloading. Open the file and use Print → Save as PDF to get a PDF.");
  }, [leaseCtx, showToast]);

  const onDownloadLeasePackage = useCallback(() => {
    if (pipelineRow) {
      runLeaseDownload(pipelineRow, showToast);
      return;
    }
    onDownloadAiLease();
  }, [pipelineRow, onDownloadAiLease, showToast]);

  const onSignLease = () => {
    if (!email || leaseFullyExecuted) return;
    if (pipelineRow?.bucket !== "resident") {
      showToast("Signing opens when your manager sends the lease to you for resident signature.");
      return;
    }
    setShowSigningModal(true);
  };

  const handleModalSign = async (signatureName: string, consentVersion: string) => {
    if (!email || !pipelineRow) return false;
    const ok = await residentSignLease(email, signatureName, consentVersion);
    if (ok) {
      const signedRow = {
        ...pipelineRow,
        residentSignature: { role: "resident" as const, name: signatureName, signedAtIso: new Date().toISOString() },
      };
      showToast(hasBothLeaseSignatures(signedRow) ? "Lease fully signed." : "Lease signed. Your manager still needs to sign.");
      setShowSigningModal(false);
      return true;
    } else {
      showToast("Could not sign. Try again.");
      return false;
    }
  };

  const onUploadResidentPdf = async (file: File | null | undefined) => {
    if (!file || !email) return;
    setUploadingPdf(true);
    const result = await residentUploadLeasePdf(email, file);
    setUploadingPdf(false);
    if (uploadRef.current) uploadRef.current.value = "";
    if (result.ok) {
      showToast("Signed PDF uploaded.");
    } else {
      showToast(result.error ?? "Upload failed.");
    }
  };

  const onSendToManager = () => {
    if (!email) return;
    if (residentSendLeaseToManager(email)) {
      showToast("Lease sent to manager.");
    } else {
      showToast("Upload the signed PDF first, then send it to your manager.");
    }
  };

  const handleMoveOutSuccess = useCallback(async () => {
    await syncLeasePipelineFromServer(undefined, { force: true });
    showToast("Your manager was notified. A new lease is being prepared for your review.");
  }, [showToast]);

  const openRequestEdits = useCallback(() => {
    if (!pipelineRow || !documentView) return;
    stageResidentComposePrefill(
      residentLeaseManagerMessageDraft(pipelineRow, {
        leaseTitle: documentView.title,
        requestEdits: true,
      }),
    );
    navigate(`${RESIDENT_PORTAL_BASE_PATH}/communication/active`);
  }, [documentView, navigate, pipelineRow]);

  const downloadTarget =
    documentView?.pipelineRow ??
    (pipelineRow && documentView
      ? ({
          ...pipelineRow,
          generatedHtml: documentView.leaseHtml,
          managerUploadedPdf: documentView.pdfSrc
            ? { dataUrl: documentView.pdfSrc, fileName: "lease.pdf", uploadedAt: documentView.subtitle }
            : pipelineRow.managerUploadedPdf,
        } as typeof pipelineRow)
      : null);

  const leaseDetailFooter =
    leaseDetailId && documentView ? (
      <ResidentDocumentsDetailFooter>
        <Button
          type="button"
          variant="outline"
          className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
          data-attr="resident-lease-request-edits"
          onClick={openRequestEdits}
        >
          Request edits
        </Button>
        {isPendingDetail && pipelineRow ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
              data-attr="resident-lease-download-pdf"
              onClick={onDownloadLeasePackage}
            >
              Download
            </Button>
            {showSigningWorkflowActions && !residentAlreadySigned ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
                  onClick={() => uploadRef.current?.click()}
                  disabled={uploadingPdf}
                >
                  {uploadingPdf ? "Uploading..." : "Upload"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
                  onClick={onSendToManager}
                >
                  Send to manager
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
                  data-attr="resident-sign-lease"
                  onClick={() => onSignLease()}
                >
                  Sign lease
                </Button>
              </>
            ) : null}
          </>
        ) : isSignedCurrentDetail && pipelineRow ? (
          <>
            <Button
              type="button"
              variant="outline"
              className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
              onClick={() => setShowMoveOutModal(true)}
            >
              Renew
            </Button>
            <Button
              type="button"
              variant="outline"
              className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
              data-attr="resident-lease-download-pdf"
              onClick={onDownloadLeasePackage}
            >
              Download
            </Button>
          </>
        ) : downloadTarget ? (
          <Button
            type="button"
            variant="outline"
            className={RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN}
            data-attr="resident-lease-download-pdf"
            onClick={() => runLeaseDownload(downloadTarget, showToast)}
          >
            {documentView.pdfSrc ? "Download lease" : "Download / print lease"}
          </Button>
        ) : null}
      </ResidentDocumentsDetailFooter>
    ) : undefined;

  const leaseDetailBody = documentView ? (
    <div className="px-3 pb-6 pt-2 sm:px-4 text-left">
      <ResidentLeaseBareDocumentPreview
        pdfSrc={documentView.pdfSrc}
        leaseHtml={documentView.leaseHtml}
        title={RESIDENT_LEASE_LIST_LABEL}
      />
      {isPendingDetail &&
      pipelineRow?.managerUploadedPdf?.dataUrl &&
      pipelineRow.status === "Resident Signature Pending" ? (
        <p className="mt-3 rounded-lg border border-border bg-[var(--status-approved-bg)] px-3 py-2.5 text-sm leading-snug text-[var(--status-approved-fg)]">
          Sign in the portal to append an electronic signature page, or upload a manually signed PDF if you prefer.
        </p>
      ) : null}
      {isSignedCurrentDetail && upgradeBreakdown ? (
        <div className="mt-4 rounded-xl border border-border bg-card p-3 sm:p-4">
          <p className="text-xs font-bold uppercase tracking-wide text-[var(--status-approved-fg)]">Upgrade to long-term rental</p>
          <p className="mt-1.5 text-sm text-muted">
            You are currently on a short-term stay. Upgrading creates a new long-term lease. Rent is due on the <strong>1st of every month</strong>; your first month will be prorated based on your move-in date.
          </p>
          <div className="mt-4 space-y-1 text-sm">
            <div className="flex justify-between gap-3 border-b border-blue-100 pb-2">
              <span className="text-muted">Application fee</span>
              <span className="font-medium text-emerald-700">{upgradeBreakdown.applicationFee.label}</span>
            </div>
            <div className="flex justify-between gap-3 border-b border-blue-100 py-2">
              <span className="text-muted">Move-in fee balance</span>
              <span className="font-semibold text-foreground">{upgradeBreakdown.moveInFee.label}</span>
            </div>
            <div className="flex justify-between gap-3 border-b border-blue-100 py-2">
              <span className="text-muted">Security deposit balance</span>
              <span className="font-semibold text-foreground">{upgradeBreakdown.securityDeposit.label}</span>
            </div>
            {upgradeBreakdownMtm?.monthToMonthSurcharge.label ? (
              <div className="flex justify-between gap-3 border-b border-blue-100 py-2">
                <span className="text-muted">Month-to-month option</span>
                <span className="font-medium text-amber-700">+{upgradeBreakdownMtm.monthToMonthSurcharge.label}</span>
              </div>
            ) : null}
            <div className="flex justify-between gap-3 pt-2">
              <span className="font-semibold text-foreground">Total due to upgrade</span>
              <span className="font-bold text-foreground">${upgradeBreakdown.totalDue.toFixed(2)}</span>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="primary"
              className="rounded-full text-sm"
              onClick={() => showToast("Upgrade request sent to your manager. They will prepare your new long-term lease.")}
            >
              Request upgrade to long-term
            </Button>
            <Button
              type="button"
              variant="outline"
              className="rounded-full text-sm"
              onClick={() => showToast("Month-to-month upgrade request sent. Your manager will prepare the lease with the surcharge included.")}
            >
              Request month-to-month
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted">
            Payments will update automatically in your Payments tab once the manager processes your upgrade. If you switch to month-to-month, a new lease at the adjusted rate is required.
          </p>
        </div>
      ) : null}
    </div>
  ) : null;

  const modals = (
    <>
      <input
        ref={uploadRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        aria-hidden
        onChange={(e) => void onUploadResidentPdf(e.target.files?.[0])}
      />
      {showSigningModal && pipelineRow ? (
        <LeaseSigningModal
          row={pipelineRow}
          signerName={leaseCtx.application?.fullLegalName ?? pipelineRow.residentName ?? ""}
          signerRoleLabel="Your full legal name"
          onSign={handleModalSign}
          onClose={() => setShowSigningModal(false)}
        />
      ) : null}

      <LeaseAmendMoveOutModal
        open={showMoveOutModal}
        onClose={() => setShowMoveOutModal(false)}
        currentEnd={pipelineRow?.application?.leaseEnd ?? ""}
        leaseStart={pipelineRow?.application?.leaseStart ?? ""}
        propertyId={pipelineRow?.propertyId ?? pipelineRow?.application?.propertyId ?? ""}
        checkUrl="/api/resident/check-move-out-availability"
        amendUrl="/api/resident/extend-lease"
        onOpenRenew={(leaseTerm) => {
          setRenewInitialTerm(leaseTerm);
          setShowMoveOutModal(false);
          setShowRenewModal(true);
        }}
        onSuccess={() => void handleMoveOutSuccess()}
      />

      {pipelineRow ? (
        <LeaseRenewModal
          open={showRenewModal}
          onClose={() => {
            setShowRenewModal(false);
            setRenewInitialTerm(undefined);
          }}
          initialLeaseTerm={renewInitialTerm}
          currentEnd={pipelineRow.application?.leaseEnd ?? ""}
          currentTerm={pipelineRow.application?.leaseTerm ?? "12-Month"}
          currentRentLabel={pipelineRow.signedRentLabel ?? pipelineRow.application?.managerRentOverride ?? ""}
          propertyId={pipelineRow.propertyId ?? pipelineRow.application?.propertyId ?? ""}
          currentRentalType={pipelineRow.application?.rentalType}
          leaseId={pipelineRow.id}
          renewUrl="/api/resident/renew-lease"
          onSuccess={() => {
            setShowRenewModal(false);
            setRenewInitialTerm(undefined);
            void handleMoveOutSuccess();
          }}
        />
      ) : null}
    </>
  );

  if (!leaseDetailId) {
    const allRows = buildResidentLeaseDocumentRows(pipelineRow);
    const filterTabs = [
      {
        id: "pending" as const,
        label: "Pending",
        count: allRows.filter((row) => row.filterBucket === "pending").length,
      },
      {
        id: "signed" as const,
        label: "Signed",
        count: allRows.filter((row) => row.filterBucket === "signed").length,
      },
    ];
    const filterRow = (
      <LocalDestinationNav
        items={filterTabs.map((tab) => ({
          id: tab.id,
          label: tab.label,
          count: tab.count,
          dataAttr: `resident-lease-bucket-${tab.id}`,
        }))}
        activeId={bucket}
        onChange={(id) => navigate(residentLeaseListHref(basePath, id as ResidentLeaseBucketId))}
        ariaLabel="Lease status"
      />
    );

    return (
      <>
        {modals}
        <ManagerPortalPageShell title="Lease" hideTitleOnMobileNav compactFilterRow>
          <PortalListControlStack className="mb-2 max-lg:mb-2" destinationRow={filterRow} />
          {!email ? (
            <p className="text-sm text-muted">Sign in to view your lease.</p>
          ) : !axisResolved ? (
            <PortalEmptyState variant="plain" icon="lease" title="Loading your leases…" />
          ) : (
            <ResidentLeaseListTable
              basePath={basePath}
              bucket={bucket}
              detailHref={residentLeaseDetailHref}
              selectable={Boolean(email) && axisResolved}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
            />
          )}
        </ManagerPortalPageShell>
        <ResidentPortalListBottomBar
          selectionCount={selectedIds.size}
          selectionActions={leaseSelectionActions}
        />
      </>
    );
  }

  if (!axisResolved) {
    return (
      <>
        {modals}
        <PortalRecordDetailPage
          pageTitle="Lease"
          title="Lease"
          backHref={listHref}
          hideBackText
          bareHeader
          dataAttrBack="resident-lease-detail-back"
          pinScrollBody
        >
          <div className="px-3 py-6">
            <PortalEmptyState variant="plain" icon="lease" title="Loading your lease…" />
          </div>
        </PortalRecordDetailPage>
      </>
    );
  }

  if (!documentView) {
    return (
      <>
        {modals}
        <PortalRecordDetailPage
          pageTitle="Lease"
          title="Lease"
          backHref={listHref}
          hideBackText
          bareHeader
          dataAttrBack="resident-lease-detail-back"
          pinScrollBody
        >
          <div className="px-3 py-6">
            <PortalDataTableEmpty icon="lease" message="Lease not found." />
          </div>
        </PortalRecordDetailPage>
      </>
    );
  }

  return (
    <>
      {modals}
      <PortalRecordDetailPage
        pageTitle="Lease"
        title={RESIDENT_LEASE_LIST_LABEL}
        subtitle={
          detailEntry
            ? residentLeaseDetailSubtitle(detailEntry.status, safeFormatDateTime(detailEntry.signedAt))
            : documentView.subtitle
        }
        backHref={listHref}
        hideBackText
        bareHeader
        dataAttrBack="resident-lease-detail-back"
        pinScrollBody
        footer={leaseDetailFooter}
      >
        {leaseDetailBody}
      </PortalRecordDetailPage>
    </>
  );
}
