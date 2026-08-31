"use client";

import {
  ApplicationHouseholdCluster,
  ApplicationNestedListRow,
  householdClusterHeaderForRows,
} from "@/components/portal/application-household-list";
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
  const { residentLabel, residentEmail, propertyLabel } = cluster.cluster;
  return (
    <>
      <span className="truncate text-xs font-semibold text-foreground">{residentLabel}</span>
      {residentEmail && residentEmail.toLowerCase() !== residentLabel.trim().toLowerCase() ? (
        <span className="truncate text-xs text-muted">{residentEmail}</span>
      ) : null}
      {propertyLabel ? <span className="truncate text-xs text-muted">{propertyLabel}</span> : null}
    </>
  );
}

export function ManagerResidentsGroupedTable({
  clusters,
  showPropertyInRows,
  onOpenResident,
  selectedIds,
  onToggleSelected,
  selectable = true,
}: {
  clusters: ManagerResidentListCluster[];
  showPropertyInRows: boolean;
  onOpenResident: (row: ManagerResidentListRow) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  selectable?: boolean;
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
                selectable={selectable && Boolean(onToggleSelected)}
                rows={residentCluster.rows.map((row) => ({
                  id: row.id,
                  data: row,
                  primary: residentHousingMeta(row, showPropertyInRows),
                  meta: row.email && row.email !== residentCluster.residentEmail ? row.email : undefined,
                  selected: selectedIds?.has(row.id),
                  onSelectedChange:
                    selectable && onToggleSelected ? () => onToggleSelected(row.id) : undefined,
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
                  selectable={selectable && Boolean(onToggleSelected)}
                  rows={[
                    {
                      id: row.id,
                      data: row,
                      // A household cluster's header is the house, not a person,
                      // so the resident has to be named on their own row — the
                      // per-resident branch above gets this from its header.
                      primary: row.name,
                      meta: [residentHousingMeta(row, showPropertyInRows), row.email]
                        .map((part) => part?.trim())
                        .filter(Boolean)
                        .join(" · ") || undefined,
                      selected: selectedIds?.has(row.id),
                      onSelectedChange:
                        selectable && onToggleSelected ? () => onToggleSelected(row.id) : undefined,
                      trailing: row.leaseStart ? (
                        <span className="text-sm tabular-nums text-muted">{shortDateLabel(row.leaseStart)}</span>
                      ) : undefined,
                      onClick: () => onOpenResident(row),
                    },
                  ]}
                  columns={[
                    {
                      id: "resident",
                      header: "Resident",
                      cell: (item) => item.name,
                    },
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
