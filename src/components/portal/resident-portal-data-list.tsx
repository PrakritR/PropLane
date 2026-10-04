"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { DataListColumn, DataListRow } from "@/components/ui/data-list";
import { ResidentRecordCardRow } from "@/components/portal/resident-record-card-row";

/**
 * Resident portal lists: one shared record card per row at every breakpoint (the manager
 * Properties format). `columns` is kept so existing callers compile; the card ignores it.
 */
export function ResidentPortalDataList<T>({
  rows,
  emptyState,
  className,
  tileIcon,
  dataAttr,
}: {
  rows: DataListRow<T>[];
  columns?: DataListColumn<T>[];
  selectable?: boolean;
  emptyState?: ReactNode;
  className?: string;
  tileIcon?: LucideIcon;
  dataAttr?: string;
}) {
  if (rows.length === 0) return <>{emptyState ?? null}</>;
  return (
    <div className={className}>
      {rows.map((row) => (
        <ResidentRecordCardRow key={row.id} row={row} tileIcon={tileIcon} dataAttr={dataAttr} />
      ))}
    </div>
  );
}
