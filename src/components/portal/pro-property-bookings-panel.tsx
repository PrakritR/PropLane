"use client";

import { useMemo, useState } from "react";
import { BookingsCalendarFooterBar } from "@/components/portal/bookings-calendar-footer-bar";
import { ManagerPortfolioBookingsCalendar } from "@/components/portal/pro-portfolio-bookings-calendar";
import { ChannelCalendarLinkModal } from "@/components/portal/channel-calendar-link-modal";
import {
  leaseBookingEntries,
  openEndedBookingHorizonKey,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { useLeasePipelineRows } from "@/hooks/use-lease-pipeline-rows";
import { isEntireHomeListing } from "@/lib/manager-listing-submission";
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

  const propertyEntries = useMemo<PropertyBookingEntry[]>(
    () =>
      leaseBookingEntries(leaseRows, {
        propertyId,
        propertyLabel,
        roomLabelForId: (roomId) => {
          if (!submission || isEntireHomeListing(submission)) return "Room";
          const index = submission.rooms.findIndex((room) => room.id === roomId);
          if (index < 0) return "Room";
          return submission.rooms[index]!.name?.trim() || `Room ${index + 1}`;
        },
        openEndedHorizonKey: openEndedBookingHorizonKey(),
        entireHomeListing: submission ? isEntireHomeListing(submission) : false,
      }),
    [leaseRows, propertyId, propertyLabel, submission],
  );

  const propertyOptions = useMemo(
    () => [{ id: propertyId, label: propertyLabel }],
    [propertyId, propertyLabel],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ManagerPortfolioBookingsCalendar
        propertyIds={propertyId ? [propertyId] : []}
        showToast={showToast}
        refreshSignal={refreshSignal}
        extraEntries={propertyEntries}
        emptyMessage="This house is not listed yet, so it has no bookings."
      />

      {/*
        No room filter here. This tab is already one house, and every booking it
        can show fits on the month grid at once — a filter that only ever hides
        rows the manager came here to see is a control with nothing to do. The
        portfolio-wide Bookings section keeps its filter, because that one spans
        every property.
      */}
      <BookingsCalendarFooterBar onLinkAirbnb={() => setLinkModalOpen(true)} />

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
