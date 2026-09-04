"use client";

import { Button } from "@/components/ui/button";
import { CosignerInviteCallout } from "@/components/marketing/cosigner-invite-callout";
import { GroupShareCallout } from "@/components/marketing/rental-application-finish-panel";
import { ApplicationDocumentPreview } from "@/components/portal/pro-applications";
import { PORTAL_HEADER_ACTION_BTN, PORTAL_HEADER_PRIMARY_ACTION_BTN } from "@/components/portal/portal-metrics";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicationHasGroup } from "@/lib/rental-application/application-groups";
import type { ResidentApplicationWorkspaceState } from "@/lib/rental-application/resident-application-workspace";
import { RentalApplicationWizard } from "@/components/marketing/rental-application-wizard";

function rowStatusLabel(row: DemoApplicantRow): string {
  if (row.bucket === "approved") return "Approved";
  if (row.bucket === "rejected") return "Rejected";
  return row.stage?.trim() || "Submitted";
}

function SubmittedApplicationCard({
  row,
  onWithdraw,
}: {
  row: DemoApplicantRow;
  onWithdraw?: () => void;
}) {
  return (
    <article className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-sm)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">Application submitted</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">{row.property || "Your property"}</h2>
          <p className="mt-1 text-sm text-muted">Status: {rowStatusLabel(row)}</p>
          <p className="mt-0.5 font-mono text-[10px] text-muted">{row.id}</p>
        </div>
        {onWithdraw ? (
          <Button type="button" variant="outline" className="rounded-full" onClick={onWithdraw}>
            Withdraw
          </Button>
        ) : null}
      </div>
      {applicationHasGroup(row.application) ? (
        <GroupShareCallout
          leaderAppId={row.application?.groupRole === "first" ? row.id : undefined}
          groupRole={row.application?.groupRole}
          groupSize={row.application?.groupSize}
          propertyId={row.propertyId}
          className="mt-4"
          shareable={row.bucket !== "rejected"}
        />
      ) : null}
      {row.application?.hasCosigner === "yes" ? (
        <CosignerInviteCallout signerAppId={row.id} className="mt-4" />
      ) : null}
      {row.application ? (
        <div className="mt-4 border-t border-border pt-4">
          <ApplicationDocumentPreview row={row} collapsible={false} showDownload={false} />
        </div>
      ) : null}
    </article>
  );
}

export function ResidentApplicationWorkspace({
  workspace,
  sessionReady,
  sessionEmail,
  demoApplyPropertyId,
  showToast,
  applyMode,
  onApplyClick,
  onWithdraw,
}: {
  workspace: ResidentApplicationWorkspaceState;
  sessionReady: boolean;
  sessionEmail?: string;
  demoApplyPropertyId?: string;
  showToast: (message: string) => void;
  applyMode: boolean;
  onApplyClick: () => void;
  onWithdraw: (row: DemoApplicantRow) => void;
}) {
  if (!sessionReady) {
    return (
      <div className="flex items-center justify-center px-6 py-16 text-sm text-muted">Loading applications…</div>
    );
  }

  const showWizard = applyMode || workspace.mode === "in_progress";

  const linkedPropertyId =
    demoApplyPropertyId?.trim() ||
    workspace.inProgressRow?.propertyId?.trim() ||
    workspace.inProgressRow?.application?.propertyId?.trim() ||
    undefined;

  if (showWizard) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <RentalApplicationWizard
          showToast={showToast}
          mode="portal"
          layout="embedded"
          exitPath="/resident/applications"
          sessionEmail={sessionEmail}
          linkedPropertyId={linkedPropertyId}
        />
      </div>
    );
  }

  if (workspace.mode === "submitted") {
    return (
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {workspace.submittedRows.map((row) => (
          <SubmittedApplicationCard key={row.id} row={row} onWithdraw={() => onWithdraw(row)} />
        ))}
        {workspace.canStartAnotherApplication ? (
          <div className="flex justify-center pt-2">
            <Button
              type="button"
              variant="primary"
              className={PORTAL_HEADER_ACTION_BTN}
              data-attr="resident-applications-apply-second"
              onClick={onApplyClick}
            >
              Apply to another property
            </Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <PortalDataTableEmpty icon="application" message="No applications yet. Start your first application." />
  );
}

export function ResidentApplicationWorkspaceActions({
  workspace,
  sessionReady,
  onApplyClick,
  canOpenPropertyPicker,
}: {
  workspace: ResidentApplicationWorkspaceState;
  sessionReady: boolean;
  onApplyClick: () => void;
  canOpenPropertyPicker: boolean;
}) {
  if (!sessionReady || !canOpenPropertyPicker) return null;
  return (
    <Button
      type="button"
      variant="primary"
      className={`shrink-0 ${PORTAL_HEADER_PRIMARY_ACTION_BTN}`}
      data-attr="resident-applications-apply"
      onClick={onApplyClick}
    >
      {workspace.mode === "in_progress"
        ? "Apply to property"
        : workspace.mode === "submitted"
          ? "Apply to another property"
          : "Apply to a property"}
    </Button>
  );
}
