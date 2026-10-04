"use client";

import type { LucideIcon } from "lucide-react";
import { FileText } from "lucide-react";
import type { DataListRow } from "@/components/ui/data-list";
import { PortalApplicantRecordRow } from "@/components/portal/portal-record-row";

/**
 * A resident list row drawn as the shared record card (tile · title · place line · figure),
 * the same card the manager Properties list uses. Resident lists feed `DataListRow`s; this
 * is the one place those become cards, so no resident list draws a group header, a status
 * word or a bare data-table line.
 */
export function ResidentRecordCardRow<T>({
  row,
  tileIcon = FileText,
  dataAttr = "resident-record-row",
}: {
  row: DataListRow<T>;
  tileIcon?: LucideIcon;
  dataAttr?: string;
}) {
  return (
    <PortalApplicantRecordRow
      name={row.primary}
      tileIcon={tileIcon}
      address={row.meta}
      trailing={row.trailing}
      checked={row.selected ?? false}
      onSelectedChange={row.onSelectedChange}
      onOpen={row.onClick}
      dataAttr={dataAttr}
    />
  );
}
