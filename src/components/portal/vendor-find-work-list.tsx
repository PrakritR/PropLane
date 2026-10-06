"use client";

import { useState } from "react";
import { CalendarDays, UserRound, Wallet } from "lucide-react";
import { VendorServiceCardRow } from "@/components/portal/pro-service-card-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import type { PublicBoardServiceView } from "@/lib/public-service-projection";
import { VENDOR_JOB_CHOICES, type VendorJobChoiceId } from "@/lib/vendor-job-choice";

/** The ⋯ order the captain set: Bid now, Needs an estimate visit, Message the manager. */
const FIND_WORK_MENU_ORDER: readonly VendorJobChoiceId[] = ["bid", "estimate", "message"];

type Props = {
  services: readonly PublicBoardServiceView[];
  /** The ref whose request is in flight, with the choice made. */
  busy: { ref: string; choice: VendorJobChoiceId } | null;
  onChoose: (service: PublicBoardServiceView, choice: VendorJobChoiceId) => void | Promise<unknown>;
};

/**
 * Find work rows are the shared list row (tile, title, area · trade, glyph facts, ⋯) and nothing else:
 * the three choices live in the row's ⋯ menu, never as a button strip. Opening the row shows the
 * description and photos the manager chose to share (a service page exists only once the vendor has
 * made a choice, because that is what creates their offer). No pills.
 */
export function VendorFindWorkList({ services, busy, onChoose }: Props) {
  const [openRef, setOpenRef] = useState<string | null>(null);
  return (
    <>
      {services.map((service) => {
        const expanded = openRef === service.ref;
        const rowBusy = busy?.ref === service.ref;
        const items = FIND_WORK_MENU_ORDER.map((id) => {
          const choice = VENDOR_JOB_CHOICES.find((c) => c.id === id)!;
          return {
            id: choice.id,
            label: choice.label,
            disabled: rowBusy,
            dataAttr: `vendor-find-work-${choice.id}`,
            onSelect: () => void onChoose(service, choice.id),
          };
        });
        return (
          <div key={service.ref} data-attr="vendor-find-work-item">
            <VendorServiceCardRow
              title={service.title}
              placeLine={[service.area, service.trade].filter(Boolean).join(" · ")}
              dateText={service.when || "Anytime"}
              icon={CalendarDays}
              extraFacts={
                <>
                  {service.budget ? <PortalRowFact icon={Wallet}>{service.budget}</PortalRowFact> : null}
                  {service.postedBy ? <PortalRowFact icon={UserRound}>{service.postedBy}</PortalRowFact> : null}
                </>
              }
              onOpen={() => setOpenRef(expanded ? null : service.ref)}
              actions={<RowActionsMenu label={service.title} items={items} />}
              dataAttr="vendor-find-work-row"
            />
            {expanded && (service.description || service.photos.length > 0) ? (
              <div className="px-3 pb-2 sm:px-4" data-attr="vendor-find-work-detail">
                {service.description ? <p className="whitespace-pre-line text-sm text-foreground">{service.description}</p> : null}
                {service.photos.length > 0 ? (
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                    {service.photos.map((src, i) => (
                      <a key={i} href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-xl border border-border bg-accent/30">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={src} alt={`Photo ${i + 1}`} className="h-28 w-full object-cover" />
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
