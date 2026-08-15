"use client";

import { useEffect, useState, type ReactNode } from "react";
import { SegmentedTwo } from "@/components/ui/segmented-control";
import { ApplicationDocumentPreview } from "@/components/portal/manager-applications";
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
      {showsScreening ? (
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
        >
          <ApplicationDocumentPreview
            row={row}
            collapsible={false}
            showDownload={showDownload}
            variant="pdf"
            downloadPlacement="bottom"
            bareCanvas={bareCanvas}
            stretch={false}
            flow={stretch}
            className={stretch ? "shrink-0" : undefined}
            groupMembers={group?.members.filter((member) => member.id !== row.id) ?? []}
          />
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
        />
      )}
    </div>
  );
}
