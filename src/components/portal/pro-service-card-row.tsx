"use client";

/**
 * The manager Services row — the Payments row (`PortalApplicantRecordRow`), not
 * a second one. One rounded card per service with a gap between cards: the
 * service glyph (or the service's first photo) in the tile, the SERVICE as the
 * title, "property · room" as the place line, glyph facts (the resident, where
 * the service stands by tab, the money state), and the price bold on the right
 * when the service has one. The tab says the bucket, so no status chip rides on
 * the row.
 *
 * Add-on requests and maintenance work orders both render here but stay two
 * models: the caller supplies each row's own figure, menu and open handler
 * (AGENTS.md → "There are no work orders in the product — only services").
 */

import type { ReactNode } from "react";
import { CalendarDays, UserRound, Wrench, type LucideIcon } from "lucide-react";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { managerServiceCardParts, managerServiceRequestCardFigure } from "@/lib/manager-service-list-row";
import type { UnifiedServiceRow } from "@/lib/unified-service-rows";
import type { ServiceRequest } from "@/lib/service-requests-storage";

type RowFact = { icon: LucideIcon; text: string };

export function ManagerServiceCardRow({
  row,
  omitProperty = false,
  figure,
  menu,
  facts,
  photoUrl,
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
  /**
   * Where the service stands by tab ("Requested Sep 25", "Assigned to Rapid Pipes", "Wed, Oct 8 · 9am",
   * "Completed Sep 27") and its money state ("Bill $152 unpaid", "Paid"), as plain glyph facts. A list
   * that passes no stage gets the requested/scheduled date instead.
   */
  facts?: { stage?: RowFact | null; money?: RowFact | null };
  /** The service's first photo, when it has one; the wrench tile otherwise. */
  photoUrl?: string;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
  rowId?: string;
}) {
  const parts = managerServiceCardParts(row, { omitProperty });
  const stage: RowFact | null =
    facts?.stage ?? (parts.dateFact ? { icon: CalendarDays, text: parts.dateFact.text } : null);
  const money = facts?.money ?? null;
  return (
    // The list draws its own ⋯ (service menu), so the shared row-actions
    // context must not add a second one beside it.
    <RecordActionContext.Provider value={null}>
      <PortalApplicantRecordRow
        name={parts.name}
        tileIcon={Wrench}
        tileImage={photoUrl}
        address={parts.placeLine || undefined}
        facts={
          parts.hasPerson || stage || money ? (
            <>
              {parts.hasPerson ? <PortalRowFact icon={UserRound}>{parts.person}</PortalRowFact> : null}
              {stage ? <PortalRowFact icon={stage.icon}>{stage.text}</PortalRowFact> : null}
              {money ? <PortalRowFact icon={money.icon}>{money.text}</PortalRowFact> : null}
            </>
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

/**
 * The resident's own service row — the same Payments card. The person is the
 * resident themself, so the tile is the service glyph and the title is the
 * service; the place line is "property · room", the fact is when it was
 * requested or scheduled, and an add-on's price is the figure. Selection and
 * the ⋯ come from the surrounding list, as on Payments.
 */
export function ResidentServiceCardRow({
  row,
  request,
  checked = false,
  onSelectedChange,
  onOpen,
  dataAttr = "resident-service-row",
}: {
  row: Pick<UnifiedServiceRow, "title" | "propertyLabel" | "unitLabel" | "scheduledIso" | "createdIso">;
  /** Present for an add-on request, which has a price; a maintenance request has none. */
  request?: Pick<ServiceRequest, "price" | "priceLimit">;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onOpen: () => void;
  dataAttr?: string;
}) {
  const parts = managerServiceCardParts({ ...row, residentName: "", residentEmail: "" });
  const figure = request
    ? managerServiceRequestCardFigure({ price: request.price?.trim() || request.priceLimit })
    : undefined;
  return (
    <PortalApplicantRecordRow
      name={parts.name}
      tileIcon={Wrench}
      address={parts.placeLine || undefined}
      facts={
        parts.dateFact ? (
          <PortalRowFact icon={CalendarDays}>{parts.dateFact.text}</PortalRowFact>
        ) : undefined
      }
      amount={figure}
      checked={checked}
      onSelectedChange={onSelectedChange}
      onOpen={onOpen}
      dataAttr={dataAttr}
    />
  );
}

/**
 * The vendor's job row — the same Payments card. The tile carries the initials
 * of the site (or the general area when the vendor cannot see the address yet),
 * the title is the service, the place line is the site, the fact is when the
 * job is scheduled, and the job amount is the figure. `extraFacts` keeps the
 * vendor's own quote/phase facts beside the date.
 */
export function VendorServiceCardRow({
  title,
  placeLine,
  dateText,
  extraFacts,
  figure,
  icon = CalendarDays,
  checked = false,
  onSelectedChange,
  onOpen,
  actions,
  dataAttr = "vendor-service-row",
}: {
  title: string;
  placeLine: string;
  dateText: string;
  extraFacts?: ReactNode;
  figure?: string;
  icon?: LucideIcon;
  checked?: boolean;
  onSelectedChange?: (selected: boolean) => void;
  onOpen: () => void;
  /** The row's one ⋯ menu, when the list carries its own actions (Find work's three choices). */
  actions?: ReactNode;
  dataAttr?: string;
}) {
  return (
    <PortalApplicantRecordRow
      name={title}
      tileLabel={placeLine || title}
      address={placeLine || undefined}
      facts={
        <>
          <PortalRowFact icon={icon}>{dateText}</PortalRowFact>
          {extraFacts}
        </>
      }
      amount={figure}
      checked={checked}
      onSelectedChange={onSelectedChange}
      onOpen={onOpen}
      actions={actions}
      dataAttr={dataAttr}
    />
  );
}
