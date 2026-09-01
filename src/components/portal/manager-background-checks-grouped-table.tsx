"use client";

import type { ReactNode } from "react";
import { Search, UserRound } from "lucide-react";
import {
  ApplicationHouseholdCluster,
} from "@/components/portal/application-household-list";
import { ClusterNavRow } from "@/components/portal/application-review-nav-cluster";
import { Badge } from "@/components/ui/badge";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { cosignerListSelectionId } from "@/lib/cosigner-list-selection";
import { applicationSubmittedLabel, applicationPropertyMeta } from "@/lib/manager-application-list";
import { backgroundCheckStatusPill } from "@/lib/application-background-check";
import {
  clusterPortalListRows,
  isPropertyClusterList,
  type PortalListGroupMode,
  type PropertyCluster,
  type ResidentCluster,
} from "@/lib/portal-list-grouping";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";

export function ManagerBackgroundChecksGroupedTable({
  rows,
  groupMode,
  cosignerSubmissionsBySigner,
  onOpenApplication,
  onOpenCosigner,
  selectedIds,
  onToggleSelected,
  selectable = false,
}: {
  rows: DemoApplicantRow[];
  groupMode: PortalListGroupMode;
  cosignerSubmissionsBySigner: Map<string, CosignerSubmission[]>;
  onOpenApplication: (row: DemoApplicantRow) => void;
  onOpenCosigner: (row: DemoApplicantRow, index: number) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  selectable?: boolean;
}) {
  const clusterInput = rows.map((row) => ({
    ...row,
    residentName: applicantDisplayName(row),
    residentEmail: row.email?.trim() || row.application?.email?.trim() || "",
    propertyLabel: stripPropertyRoomCountSuffix(row.property || ""),
  }));

  const clusters = clusterPortalListRows(
    clusterInput,
    groupMode,
    (row) => stripPropertyRoomCountSuffix(row.property || ""),
  );

  const renderApplicationRows = (applicationRows: DemoApplicantRow[]) =>
    applicationRows.flatMap((row) => {
      const rowNodes: ReactNode[] = [
        <ClusterNavRow
          key={row.id}
          primary={applicationSubmittedLabel(row)}
          meta={applicationPropertyMeta(row)}
          icon={<Search className="h-4 w-4" aria-hidden />}
          statusPill={backgroundCheckStatusPill(row)}
          checked={selectable && selectedIds?.has(row.id)}
          onCheck={selectable && onToggleSelected ? () => onToggleSelected(row.id) : undefined}
          onOpen={() => onOpenApplication(row)}
          checkDataAttr={`background-check-select-${row.id}`}
        />,
      ];

      const signerKey = normalizeApplicationAxisId(row.id).toUpperCase();
      const cosignerRows = cosignerSubmissionsBySigner.get(signerKey) ?? [];
      cosignerRows.forEach((sub, index) => {
        const selectionId = cosignerListSelectionId(row.id, sub, index);
        rowNodes.push(
          <ClusterNavRow
            key={`${row.id}-cosigner-${index}`}
            primary={sub.fullName || "Co-signer"}
            meta={sub.email || `Co-signer for ${applicantDisplayName(row)}`}
            icon={<UserRound className="h-4 w-4" aria-hidden />}
            statusPill={{ label: "Co-signer", tone: "info" }}
            checked={selectable && selectedIds?.has(selectionId)}
            onCheck={selectable && onToggleSelected ? () => onToggleSelected(selectionId) : undefined}
            onOpen={() => onOpenCosigner(row, index)}
            checkDataAttr={`background-check-cosigner-${row.id}-${index}`}
          />,
        );
      });

      return rowNodes;
    });

  const dataAttr =
    groupMode === "house" ? "background-checks-house-groups" : "background-checks-resident-groups";

  if (isPropertyClusterList(groupMode, clusters)) {
    return (
      <div className="space-y-3" data-attr={dataAttr}>
        {(clusters as PropertyCluster<DemoApplicantRow>[]).map((cluster) => (
            <ApplicationHouseholdCluster
              key={cluster.key}
              header={
                <>
                  <span className="truncate text-xs font-semibold text-foreground">
                    {cluster.propertyLabel}
                  </span>
                  <Badge tone="info">
                    {cluster.rows.length === 1 ? "1 check" : `${cluster.rows.length} checks`}
                  </Badge>
                </>
              }
            >
              {renderApplicationRows(cluster.rows)}
            </ApplicationHouseholdCluster>
          ))}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-attr={dataAttr}>
      {(clusters as ResidentCluster<DemoApplicantRow>[]).map((cluster) => (
          <ApplicationHouseholdCluster
            key={cluster.key}
            header={
              <>
                <span className="truncate text-xs font-semibold text-foreground">
                  {cluster.residentLabel}
                </span>
                {cluster.residentEmail &&
                cluster.residentEmail.toLowerCase() !== cluster.residentLabel.trim().toLowerCase() ? (
                  <span className="truncate text-xs text-muted">{cluster.residentEmail}</span>
                ) : null}
                {cluster.propertyLabel ? (
                  <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
                ) : null}
              </>
            }
          >
            {renderApplicationRows(cluster.rows)}
          </ApplicationHouseholdCluster>
        ))}
    </div>
  );
}
