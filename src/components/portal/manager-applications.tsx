"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { Badge } from "@/components/ui/badge";
import { PortalNotificationPreviewModal } from "@/components/portal/portal-notification-preview-modal";
import { ShareLeadLinkModal } from "@/components/portal/share-lead-link-modal";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import {
  ManagerPortalPageShell,
  PORTAL_HEADER_ACTION_BTN,
  RESIDENT_DETAIL_HEADER_ACTION_BTN,
  RESIDENT_DETAIL_HEADER_ACTIONS_ROW,
} from "@/components/portal/portal-metrics";
import { PortalAdaptiveHeaderActions } from "@/components/portal/portal-adaptive-header-actions";
import { ApplicationFilterSortFields } from "@/components/portal/application-filter-sort-fields";
import { PortalFilterSortSheet, portalFilterActiveCount } from "@/components/portal/portal-filter-sort-sheet";
import { PORTAL_PROPERTY_FILTER_SHEET_CLASS } from "@/components/portal/portal-filter-shell";
import { armFilterSheetOpenSuppressFromOverlayDismiss } from "@/components/ui/field-select-portal-interaction";
import { PortalActiveFilterChips } from "@/components/portal/portal-filter-chips";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalRecordDetailPage } from "@/components/portal/portal-record-detail-page";
import { PORTAL_LIST_PAGE_BODY } from "@/components/portal/portal-inbox-ui";
import {
  PORTAL_DATA_TABLE_WRAP,
  PORTAL_DETAIL_BTN,
  PortalTableDetailActions,
} from "@/components/portal/portal-data-table";
import { UploadedLeasePdfPreview } from "@/components/portal/uploaded-lease-pdf-preview";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import { DestinationNav } from "@/components/ui/destination-nav";
import { ApplicationReviewLauncherRow, type ApplicationReviewView } from "@/components/portal/application-review-launcher-row";
import { downloadBackgroundCheckForApplication } from "@/components/portal/application-screening-panel";
import { ApplicationHoldingFeeModal } from "@/components/portal/application-holding-fee-box";
import { ManagerEditApplicationModal } from "@/components/portal/manager-edit-application-modal";
import { ManagerApplicationOnBehalfModal } from "@/components/portal/manager-application-on-behalf-modal";
import {
  PortalListAddRow,
  PORTAL_LIST_ADD_ICONS,
  PORTAL_LIST_ADD_ROW_WRAP_CLASS,
} from "@/components/portal/portal-list-add-row";
import { CheckrScreeningModal } from "@/components/portal/checkr-screening-modal";
import { ManagerScreeningSettingsButton, ManagerScreeningSettingsModal } from "@/components/portal/manager-screening-settings";
import { ManagerPortalSettingsModal } from "@/components/portal/manager-portal-settings-modal";
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
import { buildManagerShareablePropertyOptions } from "@/lib/manager-property-links";
import { syncPropertyPipelineFromServer, hasCachedPropertyPipeline } from "@/lib/demo-property-pipeline";
import { transitionApplicationBucket } from "@/lib/application-review";
import { useApplicationAutomation } from "@/hooks/use-application-automation";
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
import { ManagerApplicationsGroupedTable } from "@/components/portal/manager-applications-grouped-table";
import {
  ApplicationGroupSection,
  groupIdForRow,
  groupRowInputForRow,
} from "@/components/portal/application-group-section";
import { ApplicationCosignerSection } from "@/components/portal/application-household-list";
import { ManagerCosignerReadonlyReview } from "@/components/portal/manager-cosigner-readonly-review";
import { useCosignerSubmissionsMap } from "@/hooks/use-cosigner-submissions-map";
import {
  clusterApplicationListRows,
  sortApplicationClustersForBucket,
} from "@/lib/manager-application-list";
import { signerAppIdsForCosignerLookup } from "@/lib/rental-application/application-list-grouping";
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
  type ApplicationListTabId,
} from "@/lib/portal-detail-routes";
import {
  appendPortalPropertyFilterQuery,
  parsePortalPropertyFilterQuery,
  portalPropertyFilterIdsEqual,
  sanitizePortalPropertyFilterIds,
} from "@/lib/portal-property-list-filters";

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
}: {
  bucket?: ManagerApplicationTabId;
  basePath?: string;
  applicationId?: string;
}) {
  const { showToast } = useAppUi();
  const { userId, ready: authReady } = useManagerUserId();
  const applicationAutomation = useApplicationAutomation(userId);
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
  const [searchQuery, setSearchQuery] = useState("");
  const [rows, setRows] = useState<DemoApplicantRow[]>(() =>
    typeof window === "undefined" ? [] : readManagerApplicationRows(),
  );
  const [portfolioTick, setPortfolioTick] = useState(() =>
    typeof window === "undefined" ? 0 : hasCachedPropertyPipeline() ? 1 : 0,
  );
  const [approvePreviewRow, setApprovePreviewRow] = useState<DemoApplicantRow | null>(null);
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
  useEffect(() => {
    if (!addApplicationOpen) return;
    setApplicationsFilterOpen(false);
  }, [addApplicationOpen]);
  const [editApplicationOpen, setEditApplicationOpen] = useState(false);
  const [screeningModalOpen, setScreeningModalOpen] = useState(false);
  const [applicationSettingsOpen, setApplicationSettingsOpen] = useState(false);
  const [checkrScreeningRowId, setCheckrScreeningRowId] = useState<string | null>(null);
  // Holding fee lives in the detail's top-right action row, not inline in the
  // body: it is an occasional manager action, and inline it pushed the
  // applicant's own answers below the fold.
  const [holdingFeeRowId, setHoldingFeeRowId] = useState<string | null>(null);
  const [checkrScreeningShowPicker, setCheckrScreeningShowPicker] = useState(false);
  const [applicationReviewView, setApplicationReviewView] = useState<ApplicationReviewView>("application");
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
      setApplicationReviewView("background-check");

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
    setApplicationReviewView("background-check");
  }, [handleScreeningUpdated]);

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
    const inBucket = propertyFilteredRows.filter((r) => tabForRow(r) === bucket);
    const q = searchQuery.trim().toLowerCase();
    const searched = q
      ? inBucket.filter((r) =>
          [r.name, r.email, r.property, r.id, r.application?.email]
            .filter(Boolean)
            .join(" ")
            .toLowerCase()
            .includes(q),
        )
      : inBucket;
    return searched;
  }, [propertyFilteredRows, bucket, searchQuery]);

  const listClusters = useMemo(
    () => sortApplicationClustersForBucket(clusterApplicationListRows(rowsForBucket), bucket),
    [rowsForBucket, bucket],
  );

  const openDetailScreeningModal = useCallback((row: DemoApplicantRow, opts?: { showPackagePicker?: boolean }) => {
    setCheckrScreeningShowPicker(Boolean(opts?.showPackagePicker));
    setCheckrScreeningRowId(row.id);
  }, []);

  const onIncompleteApplicationsRoute = /\/applications\/incomplete(?:\/|$)/.test(pathname);
  const viewingIncompleteApplicationDetail =
    Boolean(applicationIdProp) && (onIncompleteApplicationsRoute || bucketProp === "incomplete");

  const showCompletionReminderForRow = useCallback(
    (row: DemoApplicantRow) => {
      if (viewingIncompleteApplicationDetail && row.bucket === "pending") return true;
      if (row.bucket !== "pending" || isWithdrawnApplicationRow(row)) return false;
      const canApprove = !isInProgressApplicationRow(row);
      if (!canApprove) return true;
      return (
        isInProgressApplicationRow(row) ||
        applicationStageDisplayLabel(row) === INCOMPLETE_APPLICATION_LABEL ||
        shouldOfferApplicationCompletionReminder(row)
      );
    },
    [viewingIncompleteApplicationDetail],
  );

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
  const cosignerSubmissionsBySigner = useCosignerSubmissionsMap(cosignerSignerIds);

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

  const setRowBucket = async (id: string, nextBucket: ManagerApplicationBucket, opts?: { skipWelcomeEmail?: boolean }) => {
    const result = await transitionApplicationBucket(id, nextBucket, {
      userId: userId ?? null,
      skipWelcomeEmail: opts?.skipWelcomeEmail,
      // Without this a manager who switched automation on sees it do nothing when they approve
      // from this surface.
      automation: applicationAutomation,
    });
    if (!result) return;
    setRows(readManagerApplicationRows());
    if (result.blocked) {
      showToast(result.message ?? "That change could not be saved.");
      return;
    }

    router.push(applicationsListHref(nextBucket));
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

  const sendApplicationReminder = async (
    row: DemoApplicantRow,
    channels?: { viaEmail?: boolean; viaSms?: boolean },
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
    const showCompletionReminder = showCompletionReminderForRow(row);
    const renderSendReminderButton = (className = RESIDENT_DETAIL_HEADER_ACTION_BTN) => (
      <Button
        type="button"
        variant="outline"
        className={className}
        data-attr="application-send-reminder"
        disabled={reminderPreviewBusyId !== null || reminderBusyId !== null}
        onClick={() => openReminderPreview(row)}
      >
        {reminderPreviewBusyId === row.id ? "Loading…" : "Send reminder"}
      </Button>
    );
    const sendReminderButton = showCompletionReminder ? renderSendReminderButton() : null;
    const showsRunCheck =
      applicationShowsBackgroundCheck(row) &&
      Boolean(row.application?.consentCredit) &&
      row.backgroundCheck?.status !== "pending" &&
      row.backgroundCheck?.status !== "complete";
    const canDownloadScreening =
      row.backgroundCheck?.status === "complete" || (isDemoModeActive() && applicationShowsBackgroundCheck(row));
    const showsRunAgain =
      applicationShowsBackgroundCheck(row) &&
      Boolean(row.application?.consentCredit) &&
      row.backgroundCheck?.status === "complete";

    const approveButton =
      isPending && !isWithdrawnApplicationRow(row) && !isInProgressApplicationRow(row) ? (
        <Button
          type="button"
          variant="outline"
          className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
          data-attr="application-approve"
          onClick={() => setApprovePreviewRow(row)}
        >
          Approve
        </Button>
      ) : null;

    const rejectButton = isPending ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="application-reject"
        onClick={() => setRowBucket(row.id, "rejected")}
      >
        Reject
      </Button>
    ) : null;

    const runCheckButton = showsRunCheck ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="run-background-check"
        onClick={() => openDetailScreeningModal(row)}
      >
        Run background check
      </Button>
    ) : null;

    const runAgainButton = showsRunAgain ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="run-background-check-again"
        onClick={() => openDetailScreeningModal(row, { showPackagePicker: true })}
      >
        Run again
      </Button>
    ) : null;

    const downloadApplicationButton = (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="application-pdf-download"
        onClick={() => runApplicationPdfDownload(row, showToast)}
      >
        Download application
      </Button>
    );

    const downloadScreeningButton = canDownloadScreening ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="screening-pdf-download"
        onClick={() => downloadBackgroundCheckForApplication(row)}
      >
        Download background check
      </Button>
    ) : null;

    const moveToPendingButton = !isPending ? (
      <Button
        type="button"
        variant="outline"
        className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
        data-attr="application-move-pending"
        onClick={() => setRowBucket(row.id, "pending")}
      >
        Move to pending
      </Button>
    ) : null;

    const deleteButton = (
      <Button
        type="button"
        variant="outline"
        className={`${RESIDENT_DETAIL_HEADER_ACTION_BTN} border-rose-200 text-rose-800 hover:bg-[var(--status-overdue-bg)] portal-danger-outline`}
        data-attr="application-delete"
        onClick={() => deleteApplication(row.id)}
      >
        Delete
      </Button>
    );

    // Asking for a hold on a rejected or withdrawn application makes no sense,
    // so the button is absent rather than disabled there.
    const holdingFeeButton =
      row.bucket === "rejected" || isWithdrawnApplicationRow(row) ? null : (
        <Button
          type="button"
          variant="outline"
          className={RESIDENT_DETAIL_HEADER_ACTION_BTN}
          data-attr="application-holding-fee-open"
          onClick={() => setHoldingFeeRowId(row.id)}
        >
          Holding fee
        </Button>
      );

    const mobileOverflowMenu = (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            className={`${RESIDENT_DETAIL_HEADER_ACTION_BTN} max-md:px-2.5 max-md:text-base`}
            data-attr="application-more-actions"
            aria-label="More application actions"
          >
            …
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" backdrop>
          {showCompletionReminder ? (
            <DropdownMenuItem
              data-attr="application-send-reminder-menu"
              disabled={reminderPreviewBusyId !== null || reminderBusyId !== null}
              onSelect={() => void openReminderPreview(row)}
            >
              {reminderPreviewBusyId === row.id ? "Loading…" : "Send reminder"}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem data-attr="application-pdf-download" onSelect={() => runApplicationPdfDownload(row, showToast)}>
            Download application
          </DropdownMenuItem>
          {canDownloadScreening ? (
            <DropdownMenuItem
              data-attr="screening-pdf-download"
              onSelect={() => downloadBackgroundCheckForApplication(row)}
            >
              Download background check
            </DropdownMenuItem>
          ) : null}
          {holdingFeeButton ? (
            <DropdownMenuItem
              data-attr="application-holding-fee-open"
              onSelect={() => setHoldingFeeRowId(row.id)}
            >
              Holding fee
            </DropdownMenuItem>
          ) : null}
          {moveToPendingButton ? (
            <DropdownMenuItem data-attr="application-move-pending" onSelect={() => setRowBucket(row.id, "pending")}>
              Move to pending
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-attr="application-delete"
            className="text-[var(--status-overdue-fg)] focus:text-[var(--status-overdue-fg)]"
            onSelect={() => void deleteApplication(row.id)}
          >
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

    return (
      <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()} role="presentation">
        <PortalSectionActionRow variant="header" className={RESIDENT_DETAIL_HEADER_ACTIONS_ROW}>
          <div className="flex w-full max-w-full flex-wrap items-center justify-end gap-1 md:hidden">
            {sendReminderButton}
            {rejectButton}
            {approveButton}
            {runCheckButton}
            {runAgainButton}
            {mobileOverflowMenu}
          </div>
          <div className="hidden max-w-full flex-nowrap items-center gap-1 md:flex">
            {sendReminderButton}
            {rejectButton}
            {approveButton}
            {runCheckButton}
            {runAgainButton}
            {holdingFeeButton}
            {downloadApplicationButton}
            {downloadScreeningButton}
            {moveToPendingButton}
            {deleteButton}
          </div>
        </PortalSectionActionRow>
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
    const showHouseholdSections = applicationReviewView === "application";
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
      {showHouseholdSections && cosignerSubmissions.length > 0 ? (
        <ApplicationCosignerSection
          submissions={cosignerSubmissions}
          primaryApplicationAxisId={row.id}
          hasCosigner={row.application?.hasCosigner}
          onOpenCosigner={(index) => {
            const href = `${applicationDetailHref(basePath, tabForRow(row), row.id)}?cosigner=${index}`;
            navigate(href);
          }}
        />
      ) : null}
      {showHouseholdSections && group ? (
        <ApplicationGroupSection
          group={group}
          bundleGroup={group}
          currentRowId={row.id}
          assignedPropertyId={row.assignedPropertyId}
          assignedRoomChoice={row.assignedRoomChoice}
        />
      ) : null}

      <ApplicationReviewLauncherRow
        row={row}
        group={group}
        bareCanvas
        showDownload={false}
        activeView={applicationReviewView}
        onActiveViewChange={setApplicationReviewView}
        onScreeningUpdated={handleScreeningFlowComplete}
        onOpenScreeningModal={(opts) => openDetailScreeningModal(row, opts)}
        hasLinkedCosigner={cosignerSubmissions.length > 0}
        omitReviewSections={[
          ...(cosignerSubmissions.length > 0 ? (["cosigner"] as const) : []),
          ...(group ? (["group", "placement"] as const) : []),
        ]}
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
      filterFieldCount={1}
      constrainDropdownToTitleBand
      mobileFlushBody
      onReset={() => setPropertyFilters([])}
      dataAttr="applications-filter-sheet-open"
      className={PORTAL_PROPERTY_FILTER_SHEET_CLASS}
    >
      <ApplicationFilterSortFields
        propertyOptions={propertyOptions}
        propertyFilters={propertyFilters}
        onPropertyFiltersChange={setPropertyFilters}
        selectionMode="multi"
      />
    </PortalFilterSortSheet>
  );

  const applicationsEditButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_HEADER_ACTION_BTN}
      data-attr="edit-application-open"
      onClick={() => setEditApplicationOpen(true)}
      disabled={propertyOptions.length === 0}
      title={propertyOptions.length === 0 ? "Add a property before editing its application" : undefined}
    >
      Edit
    </Button>
  );

  const applicationsSendButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_HEADER_ACTION_BTN}
      onClick={() => setInviteModalOpen(true)}
      disabled={shareableProperties.length === 0}
      title={shareableProperties.length === 0 ? "List a property as active before sending to prospects" : undefined}
    >
      Send
    </Button>
  );

  const applicationsAddButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_HEADER_ACTION_BTN}
      data-attr="applications-add"
      onClick={openAddApplication}
      disabled={propertyOptions.length === 0}
      title={propertyOptions.length === 0 ? "Add a property before starting an application" : undefined}
    >
      Add
    </Button>
  );

  const applicationsSettingsButton = (
    <Button
      type="button"
      variant="outline"
      className={PORTAL_HEADER_ACTION_BTN}
      data-attr="application-settings-open"
      onClick={() => setApplicationSettingsOpen(true)}
    >
      Settings
    </Button>
  );

  const applicationsScreeningButton = (
    <ManagerScreeningSettingsButton
      className="w-full shrink-0 md:w-auto"
      onClick={() => setScreeningModalOpen(true)}
    />
  );

  const applicationsHeaderActions = (
    <PortalAdaptiveHeaderActions
      className="w-full min-w-0"
      moreDataAttr="applications-more-actions"
      moreAriaLabel="More application actions"
      actions={[
        {
          id: "edit",
          keepPriority: 4,
          node: applicationsEditButton,
          menuItem: (
            <DropdownMenuItem
              data-attr="edit-application-menu"
              disabled={propertyOptions.length === 0}
              onSelect={() => setEditApplicationOpen(true)}
            >
              Edit
            </DropdownMenuItem>
          ),
        },
        {
          id: "send",
          keepPriority: 3,
          node: applicationsSendButton,
          menuItem: (
            <DropdownMenuItem
              disabled={shareableProperties.length === 0}
              onSelect={() => setInviteModalOpen(true)}
            >
              Send
            </DropdownMenuItem>
          ),
        },
        {
          id: "settings",
          keepPriority: 2,
          node: applicationsSettingsButton,
          menuItem: (
            <DropdownMenuItem
              data-attr="application-settings-menu"
              onSelect={() => setApplicationSettingsOpen(true)}
            >
              Settings
            </DropdownMenuItem>
          ),
        },
        {
          id: "screening",
          keepPriority: 1,
          node: applicationsScreeningButton,
          menuItem: (
            <DropdownMenuItem
              data-attr="application-screening-menu"
              onSelect={() => setScreeningModalOpen(true)}
            >
              Screening
            </DropdownMenuItem>
          ),
        },
        {
          id: "add",
          alwaysVisible: true,
          pinEdge: "end",
          node: applicationsAddButton,
          menuItem: (
            <DropdownMenuItem
              data-attr="applications-add-menu"
              disabled={propertyOptions.length === 0}
              onSelect={(event) => {
                event.preventDefault();
                openAddApplication();
              }}
            >
              Add
            </DropdownMenuItem>
          ),
        },
      ]}
    />
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
      <PortalNotificationPreviewModal
        open={reminderPreview !== null}
        title="Send application reminder"
        onClose={() => setReminderPreview(null)}
        recipient={reminderPreview?.to ?? ""}
        subject={reminderPreview?.subject ?? APPLICATION_COMPLETION_REMINDER_SUBJECT}
        body={reminderPreview?.text ?? ""}
        intro="Choose Email and/or SMS. Always saved to PropLane inbox."
        showSkipMessage={false}
        showChannelPicker
        emailAvailable
        smsAvailable
        confirmLabel="Send reminder"
        confirmBusy={reminderBusyId !== null}
        confirmBusyLabel="Sending…"
        onConfirm={(_skip, channels) => {
          if (!reminderPreview) return;
          void sendApplicationReminder(reminderPreview.row, channels);
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
      <CheckrScreeningModal
        key={checkrScreeningRowId ?? "none"}
        row={
          checkrScreeningRowId
            ? scopedRows.find((r) => r.id === checkrScreeningRowId) ??
              (detailRow?.id === checkrScreeningRowId ? detailRow : null)
            : null
        }
        hasLinkedCosigner={
          checkrScreeningRowId
            ? (cosignerSubmissionsBySigner.get(
                normalizeApplicationAxisId(checkrScreeningRowId).toUpperCase(),
              ) ?? []).length > 0
            : false
        }
        open={checkrScreeningRowId !== null}
        showPackagePickerInitially={checkrScreeningShowPicker}
        onClose={() => {
          setCheckrScreeningRowId(null);
          setCheckrScreeningShowPicker(false);
        }}
        onUpdated={handleScreeningFlowComplete}
      />
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
          inlineActions={!activeCosignerSubmission}
          actions={activeCosignerSubmission ? undefined : renderApplicationRowActions(detailRow)}
          pinScrollBody
        >
          {activeCosignerSubmission ? (
            <ManagerCosignerReadonlyReview
              sub={activeCosignerSubmission}
              primaryApplicationAxisId={detailRow.id}
            />
          ) : (
            renderApplicationDetail(detailRow)
          )}
        </PortalRecordDetailPage>
      </>
    );
  }

  return (
    <>
    <ManagerPortalPageShell
      title="Applications"
      hideTitleOnMobileNav
      titleInlineFilter={applicationsFilterSort}
      titleAside={applicationsHeaderActions}
      compactFilterRow
    >
      <PortalListControlStack
        className="mb-2 max-lg:mb-2"
        destinationRow={
          <DestinationNav
            items={tabs.map((t) => ({
              id: t.id,
              label: t.label,
              href: applicationsListHref(t.id),
              count: t.count,
              dataAttr: `applications-bucket-${t.id}`,
            }))}
            activeId={bucket}
            ariaLabel="Application status"
            itemLayout="equal"
            className="max-lg:rounded-none max-lg:border-0 max-lg:border-b max-lg:border-border max-lg:bg-transparent max-lg:p-0"
          />
        }
        search={{
          value: searchQuery,
          onChange: setSearchQuery,
          placeholder: "Search applicants",
          dataAttr: "applications-search",
        }}
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
      />
      <CheckrScreeningModal
        key={checkrScreeningRowId ?? "none"}
        row={scopedRows.find((r) => r.id === checkrScreeningRowId) ?? null}
        open={checkrScreeningRowId !== null}
        showPackagePickerInitially={checkrScreeningShowPicker}
        onClose={() => {
          setCheckrScreeningRowId(null);
          setCheckrScreeningShowPicker(false);
        }}
        onUpdated={handleScreeningFlowComplete}
      />
      {!authReady && rows.length === 0 ? (
        <div className={PORTAL_DATA_TABLE_WRAP}>
          <ListSkeleton rows={5} showLeading={false} />
        </div>
      ) : rowsForBucket.length === 0 ? (
        <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
          <PortalListAddRow
            label="Add"
            icon={PORTAL_LIST_ADD_ICONS.application}
            onClick={openAddApplication}
            disabled={propertyOptions.length === 0}
            dataAttr="applications-list-add"
          />
        </div>
      ) : (
        <div className={PORTAL_LIST_PAGE_BODY}>
          <ManagerApplicationsGroupedTable
            clusters={listClusters}
            cosignerSubmissionsBySigner={cosignerSubmissionsBySigner}
            onOpenApplication={(row) => navigate(applicationDetailHref(basePath, tabForRow(row), row.id))}
            onOpenCosigner={(row, index) =>
              navigate(`${applicationDetailHref(basePath, tabForRow(row), row.id)}?cosigner=${index}`)
            }
            showReminderForRow={showCompletionReminderForRow}
            onSendReminder={(row) => void openReminderPreview(row)}
            reminderBusyId={reminderPreviewBusyId ?? reminderBusyId}
          />
          <div className={PORTAL_LIST_ADD_ROW_WRAP_CLASS}>
            <PortalListAddRow
              label="Add"
              icon={PORTAL_LIST_ADD_ICONS.application}
              onClick={openAddApplication}
              disabled={propertyOptions.length === 0}
              dataAttr="applications-list-add"
            />
          </div>
        </div>
      )}
      </div>
    </ManagerPortalPageShell>
      {applicationModals}
    </>
  );
}
