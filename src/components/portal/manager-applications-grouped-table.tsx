"use client";

import {
  ApplicationHouseholdCluster,
  ApplicationNestedListRow,
  householdClusterHeaderForRows,
} from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { DataList, type DataListRow } from "@/components/ui/data-list";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import {
  applicationPropertyMeta,
  applicationSubmittedLabel,
} from "@/lib/manager-application-list";
import type { ApplicationListCluster } from "@/lib/rental-application/application-list-grouping";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import { stripPropertyRoomCountSuffix } from "@/lib/portal-mobile-preview";

type ApplicationTableRow =
  | { kind: "application"; row: DemoApplicantRow; nested: boolean }
  | { kind: "cosigner"; parent: DemoApplicantRow; sub: CosignerSubmission; index: number; nested: boolean };

export function ManagerApplicationsGroupedTable({
  clusters,
  cosignerSubmissionsBySigner,
  onOpenApplication,
  onOpenCosigner,
}: {
  clusters: ApplicationListCluster[];
  cosignerSubmissionsBySigner: Map<string, CosignerSubmission[]>;
  onOpenApplication: (row: DemoApplicantRow) => void;
  onOpenCosigner: (row: DemoApplicantRow, index: number) => void;
}) {
  return (
    <div className="space-y-3" data-attr="applications-resident-groups">
      {clusters.map((cluster) => {
        const nested = cluster.kind === "household";
        const applicationRows = cluster.kind === "household" ? cluster.rows : [cluster.row];
        const tableRows: ApplicationTableRow[] = [];
        for (const row of applicationRows) {
          tableRows.push({ kind: "application", row, nested });
          const signerKey = row.id.trim().toUpperCase();
          const cosignerRows = cosignerSubmissionsBySigner.get(signerKey) ?? [];
          cosignerRows.forEach((sub, index) => {
            tableRows.push({ kind: "cosigner", parent: row, sub, index, nested });
          });
        }

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
              <Badge tone="info">1 application</Badge>
            </>
          );

        const clusterKey = cluster.kind === "household" ? cluster.groupId : cluster.row.id;

        return (
          <ApplicationHouseholdCluster key={clusterKey} header={header}>
            {tableRows.map((entry) => {
              const rowContent: DataListRow<ApplicationTableRow> =
                entry.kind === "application"
                  ? {
                      id: entry.row.id,
                      data: entry,
                      primary: applicationSubmittedLabel(entry.row),
                      meta: applicationPropertyMeta(entry.row),
                      onClick: () => onOpenApplication(entry.row),
                    }
                  : {
                      id: `${entry.parent.id}-cosigner-${entry.index}`,
                      data: entry,
                      primary: "Co-signer",
                      meta: `Co-signer for ${applicantDisplayName(entry.parent)} · ${entry.sub.email || "—"}`,
                      onClick: () => onOpenCosigner(entry.parent, entry.index),
                    };

              const inner = (
                <DataList
                  hideColumnHeaders
                  selectable={false}
                  rows={[rowContent]}
                  columns={[
                    {
                      id: "submitted",
                      header: "Submitted",
                      cell: (item) =>
                        item.kind === "application" ? (
                          applicationSubmittedLabel(item.row)
                        ) : (
                          <Badge tone="info">Co-signer</Badge>
                        ),
                    },
                    {
                      id: "property",
                      header: "Property",
                      cell: (item) =>
                        item.kind === "application"
                          ? applicationPropertyMeta(item.row)
                          : item.sub.email || "—",
                    },
                  ]}
                />
              );

              return entry.nested ? (
                <ApplicationNestedListRow key={rowContent.id} nested>
                  {inner}
                </ApplicationNestedListRow>
              ) : (
                <div key={rowContent.id}>{inner}</div>
              );
            })}
          </ApplicationHouseholdCluster>
        );
      })}
    </div>
  );
}
