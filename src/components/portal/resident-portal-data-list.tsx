"use client";

import type { ReactNode } from "react";
import { DataList, type DataListColumn, type DataListRow } from "@/components/ui/data-list";

/** Resident portal lists — Payments-style card rows at every breakpoint. */
export function ResidentPortalDataList<T>({
  rows,
  columns,
  selectable = false,
  emptyState,
  className,
}: {
  rows: DataListRow<T>[];
  columns: DataListColumn<T>[];
  selectable?: boolean;
  emptyState?: ReactNode;
  className?: string;
}) {
  return (
    <DataList
      variant="resident"
      hideColumnHeaders
      rows={rows}
      columns={columns}
      selectable={selectable}
      emptyState={emptyState}
      className={className}
    />
  );
}
