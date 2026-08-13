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
  showDownload = true,
  onScreeningUpdated,
  onOpenScreeningModal,
  onScreeningHeaderActionsChange,
  activeView: activeViewProp,
  onActiveViewChange,
  group = null,
}: {
  row: DemoApplicantRow;
  bareCanvas?: boolean;
  showDownload?: boolean;
  onScreeningUpdated?: () => void;
  onOpenScreeningModal?: (opts?: { showPackagePicker?: boolean }) => void;
  onScreeningHeaderActionsChange?: (actions: ReactNode) => void;
  activeView?: ApplicationReviewView;
  onActiveViewChange?: (view: ApplicationReviewView) => void;
  group?: ApplicationGroup | null;
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
    <div className="space-y-3" data-slot="application-review-inline">
      {showsScreening ? (
        <SegmentedTwo
          value={activeView}
          onChange={setActiveView}
          left={{ id: "application", label: "Application" }}
          right={{ id: "background-check", label: "Background check" }}
          className="w-full"
        />
      ) : null}

      {showApplication ? (
        <section className="space-y-3">
          <ApplicationDocumentPreview
            row={row}
            collapsible={false}
            showDownload={showDownload}
            variant="pdf"
            downloadPlacement="bottom"
            bareCanvas={bareCanvas}
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
          headerActionsPlacement="parent"
          onHeaderActionsChange={onScreeningHeaderActionsChange}
          onUpdated={onScreeningUpdated}
          onOpenScreeningModal={onOpenScreeningModal}
        />
      )}
    </div>
  );
}
