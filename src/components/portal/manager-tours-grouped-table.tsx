"use client";

import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import { Badge } from "@/components/ui/badge";
import { DataList } from "@/components/ui/data-list";
import {
  type ManagerTourListCluster,
  type ManagerTourPropertyCluster,
  type ManagerTourRow,
} from "@/lib/manager-tour-list";
import { isPropertyClusterList, type PortalListGroupMode } from "@/lib/portal-list-grouping";

function tourLocationMeta(row: ManagerTourRow, showPropertyColumn: boolean, groupMode: PortalListGroupMode): string {
  if (groupMode === "house") {
    return [row.guestName, row.roomLabel].filter(Boolean).join(" · ") || "—";
  }
  if (!showPropertyColumn) {
    return row.roomLabel?.trim() || "—";
  }
  return [row.propertyTitle, row.roomLabel].filter(Boolean).join(" · ");
}

export function ManagerToursGroupedTable({
  clusters,
  groupMode,
  selectedIds,
  onToggleSelected,
  onRowClick,
  showPropertyColumn = true,
  selectable = true,
}: {
  clusters: ManagerTourListCluster[] | ManagerTourPropertyCluster[];
  groupMode: PortalListGroupMode;
  selectedIds: Set<string>;
  onToggleSelected: (id: string) => void;
  onRowClick: (row: ManagerTourRow) => void;
  /** Hide the property column when the list is scoped to one listing. */
  showPropertyColumn?: boolean;
  selectable?: boolean;
}) {
  const locationHeader =
    groupMode === "house" ? "Guest" : showPropertyColumn ? "Property" : "Room";

  const renderTourDataList = (listRows: ManagerTourRow[]) => (
    <DataList
      hideColumnHeaders
      selectable={selectable}
      rows={listRows.map((row) => ({
        id: row.id,
        data: row,
        primary: row.whenLabel,
        meta: tourLocationMeta(row, showPropertyColumn, groupMode),
        selected: selectedIds.has(row.id),
        onSelectedChange: () => onToggleSelected(row.id),
        onClick: () => onRowClick(row),
      }))}
      columns={[
        { id: "when", header: "When", cell: (row) => row.whenLabel },
        {
          id: "location",
          header: locationHeader,
          cell: (row) => tourLocationMeta(row, showPropertyColumn, groupMode),
        },
      ]}
    />
  );

  const dataAttr = groupMode === "house" ? "tours-house-groups" : "tours-resident-groups";

  if (isPropertyClusterList(groupMode, clusters)) {
    return (
      <div className="space-y-3" data-attr={dataAttr}>
        {clusters.map((cluster) => (
          <ApplicationHouseholdCluster
            key={cluster.key}
            header={
              <>
                <span className="truncate text-xs font-semibold text-foreground">
                  {cluster.propertyLabel}
                </span>
                <Badge tone="info">
                  {cluster.rows.length === 1 ? "1 tour" : `${cluster.rows.length} tours`}
                </Badge>
              </>
            }
          >
            {renderTourDataList(cluster.rows)}
          </ApplicationHouseholdCluster>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-attr={dataAttr}>
      {(clusters as ManagerTourListCluster[]).map((cluster) => (
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
              {showPropertyColumn && cluster.propertyLabel ? (
                <span className="truncate text-xs text-muted">{cluster.propertyLabel}</span>
              ) : null}
              <Badge tone="info">
                {cluster.rows.length === 1 ? "1 tour" : `${cluster.rows.length} tours`}
              </Badge>
            </>
          }
        >
          {renderTourDataList(cluster.rows)}
        </ApplicationHouseholdCluster>
      ))}
    </div>
  );
}
