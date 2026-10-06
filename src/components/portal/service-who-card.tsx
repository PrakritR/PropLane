"use client";

import { CalendarDays, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";
import { PortalListGroupRowContext } from "@/components/portal/portal-list-group";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";

export type ServiceWhoIsDoingIt = {
  /** Who has it: a teammate, you, or the hired vendor. */
  name: string;
  kind: "team" | "vendor";
  /** The vendor's trade; empty for a teammate. */
  trade?: string;
  /** The visit time as one short fact; empty until one is booked. */
  visit: string;
  /** What it costs: the vendor's bill, or the service's price; empty when nobody has priced it. */
  price: string;
  /** The price is an approved bid's: it reads "$140 approved". */
  approved?: boolean;
};

/**
 * "Who's doing it" - the one card of the Service page that says who has the service, for both models.
 * Nobody yet: two clear choices, a teammate or the vendors. Once someone is on it: ONE row like every
 * Vendors row (tile, name, trade, visit, the approved price), with Reschedule beside its ⋯. A teammate
 * is changed from the ⋯; a vendor is managed in the Vendors section.
 */
export function ServiceWhoCard({
  who,
  finished,
  onAssignTeam,
  onSendToVendors,
  onReschedule,
  onOpenVendor,
  onMessage,
}: {
  who: ServiceWhoIsDoingIt | null;
  /** Completed or cancelled: nothing left to choose. */
  finished: boolean;
  onAssignTeam: () => void;
  onSendToVendors: () => void;
  /** Move the visit; drawn only while a visit is booked and the service is not finished. */
  onReschedule?: () => void;
  /** Open the hired vendor's record. */
  onOpenVendor?: () => void;
  onMessage?: () => void;
}) {
  return (
    <RecordFactCard title="Who's doing it" dataAttr="record-overview-card-who">
      {who ? (
        <PortalListGroupRowContext.Provider value>
          <PortalApplicantRecordRow
            name={who.name}
            address={who.kind === "vendor" ? who.trade || undefined : "Your team"}
            facts={
              <>
                <PortalRowFact icon={CalendarDays} srLabel="Visit">{who.visit || "No visit time yet"}</PortalRowFact>
                {who.price ? <PortalRowFact icon={Receipt} srLabel="Price">{who.approved ? `${who.price} approved` : who.price}</PortalRowFact> : null}
              </>
            }
            dataAttr="service-who-row"
            actions={
              <div className="flex items-center gap-1">
                {who.visit && !finished && onReschedule ? (
                  <Button type="button" variant="outline" className="h-8 rounded-full px-3.5 text-[13px]" data-attr="service-who-reschedule" onClick={onReschedule}>
                    Reschedule
                  </Button>
                ) : null}
                <RowActionsMenu
                  label={who.name}
                  items={[
                    who.kind === "team" && !finished ? { id: "change", label: "Change", onSelect: onAssignTeam, dataAttr: "service-who-change" } : null,
                    who.kind === "vendor" && onOpenVendor ? { id: "open-vendor", label: "Open vendor", onSelect: onOpenVendor, dataAttr: "service-who-open-vendor" } : null,
                    onMessage ? { id: "message", label: "Message", onSelect: onMessage, dataAttr: "service-who-message" } : null,
                  ]}
                />
              </div>
            }
          />
        </PortalListGroupRowContext.Provider>
      ) : finished ? (
        <RecordFactRow label="Who" value="—" />
      ) : (
        <div className="flex flex-col gap-2 px-[var(--portal-card-padding,16px)] py-3.5" data-attr="service-who-choices">
          <Button type="button" variant="outline" className="h-10 justify-center rounded-full px-5 text-[14px]" data-attr="service-who-team" onClick={onAssignTeam}>
            Assign someone on your team
          </Button>
          <Button type="button" variant="outline" className="h-10 justify-center rounded-full px-5 text-[14px]" data-attr="service-who-vendors" onClick={onSendToVendors}>
            Send to vendors
          </Button>
        </div>
      )}
    </RecordFactCard>
  );
}
