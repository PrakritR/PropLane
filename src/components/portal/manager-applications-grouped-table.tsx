"use client";

import { ClipboardList, Search, UserRound } from "lucide-react";
import {
  ApplicationHouseholdCluster,
  householdClusterHeaderForRows,
} from "@/components/portal/application-household-list";
import {
  ClusterNavRow,
  applicationStatusPill,
  screeningToneToBadge,
} from "@/components/portal/application-review-nav-cluster";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import {
  screeningListTrailForApplicant,
  screeningListTrailForCosigner,
} from "@/lib/application-screening-list-meta";
import { cosignerShowsBackgroundCheck } from "@/lib/cosigner-screening";
import {
  applicationPropertyMeta,
  applicationSubmittedLabel,
} from "@/lib/manager-application-list";
import type { ApplicationListCluster } from "@/lib/rental-application/application-list-grouping";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";

export function ManagerApplicationsGroupedTable({
  clusters,
  cosignerSubmissionsBySigner,
  onOpenApplication,
  onOpenCosigner,
  selectedIds,
  onToggleSelected,
  selectable = true,
}: {
  clusters: ApplicationListCluster[];
  cosignerSubmissionsBySigner: Map<string, CosignerSubmission[]>;
  onOpenApplication: (row: DemoApplicantRow) => void;
  onOpenCosigner: (row: DemoApplicantRow, index: number) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  selectable?: boolean;
}) {
  return (
    <div className="space-y-3" data-attr="applications-resident-groups">
      {clusters.map((cluster) => {
        const householdNested = cluster.kind === "household";
        const applicationRows = householdNested ? cluster.rows : [cluster.row];

        const header =
          cluster.kind === "household" ? (
            householdClusterHeaderForRows(cluster.group, cluster.rows)
          ) : (
            <>
              <span className="truncate text-xs font-semibold text-foreground">
                {applicantDisplayName(cluster.row)}
              </span>
              {cluster.row.email?.trim() &&
              cluster.row.email.trim().toLowerCase() !== applicantDisplayName(cluster.row).trim().toLowerCase() ? (
                <span className="truncate text-xs text-muted">{cluster.row.email.trim()}</span>
              ) : null}
              {cluster.row.property ? (
                <span className="truncate text-xs text-muted">
                  {stripPropertyRoomCountSuffix(cluster.row.property)}
                </span>
              ) : null}
            </>
          );

        const clusterKey = cluster.kind === "household" ? cluster.groupId : cluster.row.id;

        return (
          <ApplicationHouseholdCluster key={clusterKey} header={header}>
            {applicationRows.flatMap((row) => {
              const rows = [
                <ClusterNavRow
                  key={row.id}
                  nested={householdNested}
                  primary={
                    householdNested ? applicantDisplayName(row) : applicationSubmittedLabel(row)
                  }
                  meta={
                    householdNested
                      ? [applicationSubmittedLabel(row), applicationPropertyMeta(row)]
                          .map((part) => part?.trim())
                          .filter(Boolean)
                          .join(" · ")
                      : applicationPropertyMeta(row)
                  }
                  icon={<ClipboardList className="h-4 w-4" aria-hidden />}
                  statusPill={householdNested ? applicationStatusPill(row) : undefined}
                  checked={selectable && selectedIds?.has(row.id)}
                  onCheck={
                    selectable && onToggleSelected ? () => onToggleSelected(row.id) : undefined
                  }
                  onOpen={() => onOpenApplication(row)}
                  checkDataAttr={`application-select-${row.id}`}
                />,
              ];

              if (applicationShowsBackgroundCheck(row)) {
                const trail = screeningListTrailForApplicant(row);
                rows.push(
                  <ClusterNavRow
                    key={`${row.id}-screening`}
                    nested
                    primary="Background check"
                    meta={trail.sub}
                    icon={<Search className="h-4 w-4" aria-hidden />}
                    statusPill={{
                      label: trail.label,
                      tone: screeningToneToBadge(trail.tone),
                    }}
                    onOpen={() => onOpenApplication(row)}
                    checkDataAttr={`application-screening-${row.id}`}
                  />,
                );
              }

              const signerKey = row.id.trim().toUpperCase();
              const cosignerRows = cosignerSubmissionsBySigner.get(signerKey) ?? [];
              cosignerRows.forEach((sub, index) => {
                rows.push(
                  <ClusterNavRow
                    key={`${row.id}-cosigner-${index}`}
                    nested
                    primary={sub.fullName || "Co-signer"}
                    meta={sub.email || `Co-signer for ${applicantDisplayName(row)}`}
                    icon={<UserRound className="h-4 w-4" aria-hidden />}
                    statusPill={{ label: "Co-signer", tone: "info" }}
                    onOpen={() => onOpenCosigner(row, index)}
                    checkDataAttr={`application-cosigner-${row.id}-${index}`}
                  />,
                );
                if (cosignerShowsBackgroundCheck(sub)) {
                  const trail = screeningListTrailForCosigner(sub);
                  rows.push(
                    <ClusterNavRow
                      key={`${row.id}-cosigner-screening-${index}`}
                      nested
                      primary="Background check"
                      meta={trail.sub}
                      icon={<Search className="h-4 w-4" aria-hidden />}
                      statusPill={{
                        label: trail.label,
                        tone: screeningToneToBadge(trail.tone),
                      }}
                      onOpen={() => onOpenCosigner(row, index)}
                      checkDataAttr={`application-cosigner-screening-${row.id}-${index}`}
                    />,
                  );
                }
              });

              return rows;
            })}
          </ApplicationHouseholdCluster>
        );
      })}
    </div>
  );
}
