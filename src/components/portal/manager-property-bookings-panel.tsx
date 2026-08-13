"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  PORTAL_TOOLBAR_GROUP,
  PORTAL_TOOLBAR_PILL_BUTTON,
  PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE,
} from "@/components/portal/portal-metrics";
import { ManagerPortfolioBookingsCalendar } from "@/components/portal/manager-portfolio-bookings-calendar";
import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import {
  leaseBookingEntries,
  openEndedBookingHorizonKey,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { useLeasePipelineRows } from "@/hooks/use-lease-pipeline-rows";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
import { cn } from "@/lib/utils";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

/**
 * One house's Bookings calendar.
 *
 * Same month grid as the portfolio-wide Calendar → Bookings view, scoped to
 * this property, and showing BOTH channels: PropLane's own leases and anything
 * imported from a linked Airbnb calendar. Showing only Airbnb here would report
 * a room let through PropLane as free.
 */
export function ManagerPropertyBookingsPanel({
  propertyId,
  propertyLabel,
  submission,
  managerUserId,
  showToast,
}: {
  propertyId: string;
  propertyLabel: string;
  submission: ManagerListingSubmissionV1 | null;
  managerUserId: string | null;
  showToast: (message: string) => void;
}) {
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const leaseRows = useLeasePipelineRows(managerUserId);
  const [roomFilterId, setRoomFilterId] = useState("");

  // Rent-by-room only: an entire-home listing has no room axis to filter on.
  const rooms = useMemo(() => {
    if (!submission || isEntireHomeListing(submission)) return [];
    return submission.rooms.map((room, index) => ({
      id: room.id,
      label: room.name?.trim() || `Room ${index + 1}`,
    }));
  }, [submission]);

  // Derived, not stored: a filter pinned to a room the listing no longer has
  // would hide every booking with no visible cause, and correcting it in an
  // effect would render the wrong list once first.
  const activeRoomFilterId =
    roomFilterId && rooms.some((room) => room.id === roomFilterId) ? roomFilterId : "";

  const propertyEntries = useMemo<PropertyBookingEntry[]>(
    () =>
      leaseBookingEntries(leaseRows, {
        propertyId,
        propertyLabel,
        roomLabelForId: (roomId) => rooms.find((r) => r.id === roomId)?.label ?? "Room",
        openEndedHorizonKey: openEndedBookingHorizonKey(),
        entireHomeListing: submission ? isEntireHomeListing(submission) : false,
      }),
    [leaseRows, propertyId, propertyLabel, rooms, submission],
  );

  const propertyOptions = useMemo(
    () => [{ id: propertyId, label: propertyLabel }],
    [propertyId, propertyLabel],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {rooms.length > 1 ? (
        <div className={PORTAL_TOOLBAR_GROUP} role="group" aria-label="Filter bookings by room">
          <button
            type="button"
            className={cn(PORTAL_TOOLBAR_PILL_BUTTON, !activeRoomFilterId && PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE)}
            aria-pressed={!activeRoomFilterId}
            data-attr="property-bookings-room-all"
            onClick={() => setRoomFilterId("")}
          >
            All rooms
          </button>
          {rooms.map((room) => (
            <button
              key={room.id}
              type="button"
              className={cn(
                PORTAL_TOOLBAR_PILL_BUTTON,
                activeRoomFilterId === room.id && PORTAL_TOOLBAR_PILL_BUTTON_ACTIVE,
              )}
              aria-pressed={activeRoomFilterId === room.id}
              data-attr={`property-bookings-room-${room.id}`}
              onClick={() => setRoomFilterId(room.id)}
            >
              {room.label}
            </button>
          ))}
        </div>
      ) : null}

      <ManagerPortfolioBookingsCalendar
        propertyIds={propertyId ? [propertyId] : []}
        showToast={showToast}
        refreshSignal={refreshSignal}
        extraEntries={propertyEntries}
        roomFilterId={activeRoomFilterId}
        emptyMessage="This house is not listed yet, so it has no bookings."
      />

      <div className="flex flex-wrap items-center justify-start gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-9 min-h-0 px-4 text-[13px]"
          data-attr="property-bookings-link-airbnb"
          onClick={() => setLinkModalOpen(true)}
        >
          Link Airbnb
        </Button>
      </div>

      <ChannelCalendarLinkModal
        open={linkModalOpen}
        onClose={() => setLinkModalOpen(false)}
        propertyIds={propertyId ? [propertyId] : []}
        propertyOptions={propertyOptions}
        initialPropertyId={propertyId}
        showToast={showToast}
        onChanged={() => setRefreshSignal((n) => n + 1)}
      />
    </div>
  );
}
