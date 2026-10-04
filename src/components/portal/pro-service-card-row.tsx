"use client";

/**
 * The manager Services row — the Payments row (`PortalApplicantRecordRow`), not
 * a second one. One rounded card per service with a gap between cards: the
 * requester's initials in the tile (the property glyph when nobody requested
 * it), the requester as the title, "service · property · room" as the place
 * line, one dated glyph fact, and the price bold on the right when the service
 * has one. The tab says the bucket, so no status chip rides on the row.
 *
 * Add-on requests and maintenance work orders both render here but stay two
 * models: the caller supplies each row's own figure, menu and open handler
 * (AGENTS.md → "There are no work orders in the product — only services").
 */

import type { ReactNode } from "react";
import { Building2, CalendarDays } from "lucide-react";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { managerServiceCardParts } from "@/lib/manager-service-list-row";
import type { UnifiedServiceRow } from "@/lib/unified-service-rows";

export function ManagerServiceCardRow({
  row,
  omitProperty = false,
  figure,
  menu,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr,
  rowId,
}: {
  row: Pick<
    UnifiedServiceRow,
    "title" | "residentName" | "residentEmail" | "propertyLabel" | "unitLabel" | "scheduledIso" | "createdIso"
  >;
  /** True where the surrounding page already names the property (a property's own Services tab). */
  omitProperty?: boolean;
  /** The price, when the service has one. */
  figure?: string;
  /** The row's own ⋯ menu. */
  menu?: ReactNode;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
  rowId?: string;
}) {
  const parts = managerServiceCardParts(row, { omitProperty });
  return (
    // The list draws its own ⋯ (service menu), so the shared row-actions
    // context must not add a second one beside it.
    <RecordActionContext.Provider value={null}>
      <PortalApplicantRecordRow
        name={parts.name}
        tileIcon={parts.hasPerson ? undefined : Building2}
        address={parts.placeLine || undefined}
        facts={
          parts.dateFact ? (
            <PortalRowFact icon={CalendarDays}>
              {parts.dateFact.text}
            </PortalRowFact>
          ) : undefined
        }
        amount={figure}
        actions={menu}
        selectLabel={row.title}
        checked={checked}
        onSelectedChange={onSelectedChange}
        onOpen={onOpen}
        dataAttr={dataAttr}
        rowId={rowId}
      />
    </RecordActionContext.Provider>
  );
}
