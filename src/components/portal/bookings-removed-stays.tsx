"use client";

import { CalendarDays, Globe, Undo2 } from "lucide-react";
import { BookingsAirbnbIcon } from "@/components/portal/bookings-airbnb-icon";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalRowFact } from "@/components/portal/portal-record-row";
import { bookingSourceLabel, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import type { RemovedChannelStay } from "@/lib/channel-calendar/types";

/**
 * "Removed stays": every channel stay a manager removed from PropLane, each one flat row (house · room ·
 * dates · the channel's glyph and name) with a Restore icon. Hidden when nothing is removed. Restoring is
 * the server's call (`restoreRemovedChannelStay`): it re-checks the Calendar edit grant on that house.
 */
export function BookingsRemovedStays({ stays, busy, onRestore }: {
  stays: readonly RemovedChannelStay[];
  busy: boolean;
  onRestore: (stay: RemovedChannelStay) => void;
}) {
  if (stays.length === 0) return null;
  return (
    <section aria-label="Removed stays" data-attr="bookings-removed-stays" className="mt-5 overflow-hidden rounded-2xl border border-border bg-card">
      <h3 className="border-b border-border px-4 py-2.5 text-sm font-semibold max-lg:text-[16px]">Removed stays</h3>
      {stays.map((stay) => {
        const channel = bookingSourceLabel(stay.provider, stay.channelLabel);
        const place = `${stay.propertyLabel} · ${stay.roomLabel}`;
        return (
          <div key={stay.id} data-attr="bookings-removed-stay-row" className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium max-lg:text-[16px]">{place}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted md:text-xs">
                <PortalRowFact icon={CalendarDays} srLabel="Dates">{formatBookingStayRange(stay.start, stay.end)}</PortalRowFact>
                <PortalRowFact icon={stay.provider === "airbnb" ? BookingsAirbnbIcon : Globe} srLabel="Channel">{channel}</PortalRowFact>
              </p>
            </div>
            <PortalIconAction icon={Undo2} label="Restore" ariaLabel={`Restore ${place} ${formatBookingStayRange(stay.start, stay.end)}`} disabled={busy} data-attr="bookings-restore-removed-stay" onClick={() => onRestore(stay)} />
          </div>
        );
      })}
    </section>
  );
}
