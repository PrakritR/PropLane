"use client";
import { PortalAdaptiveActionRow } from "@/components/portal/portal-adaptive-action-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ListSkeleton } from "@/components/ui/list-skeleton";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Flag, PenLine, RefreshCw, Send, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { LeaseAmendMoveOutModal } from "@/components/portal/lease-amend-move-out-modal";
import { LeaseSigningModal } from "@/components/portal/lease-signing-modal";
import { ResidentLeaseReportIssueModal } from "@/components/portal/resident-lease-report-issue-modal";
import { ResidentLeaseSigningFeeCard } from "@/components/portal/resident-lease-signing-fee-card";
import { ResidentLeaseIntakeSection } from "@/components/portal/resident-lease-intake-section";
import { ResidentLeaseFirstSigningWizard, leaseFirstSigningPhase } from "@/components/portal/resident-lease-first-signing-wizard";
import { ManagerPortalPageShell } from "@/components/portal/portal-metrics";
import { PortalEmptyState } from "@/components/portal/portal-empty-state";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import {
  RESIDENT_LEASE_LIST_LABEL,
  ResidentLeaseBareDocumentPreview,
  residentLeaseDetailSubtitle,
} from "@/components/portal/resident-lease-document-preview";
import { ResidentLeaseListTable, useResidentLeasePipelineRow } from "@/components/portal/resident-lease-list";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  residentDocumentsDownloadAction,
  residentDocumentsOpenAction,
} from "@/components/portal/resident-documents-bulk";
import type { PortalAdaptiveAction } from "@/components/portal/portal-adaptive-action-row";
import {
  RESIDENT_PORTAL_DEFAULT_GROUP_MODE,
} from "@/components/portal/resident-portal-grouped-data-list";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import {
  residentLeaseDetailHref,
  residentLeaseListHref,
  parseResidentLeaseDetailTab,
  type ResidentLeaseBucketId,
} from "@/lib/portal-detail-routes";
import { recordSections } from "@/lib/portals/record-sections";
import { renderRecordSection } from "@/components/portal/record-section-renderers";
import { PortalRecordSectionChrome, PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { PortalListEmptyCard } from "@/components/portal/portal-list-empty-card";
import { decodeLeaseDocumentDetailId, buildResidentLeaseDocumentRows, filterResidentLeaseDocumentRows, residentLeaseStatusFilterTabs, resolveResidentLeaseDocumentView } from "@/lib/resident-lease-documents";
import { RESIDENT_PORTAL_BASE_PATH } from "@/lib/portals/resident-sections";
import {
  shortToLongTermUpgradeBreakdown,
} from "@/lib/household-charges";
import {
  downloadAiGeneratedLeaseHtml,
  gatherLeaseGenerationContext,
  leaseContextFromApplication,
} from "@/lib/generated-lease";
import {
  ensureLeaseDocumentLoaded,
  hasBothLeaseSignatures,
  leaseRowCarriesDocumentBytes,
  runLeaseDownload,
  residentCanViewLeaseRow,
  residentLeaseAuthorized,
  residentReportLeaseIssue,
  residentSendLeaseToManager,
  residentSignLease,
  residentUploadLeasePdf,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";
import { residentLeaseRenewalStatus } from "@/lib/resident-lease-renewal-status";
import { cn } from "@/lib/utils";
import { safeFormatDateTime } from "@/lib/pacific-time";
import { useResidentLeaseSigningFee } from "@/hooks/use-resident-lease-signing-fee";
import { useResidentPortalAxisContext } from "@/hooks/use-resident-portal-axis";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { usePortalNavigate } from "@/lib/portal-nav-client";

/**
 * Phone-only sticky "Sign lease" bar, pinned just above the native/mobile
 * bottom tab bar (same `--portal-native-bottom-nav-inset` offset
 * {@link PortalResidentListFab} anchors its FAB to). The lease detail page's
 * header still carries the icon-only action for desktop parity; on phone
 * this is the discoverable, one-tap path to the signing modal instead of a
 * small header icon the resident has to notice first (C128).
 */
export function ResidentLeaseSignStickyBar({
  onSign,
  disabled,
  label,
}: {
  onSign: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <div
      className="fixed inset-x-0 z-[44] flex justify-center px-3 lg:hidden"
      style={{ bottom: "calc(var(--portal-native-bottom-nav-inset, 0px) + 0.75rem)" }}
      data-attr="resident-lease-sign-sticky-bar"
    >
      <Button
        type="button"
        variant="primary"
        className="w-full max-w-md rounded-full py-3 text-base font-semibold shadow-[0_12px_28px_-12px_rgba(47,107,255,0.75)]"
        disabled={disabled}
        data-attr="resident-lease-sign-sticky-bar-button"
        onClick={onSign}
      >
        {label}
      </Button>
    </div>
  );
}

/**
 * Resident Lease section — list of all lease records (current, prior, in progress);
 * each row opens a detail page like Documents › Application.
 */
export function ResidentLeasePanel({
  leaseDetailId,
  bucket = "pending",
  basePath = RESIDENT_PORTAL_BASE_PATH,
  leaseDetailTab,
}: {
  leaseDetailId?: string;
  bucket?: ResidentLeaseBucketId;
  basePath?: string;
  leaseDetailTab?: string;
}) {
  const { showToast } = useAppUi();
  const portalNavigate = usePortalNavigate();
  const router = useRouter();
  const searchParams = useSearchParams();
  const uploadRef = useRef<HTMLInputElement>(null);
  const { email, residentAxisId, profileManagerId, axisResolved } = useResidentPortalAxisContext();
  const pipelineRow = useResidentLeasePipelineRow();
  const [showSigningModal, setShowSigningModal] = useState(false);
  const [signError, setSignError] = useState<string | null>(null);
  const [showReportIssueModal, setShowReportIssueModal] = useState(false);
  const [uploadingPdf, setUploadingPdf] = useState(false);
  const [showMoveOutModal, setShowMoveOutModal] = useState(false);

  const allLeaseRows = useMemo(() => buildResidentLeaseDocumentRows(pipelineRow), [pipelineRow]);
  const { selectedIds, toggleSelected } = usePortalRowSelection(bucket);
  const bucketRows = useMemo(
    () => filterResidentLeaseDocumentRows(allLeaseRows, bucket),
    [allLeaseRows, bucket],
  );

  const leaseSelectionActions = useMemo((): PortalAdaptiveAction[] => {
    if (selectedIds.size !== 1) return [];
    const entry = bucketRows.find((row) => row.id === [...selectedIds][0]);
    if (!entry) return [];
    const openSelected = () => {
      portalNavigate(residentLeaseDetailHref(basePath, bucket, entry.id));
    };
    const actions: PortalAdaptiveAction[] = [
      residentDocumentsOpenAction("Open", openSelected, "resident-lease-open-selected"),
    ];
    if (entry.filterBucket === "signed") {
      const downloadTarget = entry.pipelineRow ?? pipelineRow;
      actions.push(
        residentDocumentsDownloadAction(
          "Download",
          () => {
            if (downloadTarget) runLeaseDownload(downloadTarget, showToast);
            else showToast("Lease document is not ready to download yet.");
          },
          "resident-lease-download-selected",
          !downloadTarget,
        ),
      );
    }
    return actions;
  }, [basePath, bucket, bucketRows, pipelineRow, portalNavigate, selectedIds, showToast]);

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

  // The resident's local copy of a sent lease is the slim list projection —
  // no document bytes, by design (lease-pipeline-list-projection.ts). Opening
  // the detail page loads the full document, and signing stays disabled until
  // it has, so nobody signs (or has their signature hashed against) a blank
  // page.
  const leaseDocumentLoaded = Boolean(pipelineRow && leaseRowCarriesDocumentBytes(pipelineRow));
  useEffect(() => {
    if (!leaseDetailId || !pipelineRow || leaseDocumentLoaded) return;
    void ensureLeaseDocumentLoaded(pipelineRow.id, undefined, pipelineRow);
  }, [leaseDetailId, pipelineRow, leaseDocumentLoaded]);

  const residentAlreadySigned = Boolean(pipelineRow?.residentSignature);

  /**
   * Signing fee. The plan's order is form → sign → pay, so a signature is never
   * blocked on payment; the fee becomes the one remaining step afterwards, and
   * the lease is not complete from the resident's side until it is settled.
   */
  const signingFee = useResidentLeaseSigningFee(pipelineRow?.id);
  const signingFeeDue = signingFee.ready && signingFee.feeCents > 0 && !signingFee.paid;
  const refreshSigningFee = signingFee.refresh;
  // The lease row arrives asynchronously, so this effect re-runs once the fee
  // hook rebinds. One verification per Stripe session is enough.
  const verifiedSessionRef = useRef("");

  useEffect(() => {
    if (searchParams.get("signing_fee") !== "return") return;
    const sessionId = searchParams.get("session_id")?.trim();
    const clearQuery = () => router.replace(`${basePath}/lease`);
    if (!sessionId) {
      clearQuery();
      return;
    }
    if (verifiedSessionRef.current === sessionId) return;
    verifiedSessionRef.current = sessionId;
    void (async () => {
      try {
        const res = await fetch(
          `/api/stripe/lease-signing-fee-verify?session_id=${encodeURIComponent(sessionId)}`,
        );
        const data = (await res.json().catch(() => ({}))) as {
          paid?: boolean;
          processing?: boolean;
          error?: string;
        };
        if (data.paid) {
          await refreshSigningFee();
          showToast("Lease signing fee paid. Thank you.");
        } else if (data.processing) {
          showToast("Payment submitted. We will mark it paid when it clears.");
        } else {
          showToast(typeof data.error === "string" ? data.error : "Payment not completed yet.");
        }
      } catch {
        showToast("Could not verify your payment.");
      } finally {
        clearQuery();
      }
    })();
  }, [basePath, refreshSigningFee, router, searchParams, showToast]);

  const canReportLeaseIssue = Boolean(
    pipelineRow &&
      pipelineRow.bucket === "resident" &&
      pipelineRow.status === "Resident Signature Pending" &&
      !residentAlreadySigned,
  );

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

  /**
   * The renewal line at the top of the Lease tab. Until now the only way to
   * extend was to open a signed lease's detail page and find "Renew" in the
   * footer, so a resident whose lease ended in two weeks saw nothing about it on
   * the screen they actually land on.
   */
  const renewalStatus = useMemo(() => residentLeaseRenewalStatus(pipelineRow), [pipelineRow]);

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
    if (!leaseDocumentLoaded) {
      showToast("Your lease is still loading. Try again in a moment.");
      return;
    }
    setSignError(null);
    setShowSigningModal(true);
  };

  const handleModalSign = async (signatureName: string, consentVersion: string) => {
    if (!email || !pipelineRow) return false;
    setSignError(null);
    const result = await residentSignLease(email, signatureName, consentVersion);
    if (result.ok) {
      const signedRow = {
        ...pipelineRow,
        residentSignature: { role: "resident" as const, name: signatureName, signedAtIso: new Date().toISOString() },
      };
      showToast(hasBothLeaseSignatures(signedRow) ? "Lease fully signed." : "Lease signed. Your manager still needs to sign.");
      setShowSigningModal(false);
      return true;
    } else {
      // Signing waits for the server: nothing is marked signed until this
      // point, so the modal stays open and shows the real reason.
      setSignError(result.error);
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

  const handleReportLeaseIssue = async (message: string) => {
    if (!pipelineRow) return false;
    const result = await residentReportLeaseIssue(pipelineRow.id, message);
    if (result.ok) {
      showToast("Your manager was notified. The lease is back under review.");
      return true;
    }
    showToast(result.error ?? "Could not send your report.");
    return false;
  };

  const handleMoveOutSuccess = useCallback(async () => {
    await syncLeasePipelineFromServer(undefined, { force: true });
    showToast("Your manager was notified. A new lease is being prepared for your review.");
  }, [showToast]);

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

  const leaseDetailActions =
    leaseDetailId && documentView ? (
      <PortalRecordActions>
        {isPendingDetail && pipelineRow ? (
          <>
            <PortalIconAction
              icon={Download}
              label="Download"
              data-attr="resident-lease-download-pdf"
              onClick={onDownloadLeasePackage}
            />
            {showSigningWorkflowActions && !residentAlreadySigned ? (
              <>
                <PortalIconAction
                  icon={Upload}
                  label={uploadingPdf ? "Uploading…" : "Upload"}
                  disabled={uploadingPdf}
                  onClick={() => uploadRef.current?.click()}
                />
                {canReportLeaseIssue ? (
                  <PortalIconAction
                    icon={Flag}
                    label="Report issue"
                    data-attr="resident-lease-report-issue"
                    onClick={() => setShowReportIssueModal(true)}
                  />
                ) : null}
                <PortalIconAction icon={Send} label="Send to manager" onClick={onSendToManager} />
                <PortalIconAction
                  icon={PenLine}
                  label={leaseDocumentLoaded ? "Sign lease" : "Loading lease…"}
                  tone="primary"
                  disabled={!leaseDocumentLoaded}
                  data-attr="resident-sign-lease"
                  onClick={() => onSignLease()}
                />
              </>
            ) : null}
          </>
        ) : isSignedCurrentDetail && pipelineRow ? (
          <>
            <PortalIconAction icon={RefreshCw} label="Renew" onClick={() => setShowMoveOutModal(true)} />
            <PortalIconAction
              icon={Download}
              label="Download"
              data-attr="resident-lease-download-pdf"
              onClick={onDownloadLeasePackage}
            />
          </>
        ) : downloadTarget ? (
          <PortalIconAction
            icon={Download}
            label={documentView.pdfSrc ? "Download lease" : "Download / print lease"}
            data-attr="resident-lease-download-pdf"
            onClick={() => runLeaseDownload(downloadTarget, showToast)}
          />
        ) : null}
      </PortalRecordActions>
    ) : undefined;

  const signingFeeCard =
    signingFeeDue && pipelineRow ? (
      <ResidentLeaseSigningFeeCard
        leaseId={pipelineRow.id}
        managerUserId={signingFee.managerUserId}
        propertyId={signingFee.propertyId}
        feeCents={signingFee.feeCents}
        alreadySigned={residentAlreadySigned}
      />
    ) : null;

  const leaseFirstPhase = pipelineRow ? leaseFirstSigningPhase(pipelineRow) : null;

  const leaseDetailBody = documentView || pipelineRow ? (
    <div className="px-3 pb-6 pt-2 sm:px-4 text-left">
      {pipelineRow ? (
        <ResidentLeaseIntakeSection
          row={pipelineRow}
          onSaved={() => {
            void syncLeasePipelineFromServer(undefined, { force: true });
          }}
        />
      ) : null}
      {pipelineRow && leaseFirstPhase ? (
        <ResidentLeaseFirstSigningWizard
          row={pipelineRow}
          onSaved={() => {
            void syncLeasePipelineFromServer(undefined, { force: true });
          }}
          onReachedSign={() => onSignLease()}
        />
      ) : null}
      {signingFeeCard ? <div className="mb-3">{signingFeeCard}</div> : null}
      {documentView && leaseFirstPhase !== "in-progress" ? (
        <ResidentLeaseBareDocumentPreview
          pdfSrc={documentView.pdfSrc}
          leaseHtml={documentView.leaseHtml}
          title={RESIDENT_LEASE_LIST_LABEL}
        />
      ) : null}
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
          onClose={() => {
            setShowSigningModal(false);
            setSignError(null);
          }}
          error={signError}
        />
      ) : null}
      <ResidentLeaseReportIssueModal
        open={showReportIssueModal}
        onClose={() => setShowReportIssueModal(false)}
        onSubmit={handleReportLeaseIssue}
      />

      <LeaseAmendMoveOutModal
        open={showMoveOutModal}
        onClose={() => setShowMoveOutModal(false)}
        currentEnd={pipelineRow?.application?.leaseEnd ?? ""}
        leaseStart={pipelineRow?.application?.leaseStart ?? ""}
        propertyId={pipelineRow?.propertyId ?? pipelineRow?.application?.propertyId ?? ""}
        checkUrl="/api/resident/check-move-out-availability"
        amendUrl="/api/resident/extend-lease"
        renew={
          pipelineRow
            ? {
                leaseId: pipelineRow.id,
                currentTerm: pipelineRow.application?.leaseTerm ?? "12-Month",
                currentRentLabel: pipelineRow.signedRentLabel ?? pipelineRow.application?.managerRentOverride ?? "",
                currentRentalType: pipelineRow.application?.rentalType,
                renewUrl: "/api/resident/renew-lease",
              }
            : undefined
        }
        onSuccess={() => void handleMoveOutSuccess()}
      />
    </>
  );

  if (!leaseDetailId) {
    // One computation feeds both the tab bar and every other Pending/Signed
    // count on this page — the same helper `resident-lease-list.tsx` uses —
    // so the two can never quietly disagree (C127).
    const filterTabs = residentLeaseStatusFilterTabs(allLeaseRows).filter(
      (tab): tab is typeof tab & { id: "pending" | "signed" } => tab.id === "pending" || tab.id === "signed",
    );

    return (
      <>
        {modals}
        <ManagerPortalPageShell title="Lease" hideTitleOnMobileNav compactFilterRow>
          <PortalListControlStack
            className="mb-2 max-lg:mb-1.5"
            variant="command"
            destinations={filterTabs.map((tab) => ({
              id: tab.id,
              label: tab.label,
              href: residentLeaseListHref(basePath, tab.id),
              count: tab.count,
              dataAttr: `resident-lease-bucket-${tab.id}`,
            }))}
            activeDestinationId={bucket}
            destinationAriaLabel="Lease status"
          />
          {signingFeeCard ? <div className="mb-3 max-lg:mb-2.5">{signingFeeCard}</div> : null}
          {renewalStatus.kind !== "none" ? (
            <div
              className={cn(
                "mb-3 rounded-2xl border px-4 py-3.5 max-lg:mb-2.5",
                renewalStatus.kind === "awaiting_signature"
                  ? "portal-banner-pending"
                  : renewalStatus.kind === "ending" && renewalStatus.soon
                    ? "portal-banner-pending"
                    : "border-border bg-accent/30",
              )}
              data-attr="resident-lease-renewal-banner"
              data-renewal-kind={renewalStatus.kind}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-[12rem] flex-1">
                  <p className="text-sm font-semibold text-foreground">{renewalStatus.headline}</p>
                  <p className="mt-1 text-xs text-muted">{renewalStatus.body}</p>
                </div>
                {renewalStatus.kind !== "awaiting_signature" ? (
                  <Button
                    type="button"
                    variant="primary"
                    className="h-9 min-h-0 shrink-0 rounded-full px-4 text-[13px]"
                    data-attr="resident-lease-renew-open"
                    onClick={() => setShowMoveOutModal(true)}
                  >
                    {renewalStatus.cta}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
          <PortalRecordListSurface className="mt-0" onBulkClear={() => { for (const id of selectedIds) toggleSelected(id); }} bulkCount={selectedIds.size} bulkActions={<PortalAdaptiveActionRow actions={leaseSelectionActions} />}>{!email ? (
            <p className="text-sm text-muted">Sign in to view your lease.</p>
          ) : !axisResolved ? (
            <ListSkeleton rows={3} showLeading={false} />
          ) : (
            <ResidentLeaseListTable
              basePath={basePath}
              bucket={bucket}
              detailHref={residentLeaseDetailHref}
              groupMode={RESIDENT_PORTAL_DEFAULT_GROUP_MODE}
              selectable={axisResolved && Boolean(email)}
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
            />
          )}</PortalRecordListSurface>
        </ManagerPortalPageShell>

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

  const activeTab = parseResidentLeaseDetailTab(leaseDetailTab);
  const sections = recordSections("resident", "lease", { basePath, bucket: activeBucket });
  const residentSigned = pipelineRow?.residentSignature != null;
  const managerSigned = pipelineRow?.managerSignature != null;
  const overviewContent = renderRecordSection("overview", {
    role: "resident",
    kind: "lease",
    kindLabel: "lease",
    recordId: leaseDetailId ?? "lease",
    overviewTiles: [
      { id: "rent", label: "Rent", value: pipelineRow?.signedRentLabel ?? "—", detail: "per month" },
      { id: "term", label: "Term", value: pipelineRow?.application?.leaseTerm ?? "—", detail: pipelineRow?.application?.leaseEnd ? `Ends ${pipelineRow.application.leaseEnd}` : undefined },
      { id: "your-signature", label: "Your signature", value: residentSigned ? "Signed" : "Pending", tone: residentSigned ? "default" : "danger", detail: managerSigned ? "Manager signed" : undefined },
      { id: "move-in", label: "Move-in", value: pipelineRow?.application?.leaseStart ?? "—" },
    ],
    overviewNeeds: [
      ...(!residentSigned ? [{ id: "sign", title: "Sign your lease", detail: managerSigned ? "Manager signed" : "Awaiting your signature", onClick: () => onSignLease() }] : []),
      // Sign first, pay after: an unpaid fee is what keeps the lease from being
      // finished on the resident's side, so it stays on the needs list.
      ...(signingFeeDue
        ? [
            {
              id: "signing-fee",
              title: `Pay your lease signing fee · $${(signingFee.feeCents / 100).toFixed(2)}`,
              detail: residentSigned ? "Last step to complete your lease" : "Due after you sign",
              onClick: () =>
                portalNavigate(
                  residentLeaseDetailHref(basePath, activeBucket, leaseDetailId ?? "", "lease-document"),
                ),
            },
          ]
        : []),
    ],
    overviewCards: [
      {
        id: "terms",
        title: "Terms",
        action: { label: "Lease document", href: residentLeaseDetailHref(basePath, activeBucket, leaseDetailId ?? "", "lease-document") },
        rows: [
          { label: "Property", value: documentView.subtitle ?? "—" },
          { label: "Rent", value: pipelineRow?.signedRentLabel ?? "—" },
        ],
      },
      {
        id: "signatures",
        title: "Signatures",
        action: { label: "Lease document", href: residentLeaseDetailHref(basePath, activeBucket, leaseDetailId ?? "", "lease-document") },
        rows: [
          { label: "Manager", value: managerSigned ? "Signed" : "Not signed", tone: managerSigned ? "ok" : "bad" },
          { label: "You", value: residentSigned ? "Signed" : "Pending", tone: residentSigned ? "ok" : "bad" },
        ],
      },
      {
        id: "payments",
        title: "Payments",
        kind: "rows",
        rows: [],
        emptyLabel: "No payments linked yet",
      },
    ],
  });
  const onLeaseHeaderAction = (actionId: string) => {
    if (actionId === "sign") { onSignLease(); return; }
    if (actionId === "download") { onDownloadLeasePackage(); return; }
    showToast("Coming soon");
  };
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
        iconTitleActions
        dataAttrBack="resident-lease-detail-back"
        pinScrollBody
      >
        {activeTab === "lease-document" ? (
          <>
            {leaseDetailActions}
          </>
        ) : (
          <PortalRecordActions>
            <PortalRecordHeaderIconActions actions={sections.headerActions} onAction={onLeaseHeaderAction} />
          </PortalRecordActions>
        )}
        <PortalRecordSectionChrome
          sections={sections}
          recordId={leaseDetailId ?? ""}
          activeId={activeTab}
          title={RESIDENT_LEASE_LIST_LABEL}
          backHref={listHref}
          backLabel="All leases"
          ariaLabel="Lease sections"
        >
          {activeTab === "lease-document" ? (
            leaseDetailBody
          ) : activeTab === "payments" ? (
            <div className="px-3 pb-4 sm:px-4">
              <PortalListEmptyCard title="No payments linked yet" workspaceAware={false} dataAttr="resident-lease-payments-empty" />
            </div>
          ) : activeTab === "communication" ? (
            renderRecordSection("communication", {
              role: "resident",
              kind: "lease",
              kindLabel: "lease",
              recordId: leaseDetailId ?? "lease",
            })
          ) : (
            overviewContent
          )}
        </PortalRecordSectionChrome>
      </PortalRecordDetailPage>
      {showSigningWorkflowActions && !residentAlreadySigned ? (
        <ResidentLeaseSignStickyBar
          onSign={() => onSignLease()}
          disabled={!leaseDocumentLoaded}
          label={leaseDocumentLoaded ? "Sign lease" : "Loading lease…"}
        />
      ) : null}
    </>
  );
}
