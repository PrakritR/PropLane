"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import { PORTAL_HEADER_ACTION_BTN } from "@/components/portal/portal-metrics";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { isScreeningTestModeActive } from "@/lib/screening/screening-test-mode";
import { applyDemoBackgroundCheckResolution } from "@/lib/screening/apply-demo-background-check";
import { buildBackgroundCheckReportHtml } from "@/lib/background-check-report-html";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";
import type { ManagerScreeningSettings } from "@/lib/screening/types";
import { BackgroundCheckHouseholdTable } from "@/components/portal/background-check-household-table";
import {
  buildScreeningSubjects,
  cosignerSubmissionIdForSubject,
  resolveScreeningSubjectId,
  screeningRowForSubject,
} from "@/lib/background-check-subjects";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";

const DEMO_SCREENING_DEFAULTS = { mode: "manual" as const };

function backgroundCheckDocumentHref(
  applicationId: string,
  opts?: { attachment?: boolean; cacheKey?: string; cosignerSubmissionId?: string },
): string {
  const params = new URLSearchParams({ applicationId });
  if (opts?.attachment) params.set("disposition", "attachment");
  if (opts?.cacheKey) params.set("v", opts.cacheKey);
  if (opts?.cosignerSubmissionId) params.set("cosignerSubmissionId", opts.cosignerSubmissionId);
  return `/api/screening/background-check/document?${params.toString()}`;
}

function downloadBackgroundCheckPdf(
  applicationId: string,
  opts?: { cosignerSubmissionId?: string },
): void {
  const anchor = document.createElement("a");
  anchor.href = backgroundCheckDocumentHref(applicationId, {
    attachment: true,
    cosignerSubmissionId: opts?.cosignerSubmissionId,
  });
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** Download the background-check report PDF for an application row. */
export function downloadBackgroundCheckForApplication(
  row: DemoApplicantRow,
  opts?: { cosignerSubmissionId?: string },
): void {
  const demo = isDemoModeActive() || isScreeningTestModeActive();
  if (demo) {
    void import("@/lib/demo/demo-document-files")
      .then(({ downloadDemoBackgroundCheckPdf }) => downloadDemoBackgroundCheckPdf(row))
      .catch(() => undefined);
    return;
  }
  if (row.backgroundCheck?.status === "complete") {
    downloadBackgroundCheckPdf(row.id, { cosignerSubmissionId: opts?.cosignerSubmissionId });
  }
}

export function BackgroundCheckReportFrame({
  row,
  demo,
  bareCanvas = false,
  stretch = false,
  cosignerSubmissionId,
}: {
  row: DemoApplicantRow;
  demo: boolean;
  bareCanvas?: boolean;
  stretch?: boolean;
  cosignerSubmissionId?: string;
}) {
  const bg = row.backgroundCheck;
  const reportHtml = useMemo(() => buildBackgroundCheckReportHtml(row), [row]);
  const canTryOfficialPdf = bg?.status === "complete" && !(bg.simulated && demo);
  const pdfCacheKey = bg
    ? `${bg.reportId ?? ""}:${bg.reportResourceId ?? ""}:${bg.completedAt ?? ""}`
    : "";
  const pdfHref = canTryOfficialPdf
    ? backgroundCheckDocumentHref(row.id, { cacheKey: pdfCacheKey, cosignerSubmissionId })
    : null;
  const pdfSrc = pdfHref ? `${pdfHref}#toolbar=0&navpanes=0` : null;
  const [pdfFailed, setPdfFailed] = useState(false);
  const [pdfReady, setPdfReady] = useState(false);

  useEffect(() => {
    if (!pdfHref) {
      setPdfFailed(false);
      setPdfReady(false);
      return;
    }

    let cancelled = false;
    setPdfFailed(false);
    setPdfReady(false);

    void fetch(pdfHref, { credentials: "include" })
      .then((res) => {
        if (cancelled) return;
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !type.includes("pdf")) {
          setPdfFailed(true);
          return;
        }
        setPdfReady(true);
      })
      .catch(() => {
        if (!cancelled) setPdfFailed(true);
      });

    return () => {
      cancelled = true;
    };
  }, [pdfHref]);

  const frameClass = stretch
    ? "absolute inset-0 h-full w-full border-0 bg-white"
    : bareCanvas
      ? "h-[min(70vh,720px)] w-full border-0 bg-white"
      : "h-[min(52vh,420px)] w-full border-0 bg-white";

  const frameShell = (content: ReactNode) =>
    stretch ? (
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl border border-border bg-card">{content}</div>
    ) : (
      content
    );

  if (pdfSrc && !pdfFailed) {
    if (!pdfReady) {
      return frameShell(
        <div className={`flex items-center justify-center text-sm text-muted ${stretch ? "h-full min-h-[12rem]" : frameClass}`}>
          Loading Checkr report…
        </div>,
      );
    }
    return frameShell(
      <iframe
        key={pdfSrc}
        src={pdfSrc}
        title="Background check report preview"
        loading="lazy"
        className={frameClass}
      />,
    );
  }

  if (!reportHtml) {
    if (demo) {
      return (
        <div className="flex h-[min(24vh,200px)] items-center justify-center px-4 text-center text-sm text-muted">
          No screening report yet. Click Test to run a demo background check.
        </div>
      );
    }
    return null;
  }

  return frameShell(
    <iframe
      srcDoc={reportHtml}
      title="Background check report preview"
      sandbox=""
      loading="lazy"
      scrolling={stretch ? "yes" : undefined}
      className={frameClass}
    />,
  );
}

export function backgroundCheckChip(bc: ApplicationBackgroundCheck): { label: string; className: string } {
  const ring = "ring-1 ring-[color-mix(in_srgb,currentColor_25%,transparent)]";
  if (bc.status !== "complete") {
    return { label: "Checkr: Pending", className: `portal-badge-info ${ring}` };
  }
  if (bc.result === "clear") {
    return { label: "Checkr: Clear", className: `portal-badge-success ${ring}` };
  }
  if (bc.result === "consider") {
    return { label: "Checkr: Consider", className: `portal-badge-pending ${ring}` };
  }
  const label = bc.status.charAt(0).toUpperCase() + bc.status.slice(1);
  return { label: `Checkr: ${label}`, className: `portal-badge-pending ${ring}` };
}

export function ApplicationScreeningPanel({
  row,
  onUpdated,
  onOpenScreeningModal,
  collapsible = true,
  bareCanvas = false,
  stretch = false,
  headerActionsPlacement = "section",
  onHeaderActionsChange,
  compactTabFooterActions = false,
  presentation = "full",
  className,
  cosignerSubmissions = [],
  screeningSubjectId,
  onScreeningSubjectChange,
  onRequestChecksForSubjects,
  cosignerSubmissionId: cosignerSubmissionIdProp,
}: {
  row: DemoApplicantRow;
  onUpdated?: () => void;
  /** Opens the cost-confirmation modal (billed to the manager) to start/re-run the Checkr check. */
  onOpenScreeningModal?: (opts?: { showPackagePicker?: boolean }) => void;
  /** When false, renders flat content (e.g. inside a review modal). */
  collapsible?: boolean;
  bareCanvas?: boolean;
  stretch?: boolean;
  /** When `parent`, header buttons render via `onHeaderActionsChange` instead of the Screening sub-section. */
  headerActionsPlacement?: "section" | "parent";
  onHeaderActionsChange?: (actions: React.ReactNode) => void;
  /** When true with `headerActionsPlacement="parent"`, publish View report / Run again / Download for a tab footer. */
  compactTabFooterActions?: boolean;
  presentation?: "full" | "compact";
  className?: string;
  cosignerSubmissions?: CosignerSubmission[];
  screeningSubjectId?: string;
  onScreeningSubjectChange?: (subjectId: string) => void;
  /** Opens the screening modal for the checked household members (signer and/or co-signers). */
  onRequestChecksForSubjects?: (subjectIds: string[]) => void;
  cosignerSubmissionId?: string;
}) {
  const { showToast } = useAppUi();
  const demo = isDemoModeActive() || isScreeningTestModeActive();
  const screeningSubjects = useMemo(
    () => buildScreeningSubjects(row, cosignerSubmissions),
    [row, cosignerSubmissions],
  );
  const activeSubjectId = resolveScreeningSubjectId(
    screeningSubjects,
    screeningSubjectId ?? cosignerSubmissionIdProp,
    row.id,
  );
  const activeRow = useMemo(
    () => screeningRowForSubject(row, cosignerSubmissions, activeSubjectId),
    [row, cosignerSubmissions, activeSubjectId],
  );
  const activeCosignerSubmissionId =
    cosignerSubmissionIdProp ??
    cosignerSubmissionIdForSubject(screeningSubjects, activeSubjectId);
  const [selectedSubjectIds, setSelectedSubjectIds] = useState<Set<string>>(() => new Set([activeSubjectId]));

  useEffect(() => {
    setSelectedSubjectIds((prev) => {
      if (prev.has(activeSubjectId)) return prev;
      return new Set([activeSubjectId]);
    });
  }, [activeSubjectId]);
  const [settings, setSettings] = useState<ManagerScreeningSettings | null>(demo ? DEMO_SCREENING_DEFAULTS : null);
  const [configured, setConfigured] = useState(demo);
  const [screeningAllowed, setScreeningAllowed] = useState(true);
  const [busy, setBusy] = useState(false);
  const [bgConfigured, setBgConfigured] = useState(demo);
  const [bgOverride, setBgOverride] = useState<ApplicationBackgroundCheck | undefined>();
  const [bgBusy, setBgBusy] = useState(false);
  const bg = bgOverride ?? activeRow.backgroundCheck;

  useEffect(() => {
    setBgOverride(undefined);
  }, [
    row.id,
    activeSubjectId,
    activeRow.backgroundCheck?.status,
    activeRow.backgroundCheck?.completedAt,
  ]);

  useEffect(() => {
    if (demo) return;
    void fetch("/api/screening/settings", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as {
          settings?: ManagerScreeningSettings;
          configured?: boolean;
          backgroundCheckConfigured?: boolean;
          screeningAllowed?: boolean;
        };
        if (body.settings) setSettings(body.settings);
        setConfigured(Boolean(body.configured));
        setBgConfigured(Boolean(body.backgroundCheckConfigured));
        setScreeningAllowed(body.screeningAllowed !== false);
      })
      .catch(() => undefined);
  }, [demo]);

  const callBackgroundCheck = useCallback(
    async (action: "refresh") => {
      if (demo) return;
      setBgBusy(true);
      try {
        const res = await fetch("/api/screening/background-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            applicationId: row.id,
            cosignerSubmissionId: activeCosignerSubmissionId,
            action,
          }),
        });
        const body = (await res.json()) as { error?: string; backgroundCheck?: ApplicationBackgroundCheck };
        if (!res.ok) return;
        if (body.backgroundCheck) setBgOverride(body.backgroundCheck);
        if (body.backgroundCheck?.status === "complete") onUpdated?.();
      } finally {
        setBgBusy(false);
      }
    },
    [demo, onUpdated, row.id, activeCosignerSubmissionId],
  );

  useEffect(() => {
    if (demo || bg?.status !== "complete" || bg?.reportResourceId) return;
    void callBackgroundCheck("refresh");
  }, [bg?.reportResourceId, bg?.status, callBackgroundCheck, demo]);

  useEffect(() => {
    if (demo || bg?.status !== "pending") return;
    let cancelled = false;
    // Skip the poll for a hidden/background tab (egress on the free plan) and
    // widen the interval; the report only changes when Checkr finishes.
    const timer = setInterval(() => {
      if (cancelled || document.hidden) return;
      void callBackgroundCheck("refresh");
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [bg?.status, bg?.reportId, callBackgroundCheck, demo]);

  const runScreening = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/screening/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ applicationId: row.id }),
      });
      const body = (await res.json()) as { error?: string; code?: string };
      if (!res.ok) {
        showToast(body.error ?? "Could not order screening.");
        return;
      }
      showToast("Screening ordered. Results will appear when the report completes.");
      onUpdated?.();
    } catch {
      showToast("Network error ordering screening.");
    } finally {
      setBusy(false);
    }
  }, [onUpdated, row.id, showToast]);

  const handleDownload = useCallback(() => {
    if (demo) {
      void import("@/lib/demo/demo-document-files")
        .then(({ downloadDemoBackgroundCheckPdf }) =>
          downloadDemoBackgroundCheckPdf({ ...activeRow, backgroundCheck: bg }),
        )
        .catch(() => showToast("Could not download screening report."));
      return;
    }
    downloadBackgroundCheckPdf(row.id, { cosignerSubmissionId: activeCosignerSubmissionId });
  }, [activeCosignerSubmissionId, activeRow, bg, demo, row.id, showToast]);

  const showsBackgroundCheck = applicationShowsBackgroundCheck(row) || screeningSubjects.length > 0;
  const screening = activeRow.screening ?? row.screening;
  const canOrder =
    showsBackgroundCheck &&
    !demo &&
    screeningAllowed &&
    configured &&
    settings?.mode !== "off" &&
    activeRow.application?.consentCredit &&
    screening?.status !== "in_progress" &&
    screening?.status !== "queued" &&
    screening?.status !== "complete";

  const backgroundCheckComplete = bg?.status === "complete";
  const showCompletedState =
    showsBackgroundCheck && backgroundCheckComplete && Boolean(activeRow.application?.consentCredit);

  const canOfferRunBackgroundCheck =
    showsBackgroundCheck &&
    screeningAllowed &&
    bgConfigured &&
    bg?.status !== "pending" &&
    !backgroundCheckComplete &&
    Boolean(onOpenScreeningModal);

  const openRunBackgroundCheck = useCallback(
    (opts?: { showPackagePicker?: boolean }) => {
      if (!demo && !activeRow.application?.consentCredit) {
        showToast("Applicant must authorize a background check first.");
        return;
      }
      onOpenScreeningModal?.(opts);
    },
    [activeRow.application?.consentCredit, demo, onOpenScreeningModal, showToast],
  );

  const resolveDemoPendingCheck = useCallback(() => {
    const cosignerSub = activeCosignerSubmissionId
      ? cosignerSubmissions.find((s) => s.id === activeCosignerSubmissionId)
      : undefined;
    const resolved = applyDemoBackgroundCheckResolution(row, {
      cosignerSubmissionId: activeCosignerSubmissionId,
      cosignerSub,
    });
    setBgOverride(resolved);
    showToast("Test screening report updated.");
    onUpdated?.();
  }, [
    activeCosignerSubmissionId,
    cosignerSubmissions,
    onUpdated,
    row,
    showToast,
  ]);

  const canRunBackgroundCheckAgain =
    showCompletedState && screeningAllowed && Boolean(onOpenScreeningModal);

  const testButtonLabel = demo ? "Test" : "Run background check";
  const statusSummary =
    bg?.status === "complete"
      ? bg.result === "clear"
        ? "Clear — report ready to view."
        : bg.result === "consider"
          ? "Needs review — report ready to view."
          : "Report ready to view."
      : bg?.status === "pending"
        ? demo
          ? "Demo check in progress…"
          : "Checkr is processing. This updates automatically."
        : activeRow.application?.consentCredit
          ? "No report yet."
          : "";
  const headerActionBtnClass =
    headerActionsPlacement === "parent" ? PORTAL_HEADER_ACTION_BTN : "h-8 rounded-full px-4 text-xs";

  const headerActions = useMemo(
    () => (
      <>
        {bg?.status === "complete" ? (
          <Button
            type="button"
            variant="outline"
            className={headerActionBtnClass}
            data-attr="screening-pdf-download"
            onClick={handleDownload}
          >
            {headerActionsPlacement === "parent" ? "Download screening" : "Download PDF"}
          </Button>
        ) : null}
        {canOfferRunBackgroundCheck ? (
          <Button
            type="button"
            variant="outline"
            data-attr="run-background-check"
            className={headerActionBtnClass}
            onClick={() => openRunBackgroundCheck()}
          >
            {testButtonLabel}
          </Button>
        ) : null}
        {canOrder ? (
          <Button
            type="button"
            variant="primary"
            className={headerActionBtnClass}
            disabled={busy}
            onClick={() => runScreening()}
          >
            {busy ? "Ordering…" : screening?.status === "failed" ? "Re-run screening" : "Run screening"}
          </Button>
        ) : null}
      </>
    ),
    [
      bg?.status,
      busy,
      canOrder,
      canOfferRunBackgroundCheck,
      openRunBackgroundCheck,
      handleDownload,
      headerActionBtnClass,
      openRunBackgroundCheck,
      runScreening,
      screening?.status,
      testButtonLabel,
    ],
  );

  const headerActionsSignature = useMemo(
    () =>
      [
        showsBackgroundCheck,
        headerActionsPlacement,
        bg?.status ?? "",
        busy,
        canOrder,
        canOfferRunBackgroundCheck,
        screening?.status ?? "",
        testButtonLabel,
      ].join("|"),
    [
      bg?.status,
      busy,
      canOrder,
      canOfferRunBackgroundCheck,
      headerActionsPlacement,
      screening?.status,
      showsBackgroundCheck,
      testButtonLabel,
    ],
  );

  const compactTabFooterActionButtons = useMemo(
    () => (
      <>
        {canOfferRunBackgroundCheck ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_HEADER_ACTION_BTN}
            data-attr="run-background-check"
            onClick={() => openRunBackgroundCheck()}
          >
            {testButtonLabel}
          </Button>
        ) : null}
        {canRunBackgroundCheckAgain ? (
          <Button
            type="button"
            variant="outline"
            className={PORTAL_HEADER_ACTION_BTN}
            data-attr="run-background-check-again"
            onClick={() => onOpenScreeningModal?.({ showPackagePicker: true })}
          >
            Run again
          </Button>
        ) : null}
      </>
    ),
    [canOfferRunBackgroundCheck, canRunBackgroundCheckAgain, openRunBackgroundCheck, onOpenScreeningModal, testButtonLabel],
  );

  const compactTabFooterActionsSignature = useMemo(
    () => [bg?.status ?? "", canOfferRunBackgroundCheck, canRunBackgroundCheckAgain].join("|"),
    [bg?.status, canOfferRunBackgroundCheck, canRunBackgroundCheckAgain],
  );

  const publishedParentActions = compactTabFooterActions
    ? compactTabFooterActionButtons
    : headerActions;
  const publishedParentActionsSignature = compactTabFooterActions
    ? compactTabFooterActionsSignature
    : headerActionsSignature;

  // Assigned in a LAYOUT effect, not during render: a render-phase ref write is unsafe under
  // concurrent rendering. It has to be `useLayoutEffect` rather than `useEffect` because the
  // consumer below is one too, and layout effects run in declaration order — a plain effect
  // here would land after the consumer and feed it the previous render's values.
  const headerActionsRef = useRef(publishedParentActions);
  const publishedHeaderActionsSignatureRef = useRef<string | null>(null);
  const onHeaderActionsChangeRef = useRef(onHeaderActionsChange);
  useLayoutEffect(() => {
    headerActionsRef.current = publishedParentActions;
    onHeaderActionsChangeRef.current = onHeaderActionsChange;
  });

  useLayoutEffect(() => {
    const notify = onHeaderActionsChangeRef.current;
    if (headerActionsPlacement !== "parent" || !notify) return;

    if (!showsBackgroundCheck) {
      if (publishedHeaderActionsSignatureRef.current !== null) {
        publishedHeaderActionsSignatureRef.current = null;
        notify(null);
      }
      return;
    }

    if (publishedHeaderActionsSignatureRef.current === publishedParentActionsSignature) return;
    publishedHeaderActionsSignatureRef.current = publishedParentActionsSignature;
    notify(headerActionsRef.current);
  }, [
    headerActionsPlacement,
    publishedParentActionsSignature,
    showsBackgroundCheck,
  ]);

  useEffect(() => {
    if (headerActionsPlacement !== "parent") return;
    return () => {
      publishedHeaderActionsSignatureRef.current = null;
      onHeaderActionsChangeRef.current?.(null);
    };
  }, [headerActionsPlacement]);

  if (!showsBackgroundCheck) return null;

  if (presentation === "compact") {
    return (
      <>
        <div
          className="rounded-2xl border border-border bg-card px-4 py-3 shadow-sm"
          data-slot="application-background-check-compact"
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-semibold text-foreground">Background check</p>
              {statusSummary ? <p className="text-sm text-muted">{statusSummary}</p> : null}
              {bg?.status === "pending" && !demo ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
                  disabled={bgBusy}
                  onClick={() => void callBackgroundCheck("refresh")}
                >
                  Refresh now
                </button>
              ) : null}
              {bg?.status === "pending" && demo ? (
                <button
                  type="button"
                  className="text-xs font-semibold text-primary hover:underline"
                  data-attr="update-test-data"
                  onClick={resolveDemoPendingCheck}
                >
                  Update test data
                </button>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-nowrap items-center gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {canOfferRunBackgroundCheck ? (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_HEADER_ACTION_BTN}
                  data-attr="run-background-check"
                  onClick={() => openRunBackgroundCheck()}
                >
                  {testButtonLabel}
                </Button>
              ) : null}
              {canRunBackgroundCheckAgain ? (
                <Button
                  type="button"
                  variant="outline"
                  className={PORTAL_HEADER_ACTION_BTN}
                  data-attr="run-background-check-again"
                  onClick={() => onOpenScreeningModal?.({ showPackagePicker: true })}
                >
                  Run again
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </>
    );
  }

  const householdTable =
    screeningSubjects.length > 1 ? (
      <BackgroundCheckHouseholdTable
        subjects={screeningSubjects}
        viewSubjectId={activeSubjectId}
        onViewSubjectChange={(id) => onScreeningSubjectChange?.(id)}
        selectedSubjectIds={selectedSubjectIds}
        onSelectedSubjectIdsChange={setSelectedSubjectIds}
        onRequestChecks={
          onRequestChecksForSubjects
            ? () => onRequestChecksForSubjects([...selectedSubjectIds])
            : undefined
        }
      />
    ) : null;

  const panelHead = (
    <>
      {householdTable}
      {!screeningAllowed && !demo ? (
        <>
          <p className="native-hide text-xs text-muted">
            Screening requires Pro or Business.{" "}
            <Link href={MANAGER_PLAN_PORTAL_URL} className="font-semibold text-primary hover:underline">
              Upgrade your plan
            </Link>
          </p>
          <p className="native-only text-xs text-muted">
            Screening isn&apos;t included on your current plan.
          </p>
        </>
      ) : null}
      {bg?.status === "pending" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{demo ? "Demo screening in progress…" : "Checkr is processing. Status updates automatically."}</span>
          {!demo ? (
            <button
              type="button"
              className="font-semibold text-primary hover:underline disabled:opacity-50"
              disabled={bgBusy}
              onClick={() => void callBackgroundCheck("refresh")}
            >
              Refresh now
            </button>
          ) : (
            <button
              type="button"
              className="font-semibold text-primary hover:underline"
              data-attr="update-test-data"
              onClick={resolveDemoPendingCheck}
            >
              Update test data
            </button>
          )}
        </div>
      ) : null}
      {screening?.reportUrl ? (
        <Link
          href={screening.reportUrl.startsWith("http") ? screening.reportUrl : `https://${screening.reportUrl.replace(/^\/+/, "")}`}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm font-semibold text-primary hover:underline"
        >
          View full vendor report
        </Link>
      ) : null}
      {screeningAllowed && configured && settings?.mode === "off" && !demo ? (
        <p className="text-xs text-muted">Screening is off in Applications settings.</p>
      ) : null}
    </>
  );

  const reportFrame = (
          <BackgroundCheckReportFrame
            row={{ ...activeRow, backgroundCheck: bg }}
            demo={demo}
            bareCanvas={bareCanvas}
            stretch={stretch}
            cosignerSubmissionId={activeCosignerSubmissionId}
          />
  );

  const panelTail = (
    <>
      {screening?.adverseActionRequired ? (
        <p className="rounded-xl border px-3 py-2 text-xs portal-banner-pending">
          Adverse action may be required before denying based on this consumer report (FCRA).
        </p>
      ) : null}
    </>
  );

  const panelBody = (
    <>
      {panelHead}
      {reportFrame}
      {panelTail}
    </>
  );

  if (!collapsible) {
    return (
      <div
        className={`${stretch ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"} ${className ?? ""}`.trim()}
        data-slot="application-screening-inline"
      >
        {headerActionsPlacement === "section" && headerActions ? (
          <div className="flex shrink-0 flex-nowrap items-center justify-start gap-2 overflow-x-auto">{headerActions}</div>
        ) : null}
        {stretch ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <div className="flex shrink-0 flex-col gap-3">{panelHead}</div>
            {reportFrame}
            <div className="shrink-0">{panelTail}</div>
          </div>
        ) : (
          panelBody
        )}
      </div>
    );
  }

  return (
    <PortalCollapsibleSection
      title="Screening"
      defaultExpanded={false}
      surfaceMuted={false}
      bareSurface
      hideToggleIcon
      className="mt-0"
      contentClassName="pt-0"
      toggleDataAttr="application-screening-toggle"
      headerActions={headerActionsPlacement === "section" ? headerActions : undefined}
      headerActionsInline={headerActionsPlacement === "section"}
    >
      {panelBody}
    </PortalCollapsibleSection>
  );
}
