"use client";

import {
  ApplicationHouseholdCluster,
  ApplicationNestedListRow,
  householdClusterHeaderForRows,
} from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { INCOMPLETE_APPLICATION_LABEL } from "@/lib/rental-application/draft-shape";
import { DataList } from "@/components/ui/data-list";
import {
  residentHousingMeta,
  type ManagerResidentListRow,
} from "@/lib/manager-resident-list";
import type {
  ManagerResidentHouseCluster,
  ManagerResidentListCluster,
} from "@/lib/manager-resident-list-grouping";
import type { PortalListGroupMode } from "@/lib/portal-list-grouping";

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

function residentRowMeta(
  row: ManagerResidentListRow,
  showPropertyInRows: boolean,
  groupMode: PortalListGroupMode,
): string {
  if (groupMode === "house") {
    // A nameless in-progress application falls back to the address for its
    // title, so repeating it here would print the same string twice.
    const email = row.email.trim().toLowerCase() === row.name.trim().toLowerCase() ? "" : row.email;
    return [row.roomLabel, email].filter(Boolean).join(" · ") || "—";
  }
  return residentHousingMeta(row, showPropertyInRows);
}

export function ManagerResidentsGroupedTable({
  clusters,
  groupMode,
  showPropertyInRows,
  onOpenResident,
  selectedIds,
  onToggleSelected,
  onToggleCluster,
  selectable = false,
}: {
  clusters: ManagerResidentListCluster[] | ManagerResidentHouseCluster[];
  groupMode: PortalListGroupMode;
  showPropertyInRows: boolean;
  onOpenResident: (row: ManagerResidentListRow) => void;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  onToggleCluster?: (ids: readonly string[]) => void;
  selectable?: boolean;
}) {
  const unitHeader = groupMode === "house" ? "Room" : "Unit";

  const renderResidentDataList = (listRows: ManagerResidentListRow[]) => (
    <DataList
      hideColumnHeaders
      selectable={selectable && Boolean(onToggleSelected)}
      rows={listRows.map((row) => ({
        id: row.id,
        data: row,
        primary: groupMode === "house" ? row.name : residentHousingMeta(row, showPropertyInRows),
        meta:
          groupMode === "house"
            ? residentRowMeta(row, showPropertyInRows, groupMode)
            : row.email && listRows.length === 1
              ? row.email
              : undefined,
        selected: selectedIds?.has(row.id),
        onSelectedChange:
          selectable && onToggleSelected ? () => onToggleSelected(row.id) : undefined,
        // A prospect has no lease start to print, and the useful thing in that
        // column is how far their application actually got.
        trailing: row.statusLabel?.trim() ? (
          <Badge tone={row.statusLabel.trim() === INCOMPLETE_APPLICATION_LABEL ? "warning" : "neutral"}>
            {row.statusLabel.trim()}
          </Badge>
        ) : row.leaseStart ? (
          <span className="text-sm tabular-nums text-muted">{shortDateLabel(row.leaseStart)}</span>
        ) : undefined,
        onClick: () => onOpenResident(row),
      }))}
      columns={[
        {
          id: groupMode === "house" ? "resident" : "unit",
          header: groupMode === "house" ? "Resident" : unitHeader,
          cell: (row) =>
            groupMode === "house" ? row.name : residentHousingMeta(row, showPropertyInRows),
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
  );

  const dataAttr =
    groupMode === "house" ? "residents-house-groups" : "residents-resident-groups";

  if (groupMode === "house") {
    const houseClusters = clusters as ManagerResidentHouseCluster[];
    return (
      <div className="space-y-3" data-attr={dataAttr}>
        {houseClusters.map((cluster) => (
          <ApplicationHouseholdCluster
            key={cluster.key}
            header={
              <>
                <span className="truncate text-xs font-semibold text-foreground">
                  {cluster.propertyLabel}
                </span>
                <Badge tone="info">
                  {cluster.rows.length === 1 ? "1 resident" : `${cluster.rows.length} residents`}
                </Badge>
              </>
            }
          >
            {renderResidentDataList(cluster.rows)}
          </ApplicationHouseholdCluster>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-attr={dataAttr}>
      {(clusters as ManagerResidentListCluster[]).map((cluster) => {
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
                  meta:
                    row.email && row.email !== residentCluster.residentEmail ? row.email : undefined,
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
                    header: unitHeader,
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
            header={householdClusterHeaderForRows(
              cluster.group,
              cluster.rows.map((row) => ({ property: row.propertyLabel })),
            )}
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
                      header: unitHeader,
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
