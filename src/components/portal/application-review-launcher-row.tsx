"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ManagerApplicationReadonlyReview } from "@/components/portal/pro-application-readonly-review";
import { ApplicationScreeningPanel } from "@/components/portal/application-screening-panel";
import { ApplicationVerificationPhotos } from "@/components/portal/application-verification-photos";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import type { ApplicationGroup } from "@/lib/rental-application/application-groups";
import type { DemoApplicantRow } from "@/data/demo-portal";

export type ApplicationReviewView = "application" | "background-check";

/**
 * Inline application review on resident / application detail pages.
 * Application and background check share one scroll — screening is a section card, not a tab.
 */
export function ApplicationReviewLauncherRow({
  row,
  bareCanvas = false,
  stretch = false,
  showDownload = true,
  onScreeningUpdated,
  onOpenScreeningModal,
  onScreeningHeaderActionsChange,
  activeView: activeViewProp,
  onActiveViewChange,
  group: _group = null,
  omitReviewSections,
  cosignerSubmissions = [],
  screeningSubjectId,
  onScreeningSubjectChange,
  onRequestChecksForSubjects,
  /** @deprecated Use cosignerSubmissions — kept for callers not yet migrated. */
  hasLinkedCosigner = false,
  /** @deprecated Background check is always inline; parent may render nav rows above. */
  hideToggle = false,
  householdPanels,
  className,
  content = "all",
}: {
  row: DemoApplicantRow;
  bareCanvas?: boolean;
  stretch?: boolean;
  showDownload?: boolean;
  onScreeningUpdated?: () => void;
  onOpenScreeningModal?: (opts?: { showPackagePicker?: boolean }) => void;
  onScreeningHeaderActionsChange?: (actions: ReactNode) => void;
  activeView?: ApplicationReviewView;
  onActiveViewChange?: (view: ApplicationReviewView) => void;
  group?: ApplicationGroup | null;
  omitReviewSections?: Array<"group" | "cosigner" | "placement">;
  cosignerSubmissions?: CosignerSubmission[];
  screeningSubjectId?: string;
  onScreeningSubjectChange?: (subjectId: string) => void;
  onRequestChecksForSubjects?: (subjectIds: string[]) => void;
  hasLinkedCosigner?: boolean;
  hideToggle?: boolean;
  householdPanels?: ReactNode;
  className?: string;
  /** When `application`, omit the inline background-check section (dedicated applicant sub-tab). */
  content?: "application" | "all";
}) {
  const showsScreening = applicationShowsBackgroundCheck(row);
  const [internalView, setInternalView] = useState<ApplicationReviewView>("application");
  const activeView = activeViewProp ?? internalView;

  const setActiveView = (view: ApplicationReviewView) => {
    if (activeViewProp === undefined) setInternalView(view);
    onActiveViewChange?.(view);
  };
  void setActiveView;

  useEffect(() => {
    if (activeViewProp !== undefined) return;
    setInternalView("application");
  }, [row.id, activeViewProp]);

  useEffect(() => {
    if (activeView !== "background-check") return;
    document.getElementById("application-background-check-section")?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }, [activeView, row.id]);

  void hideToggle;
  void hasLinkedCosigner;
  void showDownload;

  return (
    <div
      className={`${stretch ? "flex min-h-0 flex-1 flex-col gap-2" : "space-y-2"} ${className ?? ""}`.trim()}
      data-slot="application-review-inline"
    >
      <section
        id="application-readonly-review"
        className={
          stretch
            ? "flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
            : "space-y-2"
        }
        data-testid="application-readonly-review"
      >
        {showsScreening && content === "all" ? (
          <div id="application-background-check-section" className="scroll-mt-4">
            <ApplicationScreeningPanel
              row={row}
              collapsible={false}
              presentation="compact"
              bareCanvas={bareCanvas}
              stretch={false}
              headerActionsPlacement="parent"
              onHeaderActionsChange={onScreeningHeaderActionsChange}
              onUpdated={onScreeningUpdated}
              onOpenScreeningModal={onOpenScreeningModal}
              cosignerSubmissions={cosignerSubmissions}
              screeningSubjectId={screeningSubjectId}
              onScreeningSubjectChange={onScreeningSubjectChange}
              onRequestChecksForSubjects={onRequestChecksForSubjects}
            />
          </div>
        ) : null}

        {householdPanels ? (
          <div className="grid gap-2 xl:grid-cols-2">
            {householdPanels}
            {row.application ? (
              <ManagerApplicationReadonlyReview
                partial={row.application}
                assignedPropertyId={row.assignedPropertyId}
                assignedRoomChoice={row.assignedRoomChoice}
                omitSections={omitReviewSections}
                embedded
              />
            ) : (
              <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted">
                Application details are not available for this record.
              </p>
            )}
          </div>
        ) : row.application ? (
          <ManagerApplicationReadonlyReview
            partial={row.application}
            assignedPropertyId={row.assignedPropertyId}
            assignedRoomChoice={row.assignedRoomChoice}
            omitSections={omitReviewSections}
          />
        ) : (
          <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted">
            Application details are not available for this record.
          </p>
        )}
        <ApplicationVerificationPhotos row={row} />
      </section>
    </div>
  );
}
