"use client";

import type { ReactNode } from "react";
import { DataList, type DataListRow } from "@/components/ui/data-list";
import { ApplicationHouseholdCluster } from "@/components/portal/application-household-list";
import {
  clusterPortalListRows,
  isPropertyClusterList,
  type PortalListGroupMode,
} from "@/lib/portal-list-grouping";

export const RESIDENT_PORTAL_DEFAULT_GROUP_MODE: PortalListGroupMode = "house";

export type ResidentPortalGroupableRow<T> = {
  id: string;
  propertyId?: string | null;
  propertyLabel?: string | null;
  dataListRow: DataListRow<T>;
};

export function ResidentPortalGroupedDataList<T>({
  items,
  groupMode,
  selectable = false,
  selectedIds,
  onToggleSelected,
  columns,
  emptyState,
  variant = "resident",
  dataAttr = "resident-portal-grouped-list",
}: {
  items: ResidentPortalGroupableRow<T>[];
  groupMode: PortalListGroupMode;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  columns: DataListRow<T> extends never ? never : Parameters<typeof DataList<T>>[0]["columns"];
  emptyState?: ReactNode;
  variant?: "default" | "resident";
  dataAttr?: string;
}) {
  const rows = items.map((item) => ({
    id: item.id,
    propertyId: item.propertyId,
    propertyLabel: item.propertyLabel,
    dataListRow: {
      ...item.dataListRow,
      selected: selectedIds?.has(item.id) ?? item.dataListRow.selected,
      onSelectedChange:
        selectable && onToggleSelected
          ? () => onToggleSelected(item.id)
          : item.dataListRow.onSelectedChange,
    },
  }));

  const renderDataList = (listRows: DataListRow<T>[]) => (
    <DataList
      variant={variant}
      hideColumnHeaders
      selectable={selectable && Boolean(onToggleSelected)}
      rows={listRows}
      columns={columns}
      emptyState={emptyState}
    />
  );

  if (groupMode !== "house") {
    return (
      <div data-attr={dataAttr}>
        {renderDataList(rows.map((row) => row.dataListRow))}
      </div>
    );
  }

  const clusters = clusterPortalListRows(
    rows.map((row) => ({
      ...row,
      propertyLabel: row.propertyLabel ?? "Property",
    })),
    "house",
    (row) => row.propertyLabel,
  );

  if (!isPropertyClusterList(groupMode, clusters)) {
    return (
      <div data-attr={dataAttr}>
        {renderDataList(rows.map((row) => row.dataListRow))}
      </div>
    );
  }

  return (
    <div className="space-y-3" data-attr={dataAttr}>
      {clusters.map((cluster) => {
        const listRows = cluster.rows.map((row) => row.dataListRow);
        return (
          <ApplicationHouseholdCluster
            key={cluster.key}
            header={
              <span className="truncate text-xs font-semibold text-foreground">{cluster.propertyLabel}</span>
            }
          >
            {renderDataList(listRows)}
          </ApplicationHouseholdCluster>
        );
      })}
    </div>
  );
}
