"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SegmentedTwo } from "@/components/ui/segmented-control";
import { ManagerApplicationReadonlyReview } from "@/components/portal/manager-application-readonly-review";
import { ApplicationScreeningPanel } from "@/components/portal/application-screening-panel";
import { ApplicationVerificationPhotos } from "@/components/portal/application-verification-photos";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import type { ApplicationGroup } from "@/lib/rental-application/application-groups";
import type { DemoApplicantRow } from "@/data/demo-portal";

export type ApplicationReviewView = "application" | "background-check";

/**
 * Inline application review on resident / application detail pages.
 * Application and background check are separate full-width views with a top toggle.
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
  group = null,
  omitReviewSections,
  hasLinkedCosigner = false,
  /** When a parent renders the Application / Background check toggle above scroll chrome. */
  hideToggle = false,
  className,
}: {
  row: DemoApplicantRow;
  bareCanvas?: boolean;
  /** Fill the parent flex area with a scrollable document frame (resident profile tab). */
  stretch?: boolean;
  showDownload?: boolean;
  onScreeningUpdated?: () => void;
  onOpenScreeningModal?: (opts?: { showPackagePicker?: boolean }) => void;
  onScreeningHeaderActionsChange?: (actions: ReactNode) => void;
  activeView?: ApplicationReviewView;
  onActiveViewChange?: (view: ApplicationReviewView) => void;
  group?: ApplicationGroup | null;
  /** Skip answer cards already rendered above the Application / Background check toggle. */
  omitReviewSections?: Array<"group" | "cosigner" | "placement">;
  /** Primary application has a linked co-signer submission — background check scopes to this applicant only. */
  hasLinkedCosigner?: boolean;
  hideToggle?: boolean;
  className?: string;
}) {
  const showsScreening = applicationShowsBackgroundCheck(row);
  const [internalView, setInternalView] = useState<ApplicationReviewView>("application");
  const activeView = activeViewProp ?? internalView;

  const setActiveView = (view: ApplicationReviewView) => {
    if (activeViewProp === undefined) setInternalView(view);
    onActiveViewChange?.(view);
  };

  useEffect(() => {
    if (activeViewProp !== undefined) return;
    setInternalView("application");
  }, [row.id, activeViewProp]);

  const showApplication = activeView === "application" || !showsScreening;

  return (
    <div
      className={`${stretch ? "flex min-h-0 flex-1 flex-col gap-3" : "space-y-3"} ${className ?? ""}`.trim()}
      data-slot="application-review-inline"
    >
      {showsScreening && !hideToggle ? (
        <SegmentedTwo
          value={activeView}
          onChange={setActiveView}
          left={{ id: "application", label: "Application" }}
          right={{ id: "background-check", label: "Background check" }}
          className="w-full shrink-0"
        />
      ) : null}

      {showApplication ? (
        <section
          className={
            stretch
              ? "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
              : "space-y-3"
          }
          data-testid="application-readonly-review"
        >
          {row.application ? (
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
      ) : (
        <ApplicationScreeningPanel
          row={row}
          collapsible={false}
          presentation="full"
          bareCanvas={bareCanvas}
          stretch={stretch}
          className={stretch ? "min-h-0 flex-1" : undefined}
          headerActionsPlacement="parent"
          onHeaderActionsChange={onScreeningHeaderActionsChange}
          onUpdated={onScreeningUpdated}
          onOpenScreeningModal={onOpenScreeningModal}
          hasLinkedCosigner={hasLinkedCosigner}
        />
      )}
    </div>
  );
}
