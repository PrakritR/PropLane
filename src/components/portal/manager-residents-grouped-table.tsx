"use client";

import {
  ApplicationHouseholdCluster,
  ApplicationNestedListRow,
  householdClusterHeaderForRows,
} from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { DataList } from "@/components/ui/data-list";
import {
  residentHousingMeta,
  type ManagerResidentListRow,
} from "@/lib/manager-resident-list";
import type { ManagerResidentListCluster } from "@/lib/manager-resident-list-grouping";

function shortDateLabel(iso: string): string {
  const parts = iso.trim().split("-").map(Number);
  if (parts.length < 3 || !parts[0] || !parts[1] || !parts[2]) return iso;
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });
}

function residentIdentityHeader(cluster: Extract<ManagerResidentListCluster, { kind: "resident" }>) {
  const { residentLabel, residentEmail, propertyLabel, rows } = cluster.cluster;
  return (
    <>
      <span className="truncate text-xs font-semibold text-foreground">{residentLabel}</span>
      {residentEmail && residentEmail.toLowerCase() !== residentLabel.trim().toLowerCase() ? (
        <span className="truncate text-xs text-muted">{residentEmail}</span>
      ) : null}
      {propertyLabel ? <span className="truncate text-xs text-muted">{propertyLabel}</span> : null}
      <Badge tone="info">
        {rows.length === 1 ? "1 resident" : `${rows.length} residents`}
      </Badge>
    </>
  );
}

export function ManagerResidentsGroupedTable({
  clusters,
  showPropertyInRows,
  onOpenResident,
}: {
  clusters: ManagerResidentListCluster[];
  showPropertyInRows: boolean;
  onOpenResident: (row: ManagerResidentListRow) => void;
}) {
  return (
    <div className="space-y-3" data-attr="residents-resident-groups">
      {clusters.map((cluster) => {
        if (cluster.kind === "resident") {
          const { cluster: residentCluster } = cluster;
          return (
            <ApplicationHouseholdCluster key={residentCluster.key} header={residentIdentityHeader(cluster)}>
              <DataList
                hideColumnHeaders
                selectable={false}
                rows={residentCluster.rows.map((row) => ({
                  id: row.id,
                  data: row,
                  primary: residentHousingMeta(row, showPropertyInRows),
                  meta: row.email && row.email !== residentCluster.residentEmail ? row.email : undefined,
                  trailing: row.leaseStart ? (
                    <span className="text-sm tabular-nums text-muted">{shortDateLabel(row.leaseStart)}</span>
                  ) : undefined,
                  onClick: () => onOpenResident(row),
                }))}
                columns={[
                  {
                    id: "unit",
                    header: "Unit",
                    cell: (row) => residentHousingMeta(row, showPropertyInRows),
                  },
                  {
                    id: "leaseStart",
                    header: "Lease start",
                    cell: (row) => (row.leaseStart ? shortDateLabel(row.leaseStart) : "—"),
                    headerClassName: "text-right",
                    cellClassName: "text-right tabular-nums text-muted",
                  },
                ]}
              />
            </ApplicationHouseholdCluster>
          );
        }

        return (
          <ApplicationHouseholdCluster
            key={cluster.groupId}
            header={householdClusterHeaderForRows(cluster.group, cluster.rows.map((row) => ({ property: row.propertyLabel })))}
          >
            {cluster.rows.map((row) => (
              <ApplicationNestedListRow key={row.id} nested>
                <DataList
                  hideColumnHeaders
                  selectable={false}
                  rows={[
                    {
                      id: row.id,
                      data: row,
                      primary: residentHousingMeta(row, showPropertyInRows),
                      meta: row.email || undefined,
                      trailing: row.leaseStart ? (
                        <span className="text-sm tabular-nums text-muted">{shortDateLabel(row.leaseStart)}</span>
                      ) : undefined,
                      onClick: () => onOpenResident(row),
                    },
                  ]}
                  columns={[
                    {
                      id: "unit",
                      header: "Unit",
                      cell: (item) => residentHousingMeta(item, showPropertyInRows),
                    },
                    {
                      id: "leaseStart",
                      header: "Lease start",
                      cell: (item) => (item.leaseStart ? shortDateLabel(item.leaseStart) : "—"),
                      headerClassName: "text-right",
                      cellClassName: "text-right tabular-nums text-muted",
                    },
                  ]}
                />
              </ApplicationNestedListRow>
            ))}
          </ApplicationHouseholdCluster>
        );
      })}
    </div>
  );
}
