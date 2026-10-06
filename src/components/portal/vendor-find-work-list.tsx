"use client";

import { useState } from "react";
import { CalendarDays, UserRound, Wallet } from "lucide-react";
import { VendorServiceCardRow } from "@/components/portal/pro-service-card-row";
import { VendorJobChoiceBar } from "@/components/portal/vendor-job-choice-bar";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import type { PublicBoardServiceView } from "@/lib/public-service-projection";
import type { VendorJobChoiceId } from "@/lib/vendor-job-choice";

type Props = {
  services: readonly PublicBoardServiceView[];
  /** The ref whose request is in flight, with the choice made. */
  busy: { ref: string; choice: VendorJobChoiceId } | null;
  onChoose: (service: PublicBoardServiceView, choice: VendorJobChoiceId) => void | Promise<unknown>;
};

/**
 * Find work rows: the shared Services row (tile, title, area · trade, glyph facts, the budget as the
 * figure) with the three options under it. Opening the row shows the description and photos the
 * manager chose to share. No pills.
 */
export function VendorFindWorkList({ services, busy, onChoose }: Props) {
  const [openRef, setOpenRef] = useState<string | null>(null);
  return (
    <>
      {services.map((service) => {
        const expanded = openRef === service.ref;
        const rowBusy = busy?.ref === service.ref;
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
            <div className="px-3 pb-3 pt-1 sm:px-4">
              <VendorJobChoiceBar
                busyChoice={rowBusy ? busy.choice : null}
                onChoose={(choice) => onChoose(service, choice)}
              />
            </div>
          </div>
        );
      })}
    </>
  );
}
