"use client";

import { Badge } from "@/components/ui/badge";
import { PortalCollapsibleSection } from "@/components/portal/portal-collapsible-section";
import {
  ApplicationManagerPlacementCard,
} from "@/components/portal/manager-application-readonly-review";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicationHasGroup,
  summarizeGroupProgress,
  type ApplicationGroup,
  type ApplicationGroupMemberStatus,
  type GroupRowInput,
} from "@/lib/rental-application/application-groups";
import { applicationStatusForRow } from "@/lib/rental-application/application-group-row-status";
import { getBundleChoiceLabel, getPropertyById } from "@/lib/rental-application/data";
import { buildMemberSplitLines, resolveBundleFinancialTotals, moneyLabel } from "@/lib/bundle-group/bundle-cost-split";
import { normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { memberIndexInBundleGroup, type BundleApplicationGroup } from "@/lib/bundle-group/bundle-group-application";
import { isInProgressApplicationRow, INCOMPLETE_APPLICATION_LABEL } from "@/lib/rental-application/in-progress-application";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";

export { applicationStatusForRow } from "@/lib/rental-application/application-group-row-status";

type ApplicationStatusPill = {
  label: string;
  tone: "neutral" | "info" | "pending" | "confirmed" | "overdue";
};

const APPLICATION_STATUS_PILL: Record<ApplicationGroupMemberStatus, ApplicationStatusPill> = {
  approved: { label: "Approved", tone: "confirmed" },
  rejected: { label: "Rejected", tone: "overdue" },
  in_progress: { label: INCOMPLETE_APPLICATION_LABEL, tone: "neutral" },
  flagged: { label: "Flagged", tone: "overdue" },
  screened: { label: "Screened", tone: "info" },
  screening: { label: "Screening", tone: "pending" },
  submitted: { label: "New", tone: "info" },
};

export function applicationStatusPill(row: DemoApplicantRow): ApplicationStatusPill {
  if (isWithdrawnApplicationRow(row)) return { label: "Withdrawn", tone: "neutral" };
  return APPLICATION_STATUS_PILL[applicationStatusForRow(row)];
}

export function groupMemberStatusBadge(status: ApplicationGroupMemberStatus): ApplicationStatusPill {
  return APPLICATION_STATUS_PILL[status];
}

/** The Group ID a row participates in, or "" when it does not. */
export function groupIdForRow(row: DemoApplicantRow): string {
  return applicationHasGroup(row.application) ? row.application?.groupId ?? "" : "";
}

/** Reduce an application row to the fields group reconciliation needs. */
export function groupRowInputForRow(row: DemoApplicantRow): GroupRowInput & { bundleId: string; propertyId: string } {
  return {
    id: row.id,
    name: row.name || row.email || "Applicant",
    email: row.email || "",
    role: row.application?.groupRole ?? null,
    groupId: groupIdForRow(row),
    groupSize: row.application?.groupSize ?? "",
    status: applicationStatusForRow(row),
    bundleId: row.application?.bundleId?.trim() ?? "",
    propertyId: row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "",
  };
}

/**
 * Group-application roster shown inside an expanded application. Presents the household
 * as a single group covering the bundle while each member keeps an independent account.
 */
export function ApplicationGroupSection({
  group,
  bundleGroup,
  currentRowId,
  assignedPropertyId,
  assignedRoomChoice,
}: {
  group: ApplicationGroup;
  bundleGroup?: BundleApplicationGroup | null;
  currentRowId: string;
  assignedPropertyId?: string;
  assignedRoomChoice?: string;
}) {
  const progress = summarizeGroupProgress(group);
  const propertyId = bundleGroup?.propertyId ?? "";
  const bundleId = bundleGroup?.bundleId ?? "";
  const bundleLabel = propertyId && bundleId ? getBundleChoiceLabel(propertyId, bundleId) : "";
  const memberCount = group.expectedSize ?? group.totalCount;
  const memberIndex = memberIndexInBundleGroup(group, currentRowId);
  const prop = propertyId ? getPropertyById(propertyId) : undefined;
  const sub = prop?.listingSubmission?.v === 1 ? normalizeManagerListingSubmissionV1(prop.listingSubmission) : null;
  const totals = sub && bundleId ? resolveBundleFinancialTotals(sub, bundleId) : null;
  const splitLines = totals && memberCount > 1 ? buildMemberSplitLines(totals, memberCount, memberIndex) : [];

  return (
    <PortalCollapsibleSection
      title={bundleLabel ? "Bundle group application" : "Group application"}
      defaultExpanded
      collapsible={false}
      surfaceMuted={false}
      className="mt-4"
      contentClassName="p-4 pt-0"
      headerActions={<Badge tone={progress.tone}>{progress.label}</Badge>}
    >
      {bundleLabel ? (
        <p className="mb-3 text-xs text-muted">
          Lease bundle <span className="font-medium text-foreground">{bundleLabel}</span>
          {bundleGroup?.bundleMismatch ? " · members selected different bundles" : ""}
        </p>
      ) : null}
      {splitLines.length > 0 ? (
        <div className="mb-3 rounded-xl border border-border bg-accent/20 p-3">
          <p className="mb-2 text-xs font-medium text-foreground">Your equal cost share (upon approval)</p>
          <ul className="space-y-1 text-xs text-muted">
            {splitLines.map((line) => (
              <li key={line.kind}>
                {line.kind.replace(/_/g, " ")}: <span className="font-medium text-foreground">{moneyLabel(line.memberAmount)}</span>
                <span className="text-muted"> ({line.shareLabel})</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted">
            Household costs split equally across {memberCount} applicants. One joint bundle lease is created when all
            members are approved.
          </p>
        </div>
      ) : null}
      <p className="mb-3 text-xs text-muted">
        PropLane Group ID <span className="font-mono text-foreground">{group.groupId}</span>
        {group.missingCount != null && group.missingCount > 0
          ? ` · waiting on ${group.missingCount} more ${group.missingCount === 1 ? "applicant" : "applicants"} to start`
          : ""}
      </p>
      {!group.hasFirst ? (
        <p className="mb-3 text-xs text-muted">
          No organizer application using this Group ID is visible in your applications. The organizer may have applied
          to a property outside your access, or the code may not match an existing group.
        </p>
      ) : null}
      {group.isOverSubscribed ? (
        <p className="mb-3 text-xs text-[var(--status-pending-fg)]">
          {group.totalCount} applications carry this Group ID, more than the {group.expectedSize} the organizer
          declared.
        </p>
      ) : null}
      <ul className="divide-y divide-[var(--border)] rounded-2xl border border-border">
        {group.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-3 py-2.5">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[13px] font-medium text-foreground">
                {m.name}
                {m.id === currentRowId ? <span className="ml-1.5 text-[11px] text-muted">(this application)</span> : null}
                {m.role === "first" ? <span className="ml-1.5 text-[11px] text-muted">· organizer</span> : null}
              </span>
              {m.email ? <span className="truncate text-[11px] text-muted">{m.email}</span> : null}
            </span>
            <Badge tone={APPLICATION_STATUS_PILL[m.status].tone}>{APPLICATION_STATUS_PILL[m.status].label}</Badge>
          </li>
        ))}
      </ul>
      {assignedPropertyId || assignedRoomChoice ? (
        <div className="mt-3">
          <ApplicationManagerPlacementCard
            assignedPropertyId={assignedPropertyId}
            assignedRoomChoice={assignedRoomChoice}
          />
        </div>
      ) : null}
    </PortalCollapsibleSection>
  );
}
