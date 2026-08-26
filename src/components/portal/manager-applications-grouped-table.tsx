"use client";

import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { DataList, type DataListRow } from "@/components/ui/data-list";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import {
  applicationPropertyMeta,
  applicationSubmittedLabel,
  type ManagerApplicationListCluster,
} from "@/lib/manager-application-list";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";

type ApplicationTableRow =
  | { kind: "application"; row: DemoApplicantRow }
  | { kind: "cosigner"; parent: DemoApplicantRow; sub: CosignerSubmission; index: number };

export function ManagerApplicationsGroupedTable({
  clusters,
  cosignerSubmissionsBySigner,
  onOpenApplication,
  onOpenCosigner,
}: {
  clusters: ManagerApplicationListCluster[];
  cosignerSubmissionsBySigner: Map<string, CosignerSubmission[]>;
  onOpenApplication: (row: DemoApplicantRow) => void;
  onOpenCosigner: (row: DemoApplicantRow, index: number) => void;
}) {
  return (
    <div className="space-y-3" data-attr="applications-resident-groups">
      {clusters.map((cluster) => {
        const tableRows: ApplicationTableRow[] = [];
        for (const row of cluster.rows) {
          tableRows.push({ kind: "application", row });
          const signerKey = row.id.trim().toUpperCase();
          const cosignerRows = cosignerSubmissionsBySigner.get(signerKey) ?? [];
          cosignerRows.forEach((sub, index) => {
            tableRows.push({ kind: "cosigner", parent: row, sub, index });
          });
        }

        return (
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
                <Badge tone="info">
                  {cluster.rows.length === 1 ? "1 application" : `${cluster.rows.length} applications`}
                </Badge>
              </>
            }
          >
            <DataList
              hideColumnHeaders
              selectable={false}
              rows={tableRows.map((entry): DataListRow<ApplicationTableRow> => {
                if (entry.kind === "application") {
                  const row = entry.row;
                  return {
                    id: row.id,
                    data: entry,
                    primary: applicationSubmittedLabel(row),
                    meta: applicationPropertyMeta(row),
                    onClick: () => onOpenApplication(row),
                  };
                }
                return {
                  id: `${entry.parent.id}-cosigner-${entry.index}`,
                  data: entry,
                  primary: "Co-signer",
                  meta: `Co-signer for ${applicantDisplayName(entry.parent)} · ${entry.sub.email || "—"}`,
                  onClick: () => onOpenCosigner(entry.parent, entry.index),
                };
              })}
              columns={[
                {
                  id: "submitted",
                  header: "Submitted",
                  cell: (entry) =>
                    entry.kind === "application" ? (
                      applicationSubmittedLabel(entry.row)
                    ) : (
                      <Badge tone="info">Co-signer</Badge>
                    ),
                },
                {
                  id: "property",
                  header: "Property",
                  cell: (entry) =>
                    entry.kind === "application"
                      ? applicationPropertyMeta(entry.row)
                      : entry.sub.email || "—",
                },
              ]}
            />
          </ApplicationHouseholdCluster>
        );
      })}
    </div>
  );
}
