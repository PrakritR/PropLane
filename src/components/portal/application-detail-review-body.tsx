"use client";

import type { ReactNode } from "react";
import { ApplicationHouseholdInlinePanels } from "@/components/portal/application-household-inline-panels";
import { groupIdForRow } from "@/components/portal/application-group-section";
import { ApplicationReviewLauncherRow } from "@/components/portal/application-review-launcher-row";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import type { ApplicationGroup } from "@/lib/rental-application/application-groups";

export type ApplicationHouseholdNav = {
  onOpenCosigner?: (index: number) => void;
  onOpenApplication?: (applicationId: string) => void;
};

/**
 * Standard application detail body — household summary plus readonly review.
 * Background check is omitted here; dedicated Background check tabs/pages own screening.
 */
export function ApplicationDetailReviewBody({
  row,
  group = null,
  cosignerSubmissions = [],
  householdNav,
  bareCanvas = false,
  stretch = false,
  showDownload = false,
  className,
  onScreeningUpdated,
  onOpenScreeningModal,
  onScreeningHeaderActionsChange,
  screeningSubjectId,
  onScreeningSubjectChange,
  onRequestChecksForSubjects,
}: {
  row: DemoApplicantRow;
  group?: ApplicationGroup | null;
  cosignerSubmissions?: CosignerSubmission[];
  householdNav?: ApplicationHouseholdNav;
  bareCanvas?: boolean;
  stretch?: boolean;
  showDownload?: boolean;
  className?: string;
  onScreeningUpdated?: () => void;
  onOpenScreeningModal?: (opts?: { showPackagePicker?: boolean }) => void;
  onScreeningHeaderActionsChange?: (actions: ReactNode) => void;
  screeningSubjectId?: string;
  onScreeningSubjectChange?: (subjectId: string) => void;
  onRequestChecksForSubjects?: (subjectIds: string[]) => void;
}) {
  return (
    <ApplicationReviewLauncherRow
      row={row}
      group={group}
      bareCanvas={bareCanvas}
      stretch={stretch}
      hideToggle
      showDownload={showDownload}
      content="application"
      onScreeningUpdated={onScreeningUpdated}
      onOpenScreeningModal={onOpenScreeningModal}
      onScreeningHeaderActionsChange={onScreeningHeaderActionsChange}
      cosignerSubmissions={cosignerSubmissions}
      screeningSubjectId={screeningSubjectId}
      onScreeningSubjectChange={onScreeningSubjectChange}
      onRequestChecksForSubjects={onRequestChecksForSubjects}
      householdPanels={
        <ApplicationHouseholdInlinePanels
          cosignerSubmissions={cosignerSubmissions}
          hasCosigner={row.application?.hasCosigner}
          applyingAsGroup={row.application?.applyingAsGroup}
          groupId={groupIdForRow(row)}
          onOpenCosigner={householdNav?.onOpenCosigner}
          group={group}
          currentRowId={row.id}
          onOpenApplication={householdNav?.onOpenApplication}
        />
      }
      omitReviewSections={["cosigner", "group"]}
      className={className}
    />
  );
}
