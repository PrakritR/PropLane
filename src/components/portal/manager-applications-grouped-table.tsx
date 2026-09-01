"use client";

import type { ReactNode } from "react";
import { ClipboardList, UserRound } from "lucide-react";
import {
  ApplicationHouseholdCluster,
  householdClusterHeaderForRows,
} from "@/components/portal/application-household-list";
import { ClusterNavRow, applicationStatusPill } from "@/components/portal/application-review-nav-cluster";
import {
  applicationPropertyMeta,
  applicationSubmittedLabel,
} from "@/lib/manager-application-list";
import type { ApplicationListCluster } from "@/lib/rental-application/application-list-grouping";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { cosignerListSelectionId } from "@/lib/cosigner-list-selection";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";

export function ManagerApplicationsGroupedTable({
  clusters,
  cosignerSubmissionsBySigner,
  onOpenApplication,
  onOpenCosigner,
  selectedIds,
  onToggleSelected,
  selectable = false,
  statusPillFn,
  rowIcon,
}: {
  clusters: ApplicationListCluster[];
  cosignerSubmissionsBySigner: Map<string, CosignerSubmission[]>;
  onOpenApplication: (row: DemoApplicantRow) => void;
  onOpenCosigner: (row: DemoApplicantRow, index: number) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  selectable?: boolean;
  statusPillFn?: (row: DemoApplicantRow) => { label: string; tone: "info" | "warning" | "muted" | "success" };
  rowIcon?: ReactNode;
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
                  icon={rowIcon ?? <ClipboardList className="h-4 w-4" aria-hidden />}
                  statusPill={
                    statusPillFn?.(row) ??
                    (householdNested ? applicationStatusPill(row) : undefined)
                  }
                  checked={selectable && selectedIds?.has(row.id)}
                  onCheck={
                    selectable && onToggleSelected ? () => onToggleSelected(row.id) : undefined
                  }
                  onOpen={() => onOpenApplication(row)}
                  checkDataAttr={`application-select-${row.id}`}
                />,
              ];

              const signerKey = normalizeApplicationAxisId(row.id).toUpperCase();
              const cosignerRows = cosignerSubmissionsBySigner.get(signerKey) ?? [];
              cosignerRows.forEach((sub, index) => {
                const selectionId = cosignerListSelectionId(row.id, sub, index);
                rows.push(
                  <ClusterNavRow
                    key={`${row.id}-cosigner-${index}`}
                    nested
                    primary={sub.fullName || "Co-signer"}
                    meta={sub.email || `Co-signer for ${applicantDisplayName(row)}`}
                    icon={<UserRound className="h-4 w-4" aria-hidden />}
                    statusPill={{ label: "Co-signer", tone: "info" }}
                    checked={selectable && selectedIds?.has(selectionId)}
                    onCheck={
                      selectable && onToggleSelected ? () => onToggleSelected(selectionId) : undefined
                    }
                    onOpen={() => onOpenCosigner(row, index)}
                    checkDataAttr={`application-cosigner-${row.id}-${index}`}
                  />,
                );
              });

              return rows;
            })}
          </ApplicationHouseholdCluster>
        );
      })}
    </div>
  );
}
