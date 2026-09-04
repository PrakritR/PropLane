"use client";

import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  bookingSourceLabel,
  bookingStatusTone,
  formatBookingStayRange,
} from "@/lib/channel-calendar/bookings-ui";

export type BookingsDayEntry = PropertyBookingEntry;

export function BookingsDayDetailModal({
  open,
  onClose,
  dayLabel,
  entries,
}: {
  open: boolean;
  onClose: () => void;
  dayLabel: string;
  entries: BookingsDayEntry[];
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={dayLabel}
      description={
        entries.length === 0
          ? "Nothing booked on this date."
          : `${entries.length} booking${entries.length === 1 ? "" : "s"}`
      }
      dataAttr="bookings-day-detail-modal"
    >
      {entries.length === 0 ? (
        <p className="text-sm text-muted">
          No PropLane stays and nothing from synced Airbnb calendars.
        </p>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li
              key={`${entry.source}-${entry.propertyId}-${entry.roomId}-${entry.start}-${entry.summary}`}
              className="rounded-xl border border-border bg-card px-4 py-3 shadow-[var(--shadow-sm)]"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{entry.propertyLabel}</p>
                  <p className="mt-0.5 text-xs text-muted">{entry.roomLabel}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  <Badge tone={entry.source === "airbnb" ? "pending" : "info"}>
                    {bookingSourceLabel(entry.source)}
                  </Badge>
                  {entry.statusLabel ? (
                    <Badge tone={bookingStatusTone(entry)}>{entry.statusLabel}</Badge>
                  ) : null}
                </div>
              </div>
              <p className="mt-2 text-sm font-medium text-foreground">
                {entry.source === "airbnb" ? bookingGuestLabel(entry.summary) : entry.summary}
              </p>
              <p className="mt-1 text-xs text-muted">
                {formatBookingStayRange(entry.start, entry.end, entry.openEnded)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
