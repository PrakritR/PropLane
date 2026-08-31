"use client";

import {
  ApplicationHouseholdCluster,
  ApplicationNestedListRow,
  householdClusterHeaderForRows,
} from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { DataList, type DataListRow } from "@/components/ui/data-list";
import { applicationShowsBackgroundCheck } from "@/lib/application-background-check";
import {
  screeningListTrailForApplicant,
  screeningListTrailForCosigner,
  screeningTrailToneClassName,
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

type ApplicationTableRow =
  | { kind: "application"; row: DemoApplicantRow; nested: boolean }
  | { kind: "screening"; row: DemoApplicantRow; nested: boolean }
  | { kind: "cosigner"; parent: DemoApplicantRow; sub: CosignerSubmission; index: number; nested: boolean }
  | {
      kind: "cosigner-screening";
      parent: DemoApplicantRow;
      sub: CosignerSubmission;
      index: number;
      nested: boolean;
    };

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
        const nested = cluster.kind === "household";
        const applicationRows = cluster.kind === "household" ? cluster.rows : [cluster.row];
        const tableRows: ApplicationTableRow[] = [];
        for (const row of applicationRows) {
          tableRows.push({ kind: "application", row, nested });
          if (applicationShowsBackgroundCheck(row)) {
            tableRows.push({ kind: "screening", row, nested: true });
          }
          const signerKey = row.id.trim().toUpperCase();
          const cosignerRows = cosignerSubmissionsBySigner.get(signerKey) ?? [];
          cosignerRows.forEach((sub, index) => {
            tableRows.push({ kind: "cosigner", parent: row, sub, index, nested });
            if (cosignerShowsBackgroundCheck(sub)) {
              tableRows.push({ kind: "cosigner-screening", parent: row, sub, index, nested: true });
            }
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
                      primary: entry.nested
                        ? applicantDisplayName(entry.row)
                        : applicationSubmittedLabel(entry.row),
                      meta: entry.nested
                        ? [applicationSubmittedLabel(entry.row), applicationPropertyMeta(entry.row)]
                            .map((part) => part?.trim())
                            .filter(Boolean)
                            .join(" · ")
                        : applicationPropertyMeta(entry.row),
                      selected: selectedIds?.has(entry.row.id),
                      onSelectedChange:
                        selectable && onToggleSelected
                          ? () => onToggleSelected(entry.row.id)
                          : undefined,
                      onClick: () => onOpenApplication(entry.row),
                    }
                  : entry.kind === "screening"
                    ? (() => {
                        const trail = screeningListTrailForApplicant(entry.row);
                        return {
                          id: `${entry.row.id}-screening`,
                          data: entry,
                          primary: "Background check",
                          meta: trail.sub,
                          trailing: (
                            <span
                              className={`text-xs font-semibold ${screeningTrailToneClassName(trail.tone)}`}
                            >
                              {trail.label}
                            </span>
                          ),
                          onClick: () => onOpenApplication(entry.row),
                        };
                      })()
                    : entry.kind === "cosigner-screening"
                      ? (() => {
                          const trail = screeningListTrailForCosigner(entry.sub);
                          return {
                            id: `${entry.parent.id}-cosigner-screening-${entry.index}`,
                            data: entry,
                            primary: "Background check",
                            meta: trail.sub,
                            trailing: (
                              <span
                                className={`text-xs font-semibold ${screeningTrailToneClassName(trail.tone)}`}
                              >
                                {trail.label}
                              </span>
                            ),
                            onClick: () => onOpenCosigner(entry.parent, entry.index),
                          };
                        })()
                  : {
                      id: `${entry.parent.id}-cosigner-${entry.index}`,
                      data: entry,
                      primary: entry.sub.fullName || "Co-signer",
                      meta: entry.sub.email || `Co-signer for ${applicantDisplayName(entry.parent)}`,
                      onClick: () => onOpenCosigner(entry.parent, entry.index),
                    };

              const inner = (
                <DataList
                  hideColumnHeaders
                  selectable={selectable && Boolean(onToggleSelected)}
                  rows={[rowContent]}
                  columns={[
                    // Same reasoning as `primary` above: only a household
                    // cluster needs the applicant named on the row itself.
                    ...(entry.nested
                      ? [
                          {
                            id: "applicant",
                            header: "Applicant",
                            cell: (item: ApplicationTableRow) =>
                              // A screening row carries `row`, not `parent`, so
                              // narrow on the field rather than on "not an
                              // application" - the union has four members.
                              "parent" in item
                                ? `Co-signer for ${applicantDisplayName(item.parent)}`
                                : applicantDisplayName(item.row),
                          },
                        ]
                      : []),
                    {
                      id: "submitted",
                      header: "Submitted",
                      cell: (item) =>
                        item.kind === "application" ? (
                          applicationSubmittedLabel(item.row)
                        ) : item.kind === "screening" ? (
                          screeningListTrailForApplicant(item.row).label
                        ) : item.kind === "cosigner-screening" ? (
                          screeningListTrailForCosigner(item.sub).label
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
                          : item.kind === "screening"
                            ? "—"
                            : item.kind === "cosigner-screening"
                              ? "—"
                              : item.sub.email || "—",
                    },
                  ]}
                />
              );

              return entry.nested || entry.kind === "screening" || entry.kind === "cosigner-screening" ? (
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
