"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { DataListColumn, DataListRow } from "@/components/ui/data-list";
import { ResidentRecordCardRow } from "@/components/portal/resident-record-card-row";
import type { PortalListGroupMode } from "@/lib/portal-list-grouping";

export const RESIDENT_PORTAL_DEFAULT_GROUP_MODE: PortalListGroupMode = "house";

export type ResidentPortalGroupableRow<T> = {
  id: string;
  propertyId?: string | null;
  propertyLabel?: string | null;
  dataListRow: DataListRow<T>;
};

/**
 * Resident list data source (selection, `onClick`) drawn as a FLAT list of shared record cards:
 * each card's place line already names the house, so there is no group header (the manager
 * Properties format). `groupMode`, `variant` and `columns` are accepted for existing callers.
 */
export function ResidentPortalGroupedDataList<T>({
  items,
  selectable = false,
  selectedIds,
  onToggleSelected,
  emptyState,
  dataAttr = "resident-portal-grouped-list",
  renderRow,
  tileIcon,
}: {
  items: ResidentPortalGroupableRow<T>[];
  groupMode?: PortalListGroupMode;
  selectable?: boolean;
  selectedIds?: Set<string>;
  onToggleSelected?: (id: string) => void;
  columns?: DataListColumn<T>[];
  emptyState?: ReactNode;
  variant?: "default" | "resident";
  dataAttr?: string;
  /** Draw each row with a caller's own card instead of the default record card. */
  renderRow?: (row: DataListRow<T>) => ReactNode;
  tileIcon?: LucideIcon;
}) {
  const rows = items.map((item) => ({
    ...item.dataListRow,
    selected: selectedIds?.has(item.id) ?? item.dataListRow.selected,
    onSelectedChange:
      selectable && onToggleSelected ? () => onToggleSelected(item.id) : item.dataListRow.onSelectedChange,
  }));
  return (
    <div data-attr={dataAttr}>
      {rows.length === 0
        ? (emptyState ?? null)
        : rows.map((row) =>
            renderRow ? renderRow(row) : <ResidentRecordCardRow key={row.id} row={row} tileIcon={tileIcon} />,
          )}
    </div>
  );
}
