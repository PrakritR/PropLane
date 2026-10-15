"use client";

import { useMemo } from "react";
import { BookingsBlockDatesModal } from "@/components/portal/bookings-block-dates-modal";
import { useManagerBookingEntries } from "@/hooks/use-manager-booking-entries";
import { useSaveBookingBlock } from "@/hooks/use-save-booking-block";
import type { QuickBookPrefill } from "@/lib/channel-calendar/quick-book";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";

/**
 * Quick book from an application: the Bookings Block dates sheet, opened on Mark reserved with the
 * application's house, room, dates and applicant filled in. Mounted only while open, so the
 * Bookings reads (and their sharedGet-backed loaders) never run for an applications list that
 * never uses it. Saves through the same hook Bookings does.
 *
 * Those reads START here, so the sheet is the one place that opens on an empty calendar: until they
 * all answer, `entries` has nothing to collide with and `residentOptions` nobody to match, so
 * `readsPending` holds the save rather than letting it double-book a room or email an
 * account-setup invite to someone already on the books.
 */
export function ApplicationQuickBook({
  prefill,
  userId,
  propertyOptions,
  onClose,
}: {
  prefill: QuickBookPrefill;
  userId: string | null;
  propertyOptions: ManagerPropertyFilterOption[];
  onClose: () => void;
}) {
  const propertyIds = useMemo(() => propertyOptions.map((option) => option.id), [propertyOptions]);
  const { entries, residentOptions, channelLinks, readsPending } = useManagerBookingEntries({
    userId,
    propertyIds,
    propertyOptions,
    // The sheet holds the houses it was handed; nothing here re-reads the portfolio.
    propertyTick: 0,
  });
  const saveBlock = useSaveBookingBlock({ userId, propertyOptions });
  return (
    <BookingsBlockDatesModal
      open
      onClose={onClose}
      mode="reserve"
      propertyOptions={propertyOptions}
      channelLinks={channelLinks}
      initialPropertyId={prefill.propertyId}
      initialRoomId={prefill.roomId}
      initialDayKey={prefill.checkIn}
      initialCheckOut={prefill.checkOut}
      initialResident={prefill.resident}
      initialReason={prefill.reason}
      readsPending={readsPending}
      entries={entries}
      residentOptions={residentOptions}
      onSave={saveBlock}
    />
  );
}
