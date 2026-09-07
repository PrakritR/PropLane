"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { Badge } from "@/components/ui/badge";
import { PortalRecordShareLinkButton } from "@/components/portal/portal-record-share-link-button";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  ManagerPortalPageShell,
  PORTAL_COMMAND_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_BTN,
  PORTAL_COMMAND_PRIMARY_ACTION_STYLE,
  PORTAL_HEADER_ACTION_BTN,
} from "@/components/portal/portal-metrics";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { armFilterSheetOpenSuppressFromOverlayDismiss } from "@/components/ui/field-select-portal-interaction";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import {
  PortalFooterFitActionRow,
  type PortalFooterFitAction,
} from "@/components/portal/portal-footer-fit-action-row";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import {
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_DETAIL_BTN,
  RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN,
  ResidentDocumentsDetailFooter,
  PortalDataTableEmpty,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import { ApplicationDetailReviewBody } from "@/components/portal/application-detail-review-body";
import { downloadBackgroundCheckForApplication, ApplicationScreeningPanel } from "@/components/portal/application-screening-panel";
import { ApplicationHoldingFeeModal } from "@/components/portal/application-holding-fee-box";
import { ManagerEditApplicationModal } from "@/components/portal/pro-edit-application-modal";
import { ManagerApplicationOnBehalfModal } from "@/components/portal/pro-application-on-behalf-modal";
import { PORTAL_LIST_ADD_ICONS } from "@/components/portal/portal-list-add-row";
import { PORTAL_BULK_BAR_BTN } from "@/lib/portal-bulk-bar";
import { usePortalRowSelection } from "@/hooks/use-portal-row-selection";
import { CheckrScreeningModal } from "@/components/portal/checkr-screening-modal";
import { ManagerScreeningSettingsModal } from "@/components/portal/pro-screening-settings";
import { ManagerPortalSettingsModal } from "@/components/portal/pro-portal-settings-modal";
import type { DemoApplicantRow, ManagerApplicationBucket } from "@/data/demo-portal";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import {
  MANAGER_APPLICATIONS_EVENT,
  deleteManagerApplicationFromServer,
  normalizeApplicationAxisId,
  readManagerApplicationRows,
  syncManagerApplicationsFromServer,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import {
  MANAGER_PORTFOLIO_REFRESH_EVENTS,
  applicationVisibleToPortalUser,
  buildManagerPropertyFilterOptions,
} from "@/lib/manager-portfolio-access";
import { PortalPageScrollBody } from "@/lib/portal-page-chrome-layout";
import { buildManagerShareablePropertyOptions } from "@/lib/manager-property-links";
import { syncPropertyPipelineFromServer, hasCachedPropertyPipeline } from "@/lib/demo-property-pipeline";
import { transitionApplicationBucket } from "@/lib/application-review";
import { useApplicationAutomation } from "@/hooks/use-application-automation";
import { selectAutoApprovals } from "@/lib/auto-approve-trigger";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import {
  fetchCosignerSubmissionsForSignerAppId,
  readCosignerSubmissionsForSignerAppId,
} from "@/lib/cosigner-submissions-storage";
import { buildApplicationHtml } from "@/lib/manager-application-html";
import { applicationPdfFilename } from "@/lib/manager-application-pdf";
import {
  downloadFetchedUrl,
  portalDownloadToastMessage,
  type PortalDownloadResult,
} from "@/lib/portal-document-download";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { getBundleChoiceLabel, getRoomChoiceLabel } from "@/lib/rental-application/data";
import type { ApplicationGroupMember } from "@/lib/rental-application/application-groups";
import {
  inProgressApplicationResumeUrl,
  applicationStageDisplayLabel,
  INCOMPLETE_APPLICATION_LABEL,
  isInProgressApplicationRow,
  shouldOfferApplicationCompletionReminder,
} from "@/lib/rental-application/in-progress-application";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { applicantDisplayName, applicantSecondaryEmail } from "@/lib/rental-application/applicant-name";
import { ManagerApplicationsGroupedTable } from "@/components/portal/pro-applications-grouped-table";
import {
  groupIdForRow,
  groupRowInputForRow,
} from "@/components/portal/application-group-section";
import { ManagerCosignerReadonlyReview } from "@/components/portal/pro-cosigner-readonly-review";
import { useCosignerSubmissionsMap } from "@/hooks/use-cosigner-submissions-map";
import {
  buildCosignerScreeningRow,
  cosignerShowsBackgroundCheck,
} from "@/lib/cosigner-screening";
import {
  buildScreeningSubjects,
  cosignerSubmissionIdForSubject,
  resolveScreeningSubjectId,
  screeningRowForSubject,
} from "@/lib/background-check-subjects";
import { sortApplicationRowsForBucket } from "@/lib/manager-application-list";
import {
  applicationListSortBucket,
  buildApplicationListClusters,
  signerAppIdsForCosignerLookup,
  sortApplicationListClustersForBucket,
} from "@/lib/rental-application/application-list-grouping";
import { buildBundleApplicationGroups } from "@/lib/bundle-group/bundle-group-application";
import { groupForRow } from "@/lib/rental-application/application-groups";
import {
  APPLICATION_COMPLETION_REMINDER_SUBJECT,
  buildApplicationCompletionReminderBody,
} from "@/lib/application-completion-reminder-email";
import {
  findHoldingDepositCharge,
  removeAllApplicationCharges,
  syncHouseholdChargesFromServer,
} from "@/lib/household-charges";
import {
  deleteLeasePipelineRowsForResident,
} from "@/lib/lease-pipeline-storage";
import {
  RESIDENT_WELCOME_EMAIL_SUBJECT,
  buildResidentWelcomeEmailBody,
  residentAccountCreationUrl,
} from "@/lib/resident-welcome-email";
import { resolveManagerScopeUserId } from "@/lib/demo/demo-session";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import {
  applicationDetailHref,
  applicationListHref,
  type ApplicationDetailTabId,
  type ApplicationListTabId,
} from "@/lib/portal-detail-routes";
import {
  appendPortalPropertyFilterQuery,
  parsePortalPropertyFilterQuery,
  portalPropertyFilterIdsEqual,
  sanitizePortalPropertyFilterIds,
} from "@/lib/portal-property-list-filters";
function isApprovableApplicationRow(row: DemoApplicantRow): boolean {
  if (isWithdrawnApplicationRow(row) || isInProgressApplicationRow(row)) return false;
  return row.bucket === "pending" || row.bucket === "rejected";
}

function applicationRowCanMoveToPending(row: DemoApplicantRow): boolean {
  return row.bucket === "approved" || row.bucket === "rejected";
}

function applicationRowPropertyId(row: DemoApplicantRow): string {
  return row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
}

function applicationRowsForPropertyFilters(rows: DemoApplicantRow[], propertyFilters: string[]): DemoApplicantRow[] {
  if (propertyFilters.length === 0) return rows;
  return rows.filter((r) => propertyFilters.includes(applicationRowPropertyId(r)));
}

function countByBucket(rows: DemoApplicantRow[]) {
  const c = { pending: 0, approved: 0, rejected: 0 };
  for (const r of rows) {
    c[r.bucket] += 1;
  }
  return c;
}

/**
 * UI-only tab id. The stored data model only ever has three buckets
 * (`ManagerApplicationBucket`) — "Incomplete" is not one of them, it is the
 * subset of the "pending" bucket whose `stage` is still "In progress"
 * (`isInProgressApplicationRow`). Splitting it into its own TAB (rather than
 * leaving it mixed into Pending with just an annotated label) is a display
 * concern only; every row keeps `bucket: "pending"` in storage, so Approve /
 * Reject / delete and the underlying query are unaffected.
 */
type ManagerApplicationTabId = ApplicationListTabId;

/** Which tab a row belongs to for DISPLAY — never confuse with `row.bucket`. */
function tabForRow(row: DemoApplicantRow): ManagerApplicationTabId {
  if (row.bucket !== "pending") return row.bucket;
  return isInProgressApplicationRow(row) ? "incomplete" : "pending";
}

function applicationsListEmptyMessage(tab: ManagerApplicationTabId): string {
  switch (tab) {
    case "pending":
      return "No applications pending review yet.";
    case "incomplete":
      return "No in-progress applications yet.";
    case "approved":
      return "No approved applications yet.";
    case "rejected":
      return "No rejected applications yet.";
    default:
      return "No applications in this tab yet.";
  }
}

/** Client-resolved room label used by both the PDF download and the inline document view. */
function applicationRoomLabel(row: DemoApplicantRow): string {
  const roomChoice = row.assignedRoomChoice?.trim() || row.application?.roomChoice1?.trim() || "";
  const roomLabel = getRoomChoiceLabel(roomChoice);
  if (roomLabel) return roomLabel;
  // Bundle applications carry no ranked room choice — label by the bundle.
  const bundleId = row.application?.bundleId?.trim() || "";
  const propertyId = row.application?.propertyId?.trim() || row.propertyId?.trim() || "";
  return bundleId && propertyId ? getBundleChoiceLabel(propertyId, bundleId) : "";
}

/** Server PDF endpoint for an application, with the client-resolved room label as a display hint. */
export function applicationPdfHref(row: DemoApplicantRow, opts?: { inline?: boolean }): string {
  const params = new URLSearchParams();
  const roomLabel = applicationRoomLabel(row);
  if (roomLabel) params.set("roomLabel", roomLabel);
  if (opts?.inline) params.set("disposition", "inline");
  const query = params.toString();
  return `/api/manager-applications/${encodeURIComponent(row.id)}/pdf${query ? `?${query}` : ""}`;
}

/** Fetch the application PDF and save it — works on phone via blob download or the share sheet. */
export async function downloadApplicationPdf(row: DemoApplicantRow): Promise<PortalDownloadResult> {
  if (typeof window === "undefined") return "failed";
  return downloadFetchedUrl(
    applicationPdfHref(row),
    applicationPdfFilename(row),
    "application/pdf",
    "Application",
  );
}

/** Fire-and-forget helper for click handlers that already show their own toast. */
export function runApplicationPdfDownload(
  row: DemoApplicantRow,
  showToast: (message: string) => void,
): void {
  void downloadApplicationPdf(row).then((result) => {
    const message = portalDownloadToastMessage(result, "application");
    if (message) showToast(message);
  });
}

export function ApplicationPdfDownloadButton({
  row,
  label = "Download PDF",
  className = PORTAL_DETAIL_BTN,
}: {
  row: DemoApplicantRow;
  label?: string;
  className?: string;
}) {
  const { showToast } = useAppUi();
  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      data-attr="application-pdf-download"
      onClick={() => runApplicationPdfDownload(row, showToast)}
    >
      {label}
    </Button>
  );
}

/**
 * Inline application preview — HTML from saved answers, or the official PDF via
 * the manager applications route (Documents tab + resident detail).
 */
export function ApplicationDocumentPreview({
  row,
  collapsible = true,
  showDownload = true,
  downloadLabel = "Download PDF",
  bareCanvas = false,
  stretch = false,
  flow = false,
  variant = "html",
  downloadPlacement = "bottom",
  groupMembers = [],
  className,
}: {
  row: DemoApplicantRow;
  collapsible?: boolean;
  showDownload?: boolean;
  downloadLabel?: string;
  /** Flat on the portal page canvas — no white document card chrome. */
  bareCanvas?: boolean;
  /** Fill the parent flex area with a scrollable document frame (resident profile tab). */
  stretch?: boolean;
  /**
   * Expand with the document on the page scroll — no nested document frame scroll
   * (resident profile application tab with verification photos below).
   */
  flow?: boolean;
  /** `pdf` renders the server-built application PDF; `html` uses saved answers. */
  variant?: "html" | "pdf";
  /** Where the download action sits relative to the preview frame. */
  downloadPlacement?: "top" | "bottom";
  /** Other group-application members embedded in demo/HTML previews; server PDF loads these itself. */
  groupMembers?: ApplicationGroupMember[];
  className?: string;
}) {
  const demo = isDemoModeActive();
  const [cosignerSubmissions, setCosignerSubmissions] = useState<CosignerSubmission[]>([]);
  const [demoPdfUrl, setDemoPdfUrl] = useState<string | null>(null);
  const [demoPdfLoading, setDemoPdfLoading] = useState(false);
  const previewKey = [
    row.id,
    row.bucket,
    applicationRoomLabel(row),
    row.application?.hasCosigner === "yes" ? "cosigner" : "",
    row.application?.rentalType ?? "",
    variant,
    groupMembers.map((m) => m.id).join(","),
  ].join("|");

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the row changes
    setCosignerSubmissions([]);
    if (variant === "html" && row.application?.hasCosigner !== "yes") return;
    if (variant === "pdf" && row.application?.hasCosigner !== "yes" && !demo) return;
    if (demo) {
      setCosignerSubmissions(readCosignerSubmissionsForSignerAppId(row.id));
      return;
    }
    if (row.application?.hasCosigner !== "yes") return;
    let cancelled = false;
    void fetchCosignerSubmissionsForSignerAppId(row.id)
      .catch(() => readCosignerSubmissionsForSignerAppId(row.id))
      .then((rows) => {
        if (!cancelled) setCosignerSubmissions(rows);
      });
    return () => {
      cancelled = true;
    };
  }, [previewKey, demo, row.application?.hasCosigner, row.id, variant]);

  useEffect(() => {
    if (variant !== "pdf" || !demo || !row.application) {
      setDemoPdfUrl(null);
      setDemoPdfLoading(false);
      return;
    }
    let cancelled = false;
    setDemoPdfLoading(true);
    setDemoPdfUrl(null);
    void (async () => {
      const { buildDemoApplicationPdfDataUrl } = await import("@/lib/demo/demo-document-files");
      const url = await buildDemoApplicationPdfDataUrl(
        row,
        applicationRoomLabel(row) || undefined,
        cosignerSubmissions,
        groupMembers,
      );
      if (!cancelled) {
        setDemoPdfUrl(url);
        setDemoPdfLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cosignerSubmissions, demo, groupMembers, previewKey, row, variant]);

  const previewHtml = useMemo(
    () =>
      variant === "html"
        ? buildApplicationHtml(row, {
            roomLabel: applicationRoomLabel(row) || undefined,
            cosignerSubmissions,
            groupMembers,
          })
        : null,
    [row, cosignerSubmissions, groupMembers, previewKey, variant],
  );

  const downloadButton = showDownload ? (
    <ApplicationPdfDownloadButton row={row} label={downloadLabel} />
  ) : null;

  const downloadActions =
    downloadButton == null ? null : downloadPlacement === "bottom" ? (
      <PortalTableDetailActions placement="bottom">{downloadButton}</PortalTableDetailActions>
    ) : (
      <div className="flex flex-nowrap items-center justify-start gap-2">{downloadButton}</div>
    );

  const iframeHtml = useMemo(() => {
    if (!previewHtml) return null;
    if (!bareCanvas) return previewHtml;
    return previewHtml.replace(
      "html, body { background: #fff; }",
      "html, body { background: transparent; }",
    );
  }, [bareCanvas, previewHtml]);

  const pdfSrc = variant === "pdf" && !demo ? applicationPdfHref(row, { inline: true }) : demoPdfUrl;

  const previewFrameShell = stretch
    ? "relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card"
    : flow
      ? "w-full overflow-hidden rounded-2xl border border-border bg-card"
      : bareCanvas
        ? "w-full overflow-hidden rounded-2xl border border-border bg-card"
        : "overflow-hidden rounded-2xl border border-border bg-card";

  const previewBody =
    variant === "pdf" ? (
      <div className={previewFrameShell} data-testid="application-pdf-preview">
        {!row.application ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Application details are not available for this record.</p>
        ) : demo && demoPdfLoading ? (
          <p className="px-4 py-8 text-center text-sm text-muted">Loading application PDF…</p>
        ) : pdfSrc ? (
          pdfSrc.startsWith("data:") || flow ? (
            <UploadedLeasePdfPreview
              dataUrl={pdfSrc}
              title={`Application ${row.id}`}
              fileName={applicationPdfFilename(row)}
              embeddedInFlex={stretch && !flow}
              documentFlow={flow}
              className={stretch && !flow ? "flex min-h-0 flex-1 flex-col" : undefined}
            />
          ) : (
            <iframe
              key={previewKey}
              title={`Application ${row.id}`}
              src={pdfSrc}
              className={
                stretch
                  ? "absolute inset-0 h-full w-full border-0 bg-card"
                  : "h-[min(80vh,1200px)] w-full border-0 bg-card"
              }
              data-testid="manager-application-pdf"
            />
          )
        ) : (
          <p className="px-4 py-8 text-center text-sm text-muted">Could not load the application PDF.</p>
        )}
      </div>
    ) : (
      <div className={stretch || flow ? previewFrameShell : bareCanvas ? "w-full" : "overflow-hidden border-t border-border bg-white"}>
        <iframe
          key={previewKey}
          srcDoc={iframeHtml ?? undefined}
          title="Application document"
          sandbox=""
          loading="lazy"
          scrolling={stretch || flow ? "yes" : undefined}
          className={
            stretch
              ? "absolute inset-0 h-full w-full border-0 bg-transparent"
              : flow
                ? "h-[min(78vh,900px)] w-full border-0 bg-transparent"
                : bareCanvas
                  ? "h-[min(70vh,720px)] w-full border-0 bg-transparent"
                  : "h-[min(52vh,420px)] w-full border-0 bg-white"
          }
        />
      </div>
    );

  if (!collapsible) {
    return (
      <div
        className={`${stretch && !flow ? "flex min-h-0 flex-1 flex-col gap-3" : bareCanvas || flow ? "space-y-3" : "mt-4 space-y-3"} ${className ?? ""}`.trim()}
      >
        {downloadPlacement === "top" ? downloadActions : null}
        {previewBody}
        {downloadPlacement === "bottom" ? downloadActions : null}
      </div>
    );
  }

  return (
    <PortalCollapsibleSection
      title="Application"
      defaultExpanded={false}
      surfaceMuted={false}
      bareSurface
      hideToggleIcon
      className="mt-0"
      contentClassName="pt-0"
      toggleDataAttr="application-document-toggle"
      headerActions={downloadButton ?? undefined}
      headerActionsInline={Boolean(downloadButton)}
    >
      {previewBody}
    </PortalCollapsibleSection>
  );
}

const processedScreeningReturnSessions = new Set<string>();

export function ManagerApplications({
  bucket: bucketProp = "pending",
  basePath = "/portal",
  applicationId: applicationIdProp,
  applicationDetailTab: applicationDetailTabProp = "application",
}: {
  bucket?: ManagerApplicationTabId;
  basePath?: string;
  applicationId?: string;
  applicationDetailTab?: ApplicationDetailTabId;
}) {
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const applicationAutomation = useApplicationAutomation(userId);
  // Guards a single auto-approve pass per mount, so a re-render cannot fire a second one.
  const autoApproveRanRef = useRef(false);
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const navigate = usePortalNavigate();
  const openHandled = useRef(false);
  const [bucket, setBucket] = useState<ManagerApplicationTabId>(bucketProp);
  const [prevBucketProp, setPrevBucketProp] = useState(bucketProp);
  if (bucketProp !== prevBucketProp) {
    setPrevBucketProp(bucketProp);
    if (bucket !== bucketProp) setBucket(bucketProp);
  }
  // propertyFilters derived from URL (see appliedPropertyFilters below)
  const [rows, setRows] = useState<DemoApplicantRow[]>(() =>
    typeof window === "undefined" ? [] : readManagerApplicationRows(),
  );
  const [portfolioTick, setPortfolioTick] = useState(() =>
    typeof window === "undefined" ? 0 : hasCachedPropertyPipeline() ? 1 : 0,
  );
  const [approvePreviewRow, setApprovePreviewRow] = useState<DemoApplicantRow | null>(null);
  const [rejectPreviewRows, setRejectPreviewRows] = useState<DemoApplicantRow[] | null>(null);
  const [rejectBusy, setRejectBusy] = useState(false);
  const [approveBusyId, setApproveBusyId] = useState<string | null>(null);
  const [reminderBusyId, setReminderBusyId] = useState<string | null>(null);
  const [reminderPreviewBusyId, setReminderPreviewBusyId] = useState<string | null>(null);
  const [reminderPreview, setReminderPreview] = useState<
    { row: DemoApplicantRow; to: string; subject: string; text: string } | null
  >(null);
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [addApplicationOpen, setAddApplicationOpen] = useState(false);
  const [applicationsFilterOpen, setApplicationsFilterOpen] = useState(false);
  const openAddApplication = useCallback(() => {
    armFilterSheetOpenSuppressFromOverlayDismiss();
    setApplicationsFilterOpen(false);
    setAddApplicationOpen(true);
  }, []);
  const openSendApplicationInvite = useCallback(() => {
    armFilterSheetOpenSuppressFromOverlayDismiss();
    setApplicationsFilterOpen(false);
    setInviteModalOpen(true);
  }, []);
  useEffect(() => {
    if (!addApplicationOpen) return;
    setApplicationsFilterOpen(false);
  }, [addApplicationOpen]);
  const [editApplicationOpen, setEditApplicationOpen] = useState(false);
  const [screeningModalOpen, setScreeningModalOpen] = useState(false);
  const [applicationSettingsOpen, setApplicationSettingsOpen] = useState(false);
  const [checkrScreeningRowId, setCheckrScreeningRowId] = useState<string | null>(null);
  const [checkrScreeningCosignerId, setCheckrScreeningCosignerId] = useState<string | null>(null);
  const [cosignerSubmissionsTick, setCosignerSubmissionsTick] = useState(0);
  // Holding fee lives in the detail's top-right action row, not inline in the
  // body: it is an occasional manager action, and inline it pushed the
  // applicant's own answers below the fold.
  const [holdingFeeRowId, setHoldingFeeRowId] = useState<string | null>(null);
  const [checkrScreeningShowPicker, setCheckrScreeningShowPicker] = useState(false);
  const [screeningSubjectId, setScreeningSubjectId] = useState<string | null>(null);
  useEffect(() => {
    if (!authReady) return;
    const sync = () => setRows(readManagerApplicationRows());
    const pull = () => void syncManagerApplicationsFromServer({ force: true, managerUserId: userId }).then(sync);
    sync();
    void syncManagerApplicationsFromServer({ managerUserId: userId }).then(sync);
    window.addEventListener(MANAGER_APPLICATIONS_EVENT, sync);
    const onVisible = () => {
      if (document.visibilityState === "visible") pull();
    };
    window.addEventListener("focus", pull);
    document.addEventListener("visibilitychange", onVisible);
    const poll = window.setInterval(pull, 20_000);
    return () => {
      window.removeEventListener(MANAGER_APPLICATIONS_EVENT, sync);
      window.removeEventListener("focus", pull);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(poll);
    };
  }, [authReady, userId]);

  // Returning from embedded Stripe screening checkout (?screening=return|paid|cancelled).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const screening = params.get("screening");
    if (!screening) return;

    const cleanScreeningParams = () => {
      params.delete("screening");
      params.delete("session_id");
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    };

    if (screening === "return" || screening === "paid") {
      const sessionId = params.get("session_id")?.trim();
      if (screening === "return" && sessionId && !processedScreeningReturnSessions.has(sessionId)) {
        processedScreeningReturnSessions.add(sessionId);
        void (async () => {
          const res = await fetch("/api/screening/checkout-verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ sessionId }),
          });
          const data = (await res.json().catch(() => ({}))) as {
            paid?: boolean;
            backgroundCheck?: ApplicationBackgroundCheck;
            error?: string;
          };
          cleanScreeningParams();

          if (!res.ok || !data.paid || !data.backgroundCheck) {
            if (data.error) showToast(data.error);
            return;
          }

          showToast(
            data.backgroundCheck.status === "complete"
              ? "Screening complete."
              : "Payment received. Background check is running.",
          );
          void syncManagerApplicationsFromServer({ managerUserId: userId }).then(setRows);
        })();
      } else {
        cleanScreeningParams();
      }
    } else if (screening === "cancelled") {
      showToast("Payment cancelled. No screening was ordered.");
      cleanScreeningParams();
    }
  }, [showToast, userId]);

  useEffect(() => {
    if (!authReady || !userId) return;
    let cancelled = false;
    void syncPropertyPipelineFromServer()
      .catch(() => undefined)
      .finally(() => {
        if (cancelled) return;
        setPortfolioTick((n) => (n > 0 ? n : 1));
      });
    return () => {
      cancelled = true;
    };
  }, [authReady, userId]);

  useEffect(() => {
    const bump = () => setPortfolioTick((n) => n + 1);
    for (const ev of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
      window.addEventListener(ev, bump);
    }
    return () => {
      for (const ev of MANAGER_PORTFOLIO_REFRESH_EVENTS) {
        window.removeEventListener(ev, bump);
      }
    };
  }, []);

  const handleScreeningUpdated = useCallback(() => {
    void syncManagerApplicationsFromServer({ managerUserId: userId }).then(setRows);
  }, [userId]);

  const handleScreeningFlowComplete = useCallback(() => {
    handleScreeningUpdated();
    if (checkrScreeningCosignerId) {
      setCosignerSubmissionsTick((tick) => tick + 1);
    }
  }, [handleScreeningUpdated, checkrScreeningCosignerId]);

  const scopeUserId = resolveManagerScopeUserId(userId);

  const propertyOptions = buildManagerPropertyFilterOptions(scopeUserId);

  const propertyFilters = useMemo(
    () =>
      sanitizePortalPropertyFilterIds(
        parsePortalPropertyFilterQuery(searchParams),
        propertyOptions.map((o) => o.id),
      ),
    [searchParams, propertyOptions],
  );

  const setPropertyFilters = useCallback(
    (next: string[] | ((prev: string[]) => string[])) => {
      const resolved = typeof next === "function" ? next(propertyFilters) : next;
      const sanitized = sanitizePortalPropertyFilterIds(
        resolved,
        propertyOptions.map((o) => o.id),
      );
      if (portalPropertyFilterIdsEqual(sanitized, propertyFilters)) return;
      router.replace(appendPortalPropertyFilterQuery(applicationListHref(basePath, bucket), sanitized), {
        scroll: false,
      });
    },
    [propertyFilters, propertyOptions, basePath, bucket, router],
  );

  const applicationsListHref = useCallback(
    (tab: ManagerApplicationTabId) =>
      appendPortalPropertyFilterQuery(applicationListHref(basePath, tab), propertyFilters),
    [basePath, propertyFilters],
  );

  const shareableProperties = useMemo(() => {
    void portfolioTick;
    return buildManagerShareablePropertyOptions(scopeUserId);
  }, [scopeUserId, portfolioTick]);

  const scopedRows = useMemo(() => {
    // `portfolioTick` is a cache-invalidation signal, not a value read here:
    // `applicationVisibleToPortalUser` consults the module-level property
    // pipeline cache, which React cannot see. Re-filter once that cache
    // hydrates so linked-property rows appear without a manual refresh.
    void portfolioTick;
    if (!scopeUserId) return [];
    return rows.filter((r) => applicationVisibleToPortalUser(r, scopeUserId, "applications"));
  }, [rows, scopeUserId, portfolioTick]);

  // Reconcile group applications across every bucket (a group can span pending / approved /
  // in-progress) so the whole household is visible from any one member's row.
  const applicationGroups = useMemo(
    () => buildBundleApplicationGroups(scopedRows.map(groupRowInputForRow)),
    [scopedRows],
  );

  const propertyFilteredRows = useMemo(
    () => applicationRowsForPropertyFilters(scopedRows, propertyFilters),
    [scopedRows, propertyFilters],
  );

  const counts = useMemo(() => countByBucket(propertyFilteredRows), [propertyFilteredRows]);
  const incompleteCount = useMemo(
    () => propertyFilteredRows.filter((r) => r.bucket === "pending" && isInProgressApplicationRow(r)).length,
    [propertyFilteredRows],
  );
  // "Pending" now means submitted and awaiting review — Incomplete (still a
  // draft) is its own tab, so it is subtracted out here rather than shown as
  // an annotation on top of the combined bucket count.
  const pendingReviewCount = counts.pending - incompleteCount;
  const tabs = useMemo(
    () =>
      [
        { id: "incomplete" as const, label: "Incomplete", count: incompleteCount },
        { id: "pending" as const, label: "Pending", count: pendingReviewCount },
        { id: "approved" as const, label: "Approved", count: counts.approved },
        { id: "rejected" as const, label: "Rejected", count: counts.rejected },
      ] as const,
    [counts, incompleteCount, pendingReviewCount],
  );

  const propertyFilterLabel = useMemo(() => {
    if (propertyFilters.length === 0) return "";
    if (propertyFilters.length === 1) {
      return propertyOptions.find((o) => o.id === propertyFilters[0])?.label ?? propertyFilters[0];
    }
    return `${propertyFilters.length} properties`;
  }, [propertyFilters, propertyOptions]);

  const rowsForBucket = useMemo(() => {
    return propertyFilteredRows.filter((r) => tabForRow(r) === bucket);
  }, [propertyFilteredRows, bucket]);

  const listClusters = useMemo(() => {
    const sortBucket = applicationListSortBucket(bucket);
    const sorted = sortApplicationRowsForBucket(rowsForBucket, bucket);
    return sortApplicationListClustersForBucket(
      buildApplicationListClusters(sorted, applicationGroups, sortBucket),
      bucket,
    );
  }, [rowsForBucket, bucket, applicationGroups]);

  const { selectedIds, toggleSelected, clearSelection } = usePortalRowSelection(bucket);
  const listSelectedCount = selectedIds.size;
  const singleListSelectedId = listSelectedCount === 1 ? [...selectedIds][0]! : null;
  const selectedListRows = useMemo(
    () => rowsForBucket.filter((row) => selectedIds.has(row.id)),
    [rowsForBucket, selectedIds],
  );
  const singleListSelectedRow = useMemo(
    () =>
      singleListSelectedId
        ? selectedListRows.find((row) => row.id === singleListSelectedId) ?? null
        : null,
    [selectedListRows, singleListSelectedId],
  );
  const selectedApprovableRows = useMemo(
    () => selectedListRows.filter(isApprovableApplicationRow),
    [selectedListRows],
  );
  const selectedRejectableRows = useMemo(
    () => selectedListRows.filter((row) => row.bucket === "pending" || row.bucket === "approved"),
    [selectedListRows],
  );
  const canBulkApprove = selectedApprovableRows.length === 1;
  const canBulkReject = selectedRejectableRows.length > 0;
  const canBulkHoldingFee =
    singleListSelectedRow != null &&
    singleListSelectedRow.bucket !== "rejected" &&
    !isWithdrawnApplicationRow(singleListSelectedRow);
  const canBulkDelete = listSelectedCount > 0;

  const openDetailScreeningModal = useCallback((row: DemoApplicantRow, opts?: { showPackagePicker?: boolean; cosignerSubmissionId?: string }) => {
    setCheckrScreeningShowPicker(Boolean(opts?.showPackagePicker));
    setCheckrScreeningRowId(row.id);
    setCheckrScreeningCosignerId(opts?.cosignerSubmissionId?.trim() || null);
  }, []);

  const onIncompleteApplicationsRoute = /\/applications\/incomplete(?:\/|$)/.test(pathname);
  const viewingIncompleteApplicationDetail =
    Boolean(applicationIdProp) && (onIncompleteApplicationsRoute || bucketProp === "incomplete");

  const showCompletionReminderForRow = useCallback(
    (row: DemoApplicantRow) => {
      if (
        (viewingIncompleteApplicationDetail || bucket === "incomplete") &&
        row.bucket === "pending"
      ) {
        return true;
      }
      if (row.bucket !== "pending" || isWithdrawnApplicationRow(row)) return false;
      const canApprove = !isInProgressApplicationRow(row);
      if (!canApprove) return true;
      return (
        isInProgressApplicationRow(row) ||
        applicationStageDisplayLabel(row) === INCOMPLETE_APPLICATION_LABEL ||
        shouldOfferApplicationCompletionReminder(row)
      );
    },
    [viewingIncompleteApplicationDetail, bucket],
  );

  const canBulkSendReminder =
    singleListSelectedRow != null && showCompletionReminderForRow(singleListSelectedRow);
  const canBulkShare = singleListSelectedRow != null;
  const canBulkDownload = singleListSelectedRow != null;
  const canBulkMoveToPending =
    singleListSelectedRow != null && applicationRowCanMoveToPending(singleListSelectedRow);
  const bulkShareRecordTitle =
    singleListSelectedRow?.name?.trim() ||
    singleListSelectedRow?.application?.fullLegalName?.trim() ||
    singleListSelectedRow?.property?.trim();

  // The detail view renders full applicant PII — name, contact, income, screening
  // results — so it resolves out of `scopedRows`, the SAME already-scoped list the
  // table renders, rather than the raw cache. That makes it structurally impossible
  // for the list and the detail to disagree about who may see a row: an unresolved
  // scope leaves `scopedRows` empty, so the detail denies it too, and the caller
  // renders a skeleton for a null row until the scope (and the property cache)
  // resolves.
  const detailRow = useMemo(() => {
    if (!applicationIdProp) return null;
    const target = normalizeApplicationAxisId(decodeURIComponent(applicationIdProp)).toUpperCase();
    return scopedRows.find((r) => normalizeApplicationAxisId(r.id).toUpperCase() === target) ?? null;
  }, [applicationIdProp, scopedRows]);

  const cosignerSignerIds = useMemo(() => {
    const ids = signerAppIdsForCosignerLookup(rowsForBucket);
    if (detailRow?.application?.hasCosigner === "yes" && !ids.includes(detailRow.id)) {
      return [...ids, detailRow.id];
    }
    return ids;
  }, [rowsForBucket, detailRow]);
  const cosignerSubmissionsBySigner = useCosignerSubmissionsMap(cosignerSignerIds, cosignerSubmissionsTick);

  const cosignerIndexParam = searchParams.get("cosigner");
  const activeCosignerIndex =
    cosignerIndexParam != null && /^\d+$/.test(cosignerIndexParam) ? parseInt(cosignerIndexParam, 10) : null;
  const detailCosignerSubmissions = useMemo(() => {
    if (!detailRow) return [];
    const key = normalizeApplicationAxisId(detailRow.id).toUpperCase();
    return cosignerSubmissionsBySigner.get(key) ?? [];
  }, [detailRow, cosignerSubmissionsBySigner]);
  const activeCosignerSubmission =
    activeCosignerIndex != null && activeCosignerIndex >= 0 && activeCosignerIndex < detailCosignerSubmissions.length
      ? detailCosignerSubmissions[activeCosignerIndex]!
      : null;

  useEffect(() => {
    if (!applicationIdProp || !detailRow) return;
    if (applicationDetailTabProp === "background-check") {
      navigate(applicationDetailHref(basePath, tabForRow(detailRow), detailRow.id, "application"));
    }
  }, [applicationIdProp, applicationDetailTabProp, detailRow, navigate, basePath]);

  useEffect(() => {
    setScreeningSubjectId(null);
  }, [detailRow?.id]);

  const detailScreeningSubjects = useMemo(() => {
    if (!detailRow) return [];
    return buildScreeningSubjects(detailRow, detailCosignerSubmissions);
  }, [detailRow, detailCosignerSubmissions]);

  const resolvedScreeningSubjectId = detailRow
    ? resolveScreeningSubjectId(detailScreeningSubjects, screeningSubjectId, detailRow.id)
    : "";

  const activeScreeningRow = useMemo(() => {
    if (!detailRow) return null;
    return screeningRowForSubject(detailRow, detailCosignerSubmissions, resolvedScreeningSubjectId);
  }, [detailRow, detailCosignerSubmissions, resolvedScreeningSubjectId]);

  const activeScreeningCosignerId = cosignerSubmissionIdForSubject(
    detailScreeningSubjects,
    resolvedScreeningSubjectId,
  );

  const openScreeningForSubjectIds = useCallback(
    (subjectIds: string[]) => {
      if (!detailRow || subjectIds.length === 0) return;
      const firstId = subjectIds[0]!;
      setScreeningSubjectId(firstId);
      openDetailScreeningModal(detailRow, {
        cosignerSubmissionId: cosignerSubmissionIdForSubject(detailScreeningSubjects, firstId),
      });
    },
    [detailRow, detailScreeningSubjects, openDetailScreeningModal],
  );

  const screeningModalRow = useMemo(() => {
    if (!checkrScreeningRowId) return null;
    const signerRow =
      scopedRows.find((r) => r.id === checkrScreeningRowId) ??
      (detailRow?.id === checkrScreeningRowId ? detailRow : null);
    if (!signerRow) return null;
    if (!checkrScreeningCosignerId) return signerRow;
    const cosigners =
      cosignerSubmissionsBySigner.get(normalizeApplicationAxisId(checkrScreeningRowId).toUpperCase()) ?? [];
    const cosigner = cosigners.find((c) => c.id === checkrScreeningCosignerId);
    return cosigner ? buildCosignerScreeningRow(signerRow, cosigner) : signerRow;
  }, [checkrScreeningRowId, checkrScreeningCosignerId, scopedRows, detailRow, cosignerSubmissionsBySigner]);

  const checkrModalSignerRow = useMemo(() => {
    if (!checkrScreeningRowId) return null;
    return (
      scopedRows.find((r) => r.id === checkrScreeningRowId) ??
      (detailRow?.id === checkrScreeningRowId ? detailRow : null)
    );
  }, [checkrScreeningRowId, scopedRows, detailRow]);

  const checkrModalSubjects = useMemo(() => {
    if (!checkrModalSignerRow) return [];
    return buildScreeningSubjects(
      checkrModalSignerRow,
      cosignerSubmissionsBySigner.get(normalizeApplicationAxisId(checkrModalSignerRow.id).toUpperCase()) ?? [],
    );
  }, [checkrModalSignerRow, cosignerSubmissionsBySigner]);

  const checkrModalSubjectId = useMemo(() => {
    if (!checkrModalSignerRow) return undefined;
    return resolveScreeningSubjectId(
      checkrModalSubjects,
      checkrScreeningCosignerId ?? screeningSubjectId,
      checkrModalSignerRow.id,
    );
  }, [checkrModalSignerRow, checkrModalSubjects, checkrScreeningCosignerId, screeningSubjectId]);

  const checkrScreeningModal = (
    <CheckrScreeningModal
      key={`${checkrScreeningRowId ?? "none"}:${checkrScreeningCosignerId ?? ""}`}
      row={screeningModalRow}
      screeningSubjects={checkrModalSubjects}
      screeningSubjectId={checkrModalSubjectId}
      onScreeningSubjectChange={(subjectId) => {
        setScreeningSubjectId(subjectId);
        setCheckrScreeningCosignerId(cosignerSubmissionIdForSubject(checkrModalSubjects, subjectId) ?? null);
      }}
      cosignerSubmissionId={checkrScreeningCosignerId}
      open={checkrScreeningRowId !== null}
      showPackagePickerInitially={checkrScreeningShowPicker}
      onClose={() => {
        setCheckrScreeningRowId(null);
        setCheckrScreeningCosignerId(null);
        setCheckrScreeningShowPicker(false);
      }}
      onUpdated={handleScreeningFlowComplete}
    />
  );

  useEffect(() => {
    if (openHandled.current || scopedRows.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const raw = (params.get("open") ?? params.get("axisId") ?? "").trim();
    if (!raw) return;
    const id = normalizeApplicationAxisId(raw).toUpperCase();
    const hit = scopedRows.find((r) => normalizeApplicationAxisId(r.id).toUpperCase() === id);
    if (!hit) return;
    openHandled.current = true;
    queueMicrotask(() => {
      const tab = tabForRow(hit);
      setBucket(tab);
      router.replace(applicationsListHref(tab), { scroll: false });
      navigate(applicationDetailHref(basePath, tab, hit.id));
    });
    requestAnimationFrame(() => {
      document.getElementById(`portal-application-${hit.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    params.delete("open");
    params.delete("axisId");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [scopedRows, pathname, router, basePath, navigate]);

  /**
   * Auto-approve, when the manager has switched it on.
   *
   * The trigger is THIS list loading — the moment a manager would otherwise have clicked Approve,
   * with the same data already loaded and the result visible on the screen they are looking at.
   * It cannot be a background job: approval-time charge generation is browser-only, so a server
   * sweep would approve applications and silently bill nobody.
   *
   * `selectAutoApprovals` caps the pass, so switching this on with a backlog does not provision a
   * pile of accounts at once; the rest come on the next load.
   */

  const setRowBucket = async (
    id: string,
    nextBucket: ManagerApplicationBucket,
    opts?: { skipWelcomeEmail?: boolean; skipNavigate?: boolean; quiet?: boolean },
  ) => {
    const row = rows.find((candidate) => candidate.id === id);
    const result = await transitionApplicationBucket(id, nextBucket, {
      userId: userId ?? null,
      skipWelcomeEmail: opts?.skipWelcomeEmail,
      automation: applicationAutomation.forProperty(row ? applicationRowPropertyId(row) : ""),
    });
    if (!result) return;
    setRows(readManagerApplicationRows());
    if (result.blocked) {
      if (!opts?.quiet) {
        showToast(result.message ?? "That change could not be saved.");
      }
      return;
    }

    if (!opts?.skipNavigate) {
      router.push(applicationsListHref(nextBucket));
    }
    if (opts?.quiet) return;
    const msg =
      nextBucket === "approved"
        ? opts?.skipWelcomeEmail
          ? "Application approved (no setup email sent)."
          : result.welcomeSent
            ? "Application approved. A welcome email with portal setup was sent to the applicant."
            : "Application approved."
        : nextBucket === "rejected"
          ? "Application rejected."
          : "Moved to Pending.";
    showToast(msg);
  };

  // Declared AFTER `setRowBucket`, which it calls. It used to sit above the
  // definition and relied on hoisting, which stops the compiler tracking the
  // dependency. The dep list is unchanged and still deliberately omits it.
  useEffect(() => {
    if (autoApproveRanRef.current) return;
    if (!userId || rows.length === 0) return;
    const autoApproveRows = rows.filter(
      (row) => applicationAutomation.forProperty(applicationRowPropertyId(row)).autoApproveApplications,
    );
    if (autoApproveRows.length === 0) return;
    autoApproveRanRef.current = true;
    const picked = selectAutoApprovals(
      autoApproveRows.map((row) => ({
        id: row.id,
        bucket: row.bucket,
        withdrawnAt: row.withdrawnAt,
        complete: !isInProgressApplicationRow(row),
        screeningStatus: row.backgroundCheck?.status,
      })),
      { enabled: true, isDemo: isDemoModeActive() },
    );
    if (picked.length === 0) return;
    void (async () => {
      for (const candidate of picked) {
        // Sequential on purpose: each approval writes charges and provisions an account, and the
        // shared transition is not built to run concurrently against the same local store.
        await setRowBucket(candidate.id, "approved");
      }
      showToast(
        picked.length === 1
          ? "1 application auto-approved."
          : `${picked.length} applications auto-approved.`,
      );
    })();
    // Deliberately keyed on the automation flag and the row set only — `setRowBucket` is redefined
    // every render and would retrigger the pass.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicationAutomation, rows, userId]);

  const rejectApplications = async (rowsToReject: DemoApplicantRow[]) => {
    if (rowsToReject.length === 0) return;
    setRejectBusy(true);
    try {
      for (const row of rowsToReject) {
        await setRowBucket(row.id, "rejected", { skipNavigate: true, quiet: true });
      }
      clearSelection();
      setRejectPreviewRows(null);
      if (applicationIdProp && rowsToReject.some((row) => row.id === detailRow?.id)) {
        navigate(applicationsListHref("rejected"));
      }
      showToast(
        rowsToReject.length === 1
          ? "Application rejected."
          : `${rowsToReject.length} applications rejected.`,
      );
    } finally {
      setRejectBusy(false);
    }
  };

  const purgeApplicationLocalData = (applicationId: string) => {
    removeAllApplicationCharges(applicationId, userId ?? null);
    deleteLeasePipelineRowsForResident("", applicationId, userId ?? null);
  };

  const deleteApplication = async (id: string) => {
    const row = rows.find((candidate) => candidate.id === id);
    const nextRows = rows.filter((r) => r.id !== id);

    // Drop from the session cache as well as React state — `syncManagerApplicationsFromServer`
    // union-merges against `memoryRows`, so a server-deleted row that still lives in the
    // cache is resurrected on the next poll/focus sync (the captain's "glitch" report).
    writeManagerApplicationRows(nextRows);
    setRows(nextRows);

    const result = await deleteManagerApplicationFromServer(id);
    if (!result.ok) {
      setRows(await syncManagerApplicationsFromServer({ managerUserId: userId }));
      showToast(result.error ?? "Could not delete application.");
      return;
    }

    purgeApplicationLocalData(id);

    const [syncedRows] = await Promise.all([
      syncManagerApplicationsFromServer({ force: true, managerUserId: userId }),
      syncHouseholdChargesFromServer(),
    ]);
    setRows(syncedRows);

    if (applicationIdProp) {
      navigate(applicationsListHref(bucket));
    }

    showToast("Application deleted.");
  };

  const deleteListSelectedApplications = async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const label =
      ids.length === 1
        ? applicantDisplayName(rows.find((row) => row.id === ids[0])!) || "this application"
        : `${ids.length} applications`;
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;

    let deleted = 0;
    for (const id of ids) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) continue;
      const nextRows = rows.filter((r) => r.id !== id);
      writeManagerApplicationRows(nextRows);
      setRows(nextRows);
      const result = await deleteManagerApplicationFromServer(id);
      if (!result.ok) {
        setRows(await syncManagerApplicationsFromServer({ managerUserId: userId }));
        showToast(result.error ?? "Could not delete application.");
        return;
      }
      purgeApplicationLocalData(id);
      deleted += 1;
    }

    const [syncedRows] = await Promise.all([
      syncManagerApplicationsFromServer({ force: true, managerUserId: userId }),
      syncHouseholdChargesFromServer(),
    ]);
    setRows(syncedRows);
    clearSelection();
    if (applicationIdProp && ids.includes(applicationIdProp)) {
      navigate(applicationsListHref(bucket));
    }
    showToast(deleted === 1 ? "Application deleted." : `${deleted} applications deleted.`);
  };

  const sendApplicationReminder = async (
    row: DemoApplicantRow,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
    draft?: { subject?: string; body?: string },
  ) => {
    if (reminderBusyId) return;
    setReminderBusyId(row.id);
    try {
      // Demo mode must never trigger a real email/write — simulate success locally.
      if (isDemoModeActive()) {
        showToast("Reminder sent to the applicant.");
        return;
      }
      const res = await fetch("/api/portal/send-application-completion-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          applicationId: row.id,
          viaEmail: channels?.viaEmail !== false,
          viaSms: channels?.viaSms === true,
          subject: draft?.subject?.trim() || undefined,
          text: draft?.body?.trim() || undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; mailtoHref?: string };
      if (res.ok && data.ok) {
        showToast("Application reminder sent to the applicant.");
        return;
      }
      // A draft is offered both when email isn't set up (503) and when a real send
      // fails (502) — keep the copy accurate to which happened, and surface the real
      // error on a genuine failure rather than blaming configuration.
      if (typeof data.mailtoHref === "string" && data.mailtoHref) {
        const { openMailtoHref } = await import("@/lib/resident-welcome-email");
        openMailtoHref(data.mailtoHref);
        showToast(
          res.status === 503
            ? "Email isn't configured. Opened a draft in your mail app instead."
            : `Couldn't send automatically${data.error ? ` (${data.error})` : ""}. Opened a draft in your mail app.`,
        );
        return;
      }
      showToast(data.error ?? "Could not send the application reminder.");
    } catch {
      showToast("Could not send the application reminder.");
    } finally {
      setReminderBusyId(null);
      // The confirm action is terminal (sent, drafted, or errored) — close the preview.
      setReminderPreview(null);
    }
  };

  // Load the exact email that would be sent (same auth/recipient/copy) so the manager
  // can confirm before anything goes out. Demo mode builds the preview locally since the
  // route can't resolve synthetic demo ids and must never send.
  const openReminderPreview = async (row: DemoApplicantRow) => {
    if (reminderPreviewBusyId || reminderBusyId) return;
    setReminderPreviewBusyId(row.id);
    try {
      if (isDemoModeActive()) {
        const origin = typeof window === "undefined" ? "" : window.location.origin;
        const text = buildApplicationCompletionReminderBody({
          applicantName: row.name || undefined,
          propertyTitle: row.property || undefined,
          resumeUrl: inProgressApplicationResumeUrl(origin, row),
          signInUrl: `${origin}/auth/sign-in?role=resident`,
        });
        setReminderPreview({
          row,
          to: row.email?.trim() || "the applicant",
          subject: APPLICATION_COMPLETION_REMINDER_SUBJECT,
          text,
        });
        return;
      }
      const res = await fetch("/api/portal/send-application-completion-reminder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ applicationId: row.id, preview: true }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        preview?: { to?: string; subject?: string; text?: string };
      };
      if (res.ok && data.ok && data.preview) {
        setReminderPreview({
          row,
          to: data.preview.to ?? "",
          subject: data.preview.subject ?? APPLICATION_COMPLETION_REMINDER_SUBJECT,
          text: data.preview.text ?? "",
        });
        return;
      }
      showToast(data.error ?? "Could not load the reminder preview.");
    } catch {
      showToast("Could not load the reminder preview.");
    } finally {
      setReminderPreviewBusyId(null);
    }
  };

  const renderApplicationRowActions = (row: DemoApplicantRow) => {
    const isPending = row.bucket === "pending";
    const actionBtnClass = RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN;
    const showCompletionReminder = showCompletionReminderForRow(row);
    const recordTitle = row.name?.trim() || row.application?.fullLegalName?.trim() || row.property?.trim();
    const actions: PortalFooterFitAction[] = [];

    if (showCompletionReminder) {
      actions.push({
        id: "reminder",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="application-send-reminder"
            disabled={reminderPreviewBusyId !== null || reminderBusyId !== null}
            onClick={() => openReminderPreview(row)}
          >
            {reminderPreviewBusyId === row.id ? "Loading…" : "Send reminder"}
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="application-send-reminder"
            disabled={reminderPreviewBusyId !== null || reminderBusyId !== null}
            onSelect={() => openReminderPreview(row)}
          >
            Send reminder
          </DropdownMenuItem>
        ),
      });
    }

    actions.push({
      id: "share",
      button: (
        <PortalRecordShareLinkButton
          kind="application"
          recordId={row.id}
          className={actionBtnClass}
          dataAttr="application-share"
          recordTitle={recordTitle}
        />
      ),
      menuItem: (
        <PortalRecordShareLinkButton
          kind="application"
          recordId={row.id}
          menuItem
          dataAttr="application-share"
          recordTitle={recordTitle}
        />
      ),
    });

    if (isApprovableApplicationRow(row)) {
      actions.push({
        id: "approve",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="application-approve"
            onClick={() => setApprovePreviewRow(row)}
          >
            Approve
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="application-approve" onSelect={() => setApprovePreviewRow(row)}>
            Approve
          </DropdownMenuItem>
        ),
      });
    }

    if (row.bucket === "pending") {
      actions.push({
        id: "reject",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="application-reject"
            onClick={() => setRejectPreviewRows([row])}
          >
            Reject
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="application-reject" onSelect={() => setRejectPreviewRows([row])}>
            Reject
          </DropdownMenuItem>
        ),
      });
    }

    if (row.bucket !== "rejected" && !isWithdrawnApplicationRow(row)) {
      actions.push({
        id: "holding-fee",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="application-holding-fee-open"
            onClick={() => setHoldingFeeRowId(row.id)}
          >
            Holding fee
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="application-holding-fee-open"
            onSelect={() => setHoldingFeeRowId(row.id)}
          >
            Holding fee
          </DropdownMenuItem>
        ),
      });
    }

    actions.push({
      id: "download",
      button: (
        <ApplicationPdfDownloadButton row={row} label="Download" className={actionBtnClass} />
      ),
      menuItem: (
        <DropdownMenuItem
          data-attr="application-pdf-download"
          onSelect={() => runApplicationPdfDownload(row, showToast)}
        >
          Download application
        </DropdownMenuItem>
      ),
    });

    if (applicationRowCanMoveToPending(row)) {
      actions.push({
        id: "move-pending",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="application-move-pending"
            onClick={() => setRowBucket(row.id, "pending")}
          >
            Move to pending
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="application-move-pending"
            onSelect={() => setRowBucket(row.id, "pending")}
          >
            Move to pending
          </DropdownMenuItem>
        ),
      });
    }

    actions.push({
      id: "delete",
      button: (
        <Button
          type="button"
          variant="outline"
          className={`${actionBtnClass} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
          data-attr="application-delete"
          onClick={() => deleteApplication(row.id)}
        >
          Delete
        </Button>
      ),
      menuItem: (
        <DropdownMenuItem
          className="text-rose-800 focus:text-rose-800"
          data-attr="application-delete"
          onSelect={() => deleteApplication(row.id)}
        >
          Delete
        </DropdownMenuItem>
      ),
    });

    return (
      <div
        className="relative w-full min-w-0 flex-1"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <PortalFooterFitActionRow actions={actions} moreLabel="More application actions" />
      </div>
    );
  };

  const renderCosignerDetailActions = (signerRow: DemoApplicantRow, cosigner: CosignerSubmission) => {
    if (!cosignerShowsBackgroundCheck(cosigner)) return undefined;
    const screeningRow = buildCosignerScreeningRow(signerRow, cosigner);
    const showsRunCheck =
      Boolean(screeningRow.application?.consentCredit) &&
      screeningRow.backgroundCheck?.status !== "pending" &&
      screeningRow.backgroundCheck?.status !== "complete";
    const canDownloadScreening =
      screeningRow.backgroundCheck?.status === "complete" ||
      (isDemoModeActive() && cosignerShowsBackgroundCheck(cosigner));

    const openCosignerScreening = (opts?: { showPackagePicker?: boolean }) =>
      openDetailScreeningModal(signerRow, {
        showPackagePicker: opts?.showPackagePicker,
        cosignerSubmissionId: cosigner.id,
      });

    const actionBtnClass = RESIDENT_DOCUMENTS_DETAIL_FOOTER_BTN;
    const actions: PortalFooterFitAction[] = [];

    if (showsRunCheck) {
      actions.push({
        id: "run-background-check",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="run-background-check"
            onClick={() => openCosignerScreening()}
          >
            Run background check
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem data-attr="run-background-check" onSelect={() => openCosignerScreening()}>
            Run background check
          </DropdownMenuItem>
        ),
      });
    }

    if (canDownloadScreening) {
      actions.push({
        id: "download-screening",
        button: (
          <Button
            type="button"
            variant="outline"
            className={actionBtnClass}
            data-attr="screening-pdf-download"
            onClick={() => downloadBackgroundCheckForApplication(screeningRow)}
          >
            Download
          </Button>
        ),
        menuItem: (
          <DropdownMenuItem
            data-attr="screening-pdf-download"
            onSelect={() => downloadBackgroundCheckForApplication(screeningRow)}
          >
            Download background check
          </DropdownMenuItem>
        ),
      });
    }

    if (actions.length === 0) return undefined;

    return (
      <div
        className="relative w-full min-w-0"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        role="presentation"
      >
        <PortalFooterFitActionRow actions={actions} moreLabel="More cosigner actions" />
      </div>
    );
  };

  const renderApplicationDetail = (row: DemoApplicantRow) => {
    const signerKey = normalizeApplicationAxisId(row.id).toUpperCase();
    const cosignerSubmissions = cosignerSubmissionsBySigner.get(signerKey) ?? [];
    // A holding deposit collected AT APPLICATION (a since-removed per-listing
    // choice, `holdingDepositTiming`) is never auto-refunded when the
    // application is later rejected or withdrawn: PropLane has no automated
    // refund flow, and whether the deposit is even refundable is a
    // legal/lease-terms question the manager must resolve directly with the
    // applicant. This is a read-only reminder, not a code decision.
    const rejectedOrWithdrawn = row.bucket === "rejected" || isWithdrawnApplicationRow(row);
    const rowPropertyId = row.application?.propertyId?.trim() || row.propertyId?.trim() || "";
    const paidDepositCharge =
      rejectedOrWithdrawn && row.email && rowPropertyId
        ? findHoldingDepositCharge(row.email, rowPropertyId, null, row.id)
        : undefined;
    const showPaidDepositNote = paidDepositCharge?.status === "paid";
    const group = groupForRow(applicationGroups, { groupId: groupIdForRow(row) });
    return (
    <>
      {showPaidDepositNote ? (
        <div className="rounded-xl border px-4 py-3 text-sm portal-banner-pending" data-attr="application-paid-deposit-note">
          <span className="font-semibold">Holding deposit already paid ({paidDepositCharge.amountLabel}).</span>{" "}
          {row.bucket === "rejected" ? "This application was rejected" : "This application was withdrawn"} —
          PropLane does not automatically refund it. Handle any refund directly with the applicant per your lease
          terms.
        </div>
      ) : null}

      {/*
        NOT `stretch` here, unlike the Residents tab's copy of this body. Stretch
        makes the review body its own bounded, scrolling column — correct inside
        a flex parent that gives it a height, which is what Residents does. This
        page already renders it inside PortalPageScrollBody, so stretching put a
        scroller inside a scroller: the page scroller had nothing to scroll, the
        inner one ended underneath the fixed action dock, and the application
        simply would not move. One scroller per surface.
      */}
      <ApplicationDetailReviewBody
        row={row}
        group={group}
        cosignerSubmissions={cosignerSubmissions}
        bareCanvas
        showDownload={false}
        onScreeningUpdated={handleScreeningFlowComplete}
        onOpenScreeningModal={(opts) =>
          openDetailScreeningModal(row, {
            ...opts,
            cosignerSubmissionId: activeScreeningCosignerId,
          })
        }
        screeningSubjectId={resolvedScreeningSubjectId}
        onScreeningSubjectChange={setScreeningSubjectId}
        onRequestChecksForSubjects={openScreeningForSubjectIds}
        householdNav={{
          onOpenCosigner: (index) => {
            const href = `${applicationDetailHref(basePath, tabForRow(row), row.id, "application")}?cosigner=${index}`;
            navigate(href);
          },
          onOpenApplication: (applicationId) => {
            const target =
              scopedRows.find(
                (r) =>
                  normalizeApplicationAxisId(r.id).toUpperCase() ===
                  normalizeApplicationAxisId(applicationId).toUpperCase(),
              ) ?? null;
            navigate(
              applicationDetailHref(
                basePath,
                target ? tabForRow(target) : tabForRow(row),
                applicationId,
                "application",
              ),
            );
          },
        }}
        className="min-h-0 flex-1"
      />

    </>
    );
  };

  const applicationsFilterSort = (
    <PortalFilterSortSheet
      open={applicationsFilterOpen}
      onOpenChange={setApplicationsFilterOpen}
      activeCount={portalFilterActiveCount([propertyFilters])}
      compactPanel
      commandStripTrigger
      filterFieldCount={1}
      constrainDropdownToTitleBand={false}
      mobileFlushBody
      onReset={() => setPropertyFilters([])}
      dataAttr="applications-filter-sheet-open"
    >
      <ApplicationFilterSortFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        selectionMode="multi"
      />
    </PortalFilterSortSheet>
  );

  // Edit and Settings sit together and open with the same property dropdown, so
  // the pair reads as one idea rather than two adjacent unrelated features.
  const applicationsSettingsButton = (
    <>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_COMMAND_ACTION_BTN}
        data-attr="application-edit-open"
        onClick={() => setEditApplicationOpen(true)}
      >
        Edit
      </Button>
      <Button
        type="button"
        variant="outline"
        className={PORTAL_COMMAND_ACTION_BTN}
        data-attr="application-settings-open"
        onClick={() => setApplicationSettingsOpen(true)}
      >
        Settings
      </Button>
    </>
  );

  const applicationsAddButton = (
    <Button
      type="button"
      className={PORTAL_COMMAND_PRIMARY_ACTION_BTN}
      style={PORTAL_COMMAND_PRIMARY_ACTION_STYLE}
      data-attr="applications-send"
      onClick={openSendApplicationInvite}
      disabled={shareableProperties.length === 0}
      title={shareableProperties.length === 0 ? "List a property before sending an application link" : undefined}
    >
      Send application
    </Button>
  );

  const applicationsListActions = (
    <>
      {applicationsFilterSort}
      {applicationsSettingsButton}
      {applicationsAddButton}
    </>
  );

  const applicationModals = (
    <>
      <PortalNotificationPreviewModal
        open={approvePreviewRow !== null}
        title="Approve application: account setup email"
        onClose={() => setApprovePreviewRow(null)}
        recipient={approvePreviewRow?.email ?? ""}
        subject={RESIDENT_WELCOME_EMAIL_SUBJECT}
        body={
          approvePreviewRow
            ? buildResidentWelcomeEmailBody({
                residentName: approvePreviewRow.name || undefined,
                axisId: approvePreviewRow.id,
                signupUrl: residentAccountCreationUrl("", approvePreviewRow.id),
              })
            : ""
        }
        intro={
          approvePreviewRow
            ? `Approving ${applicantDisplayName(approvePreviewRow)} will update their application status and can send their PropLane resident account setup email.`
            : undefined
        }
        confirmLabel="Approve & send setup email"
        confirmLabelWithoutMessage="Approve only"
        deliverViaKind="applications"
        smsAvailable
        confirmBusy={approvePreviewRow !== null && approveBusyId === approvePreviewRow.id}
        confirmBusyLabel="Approving…"
        onConfirm={(skipMessage) => {
          if (!approvePreviewRow) return;
          const row = approvePreviewRow;
          setApprovePreviewRow(null);
          setApproveBusyId(row.id);
          void setRowBucket(row.id, "approved", { skipWelcomeEmail: skipMessage }).finally(() => setApproveBusyId(null));
        }}
      />
      <ConfirmDeleteModal
        open={rejectPreviewRows !== null}
        title="Reject application"
        description={
          rejectPreviewRows?.length === 1 ? (
            <>
              Rejecting <span className="font-semibold">{applicantDisplayName(rejectPreviewRows[0]!)}</span>{" "}
              will move this application to the Rejected tab. The applicant will not receive an automatic email.
            </>
          ) : rejectPreviewRows && rejectPreviewRows.length > 1 ? (
            <>
              Reject <span className="font-semibold">{rejectPreviewRows.length} applications</span>? They will move to
              the Rejected tab and applicants will not receive an automatic email.
            </>
          ) : (
            ""
          )
        }
        confirmLabel="Reject"
        busy={rejectBusy}
        dataAttr="application-reject-confirm"
        onClose={() => {
          if (!rejectBusy) setRejectPreviewRows(null);
        }}
        onConfirm={() => {
          if (!rejectPreviewRows?.length) return;
          void rejectApplications(rejectPreviewRows);
        }}
      />
      <PortalNotificationPreviewModal
        open={reminderPreview !== null}
        title="Send application reminder"
        onClose={() => setReminderPreview(null)}
        recipient={reminderPreview?.to ?? ""}
        subject={reminderPreview?.subject ?? APPLICATION_COMPLETION_REMINDER_SUBJECT}
        body={reminderPreview?.text ?? ""}
        showSkipMessage={false}
        showChannelPicker
        emailAvailable
        smsAvailable
        deliverViaKind="applications"
        dynamicSendLabel
        assistantContext="Application completion reminder"
        confirmLabel="Send reminder"
        confirmBusy={reminderBusyId !== null}
        confirmBusyLabel="Sending…"
        onConfirm={(_skip, channels, draft) => {
          if (!reminderPreview) return;
          void sendApplicationReminder(reminderPreview.row, channels, draft);
        }}
      />
      <ShareLeadLinkModal
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        kind="apply"
        properties={shareableProperties}
      />
      <ManagerEditApplicationModal
        open={editApplicationOpen}
        onClose={() => setEditApplicationOpen(false)}
        propertyOptions={propertyOptions}
        managerUserId={userId}
        onSaved={() => setPortfolioTick((n) => n + 1)}
        showToast={showToast}
      />
      {addApplicationOpen ? (
        <ManagerApplicationOnBehalfModal
          open={addApplicationOpen}
          onClose={() => setAddApplicationOpen(false)}
          managerUserId={userId}
          basePath={basePath}
          onSubmitted={() => {
            void syncManagerApplicationsFromServer({ force: true, managerUserId: userId }).then(() =>
              setRows(readManagerApplicationRows()),
            );
          }}
        />
      ) : null}
      <ApplicationHoldingFeeModal
        row={
          holdingFeeRowId
            ? scopedRows.find((r) => r.id === holdingFeeRowId) ??
              (detailRow?.id === holdingFeeRowId ? detailRow : null)
            : null
        }
        open={holdingFeeRowId !== null}
        onClose={() => setHoldingFeeRowId(null)}
      />
      {checkrScreeningModal}
    </>
  );

  if (applicationIdProp) {
    if (!detailRow) {
      return (
        <>
          {applicationModals}
          <PortalRecordDetailPage
            pageTitle="Applications"
            title="Application"
            backHref={applicationsListHref(bucketProp)}
            hideBackText
            bareHeader
            dataAttrBack="application-detail-back"
            pinScrollBody
          >
            <div className="px-3 py-6">
              <ListSkeleton rows={4} showLeading={false} />
            </div>
          </PortalRecordDetailPage>
        </>
      );
    }

    return (
      <>
        {applicationModals}
        <PortalRecordDetailPage
          pageTitle="Applications"
          title={
            activeCosignerSubmission
              ? activeCosignerSubmission.fullName || "Co-signer application"
              : applicantDisplayName(detailRow)
          }
          subtitle={
            activeCosignerSubmission
              ? activeCosignerSubmission.email || `Co-signer for ${applicantDisplayName(detailRow)}`
              : applicantSecondaryEmail(detailRow) || undefined
          }
          avatarName={
            activeCosignerSubmission
              ? activeCosignerSubmission.fullName || "Co-signer"
              : applicantDisplayName(detailRow)
          }
          backHref={
            activeCosignerSubmission
              ? applicationDetailHref(basePath, tabForRow(detailRow), detailRow.id)
              : applicationsListHref(tabForRow(detailRow))
          }
          hideBackText
          bareHeader
          dataAttrBack="application-detail-back"
          pinScrollBody
          scrollBody={false}
          footerOmitSpacer
          footer={(() => {
            if (activeCosignerSubmission) {
              const actions = renderCosignerDetailActions(detailRow, activeCosignerSubmission);
              if (!actions) return undefined;
              return <ResidentDocumentsDetailFooter>{actions}</ResidentDocumentsDetailFooter>;
            }
            const actions = renderApplicationRowActions(detailRow);
            if (!actions) return undefined;
            return <ResidentDocumentsDetailFooter>{actions}</ResidentDocumentsDetailFooter>;
          })()}
        >
          <div className="flex min-h-0 flex-1 flex-col">
            {/*
              The action dock (Share / Approve / Reject / Holding fee /
              Download) is `position: fixed` and rendered with omitSpacer, so
              this padding is the only thing keeping the last rows reachable.
              It used to drop to `lg:pb-3` — 12px against a ~56px dock — which
              hid the end of every application on desktop.
            */}
            <PortalPageScrollBody className="min-w-0 max-w-full pt-3 pb-[calc(3.5rem+var(--portal-native-bottom-nav-inset,0px)+env(safe-area-inset-bottom,0px))]">
              {activeCosignerSubmission ? (
                <ManagerCosignerReadonlyReview
                  sub={activeCosignerSubmission}
                  signerRow={detailRow}
                  onOpenSignerApplication={() =>
                    navigate(applicationDetailHref(basePath, tabForRow(detailRow), detailRow.id))
                  }
                />
              ) : (
                renderApplicationDetail(detailRow)
              )}
            </PortalPageScrollBody>
          </div>
        </PortalRecordDetailPage>
      </>
    );
  }

  return (
    <>
    <ManagerPortalPageShell
      title="Applications"
      hideTitleOnMobileNav
      titleInlineFilter={null}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-2"
        variant="command"
        destinations={tabs.map((t) => ({
          id: t.id,
          label: t.label,
          href: applicationsListHref(t.id),
          count: t.count,
          dataAttr: `applications-bucket-${t.id}`,
        }))}
        activeDestinationId={bucket}
        destinationAriaLabel="Application status"
        actions={applicationsListActions}
        activeFilterChips={
          propertyFilters.length > 0 ? (
            <PortalActiveFilterChips
              chips={[
                {
                  id: "property",
                  label: `Property: ${propertyFilterLabel}`,
                  onRemove: () => setPropertyFilters([]),
                },
              ]}
            />
          ) : null
        }
      />
      <div className="mt-2 space-y-4 max-md:mt-3">
      <ManagerScreeningSettingsModal open={screeningModalOpen} onClose={() => setScreeningModalOpen(false)} />
      <ManagerPortalSettingsModal
        open={applicationSettingsOpen}
        onClose={() => setApplicationSettingsOpen(false)}
        initialTab="applications"
        scoped
        propertyOptions={propertyOptions}
        initialPropertyId={propertyFilters.length === 1 ? propertyFilters[0] : undefined}
      />
      {checkrScreeningModal}
      {!authReady && rows.length === 0 ? (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <ListSkeleton rows={5} showLeading={false} />
        </div>
      ) : (
        <PortalRecordListSurface
          isEmpty={rowsForBucket.length === 0}
          empty={
            propertyFilters.length > 0 ? (
              <PortalDataTableEmpty icon="default" message="No applications match your filters." />
            ) : (
              <PortalDataTableEmpty icon="application" message={applicationsListEmptyMessage(bucket)} />
            )
          }
          add={{
            label: "Add",
            ariaLabel: "Add application on behalf",
            icon: PORTAL_LIST_ADD_ICONS.application,
            onClick: openAddApplication,
            disabled: propertyOptions.length === 0,
            dataAttr: "applications-list-add",
          }}
          bulkCount={listSelectedCount}
          bulkActions={
            selectedListRows.length > 0 ? (
              <>
                {canBulkSendReminder && singleListSelectedRow ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={PORTAL_BULK_BAR_BTN}
                    data-attr="applications-bulk-send-reminder"
                    disabled={reminderPreviewBusyId !== null || reminderBusyId !== null}
                    onClick={() => openReminderPreview(singleListSelectedRow)}
                  >
                    {reminderPreviewBusyId === singleListSelectedRow.id ? "Loading…" : "Send reminder"}
                  </Button>
                ) : null}
                {canBulkShare && singleListSelectedRow ? (
                  <PortalRecordShareLinkButton
                    kind="application"
                    recordId={singleListSelectedRow.id}
                    className={PORTAL_BULK_BAR_BTN}
                    dataAttr="applications-bulk-share"
                    recordTitle={bulkShareRecordTitle}
                  />
                ) : null}
                {canBulkApprove ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={PORTAL_BULK_BAR_BTN}
                    data-attr="applications-bulk-approve"
                    onClick={() => {
                      if (selectedApprovableRows.length === 1) setApprovePreviewRow(selectedApprovableRows[0]!);
                    }}
                  >
                    Approve
                  </Button>
                ) : null}
                {canBulkReject ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={PORTAL_BULK_BAR_BTN}
                    data-attr="applications-bulk-reject"
                    onClick={() => setRejectPreviewRows(selectedRejectableRows)}
                  >
                    Reject
                  </Button>
                ) : null}
                {canBulkHoldingFee && singleListSelectedRow ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={PORTAL_BULK_BAR_BTN}
                    data-attr="applications-bulk-holding-fee"
                    onClick={() => setHoldingFeeRowId(singleListSelectedRow.id)}
                  >
                    Holding fee
                  </Button>
                ) : null}
                {canBulkDownload && singleListSelectedRow ? (
                  <ApplicationPdfDownloadButton
                    row={singleListSelectedRow}
                    label="Download"
                    className={PORTAL_BULK_BAR_BTN}
                  />
                ) : null}
                {canBulkMoveToPending && singleListSelectedRow ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={PORTAL_BULK_BAR_BTN}
                    data-attr="applications-bulk-move-pending"
                    onClick={() => void setRowBucket(singleListSelectedRow.id, "pending")}
                  >
                    Move to pending
                  </Button>
                ) : null}
                {canBulkDelete ? (
                  <Button
                    type="button"
                    variant="outline"
                    className={`${PORTAL_BULK_BAR_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
                    data-attr="applications-bulk-delete"
                    onClick={() => void deleteListSelectedApplications()}
                  >
                    Delete
                  </Button>
                ) : null}
              </>
            ) : null
          }
        >
          {rowsForBucket.length > 0 ? (
            <ManagerApplicationsGroupedTable
              clusters={listClusters}
              cosignerSubmissionsBySigner={cosignerSubmissionsBySigner}
              selectable
              selectedIds={selectedIds}
              onToggleSelected={toggleSelected}
              onOpenApplication={(row) => navigate(applicationDetailHref(basePath, tabForRow(row), row.id))}
              onOpenCosigner={(row, index) =>
                navigate(`${applicationDetailHref(basePath, tabForRow(row), row.id)}?cosigner=${index}`)
              }
            />
          ) : null}
        </PortalRecordListSurface>
      )}
      </div>
    </ManagerPortalPageShell>
      {applicationModals}
    </>
  );
}
