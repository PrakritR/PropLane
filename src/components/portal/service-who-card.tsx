"use client";

import { Button } from "@/components/ui/button";
import { RecordFactCard, RecordFactRow } from "@/components/portal/portal-record-overview-kit";

export type ServiceWhoIsDoingIt = {
  /** Who has it: a teammate, you, or the hired vendor. */
  name: string;
  kind: "team" | "vendor";
  /** The visit time as one short fact; empty until one is booked. */
  visit: string;
  /** What it costs: the vendor's bill, or the service's price; empty when nobody has priced it. */
  price: string;
};

/**
 * "Who's doing it" - the one card of the Service section that says who has the service, for both models
 * (it replaces the Assignment card and the "Needs you: Assign a vendor" prompt). Nobody yet: two clear
 * choices, a teammate or the vendors. Once someone is on it: who, when, and the price. A teammate can still
 * be changed; a vendor is managed in the Vendors section.
 */
export function ServiceWhoCard({
  who,
  finished,
  onAssignTeam,
  onSendToVendors,
}: {
  who: ServiceWhoIsDoingIt | null;
  /** Completed or cancelled: nothing left to choose. */
  finished: boolean;
  onAssignTeam: () => void;
  onSendToVendors: () => void;
}) {
  return (
    <RecordFactCard title="Who's doing it" dataAttr="record-overview-card-who">
      {who ? (
        <>
          <RecordFactRow label="Who" value={who.name} />
          <RecordFactRow label="Visit" value={who.visit || "—"} />
          <RecordFactRow label="Price" value={who.price || "—"} />
          {who.kind === "team" && !finished ? (
            <div className="px-[var(--portal-card-padding,16px)] pb-3.5">
              <Button type="button" variant="outline" className="h-9 rounded-full px-4 text-[13px]" data-attr="service-who-change" onClick={onAssignTeam}>
                Change
              </Button>
            </div>
          ) : null}
        </>
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
