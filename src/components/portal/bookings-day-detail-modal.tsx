"use client";

import { Modal } from "@/components/ui/modal";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";

export type BookingsDayEntry = {
  propertyId: string;
  propertyLabel: string;
  roomId: string;
  roomLabel: string;
  summary: string;
  start: string;
  end: string;
};

function formatStayRange(start: string, end: string): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  if (start === end) return fmt(start);
  return `${fmt(start)} – ${fmt(end)}`;
}

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
          ? "No Airbnb bookings on this date."
          : `${entries.length} room${entries.length === 1 ? "" : "s"} booked`
      }
      dataAttr="bookings-day-detail-modal"
    >
      {entries.length === 0 ? (
        <p className="text-sm text-muted">Nothing booked from synced Airbnb calendars.</p>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => (
            <li
              key={`${entry.propertyId}-${entry.roomId}-${entry.start}-${entry.summary}`}
              className="rounded-lg border border-border bg-accent/20 px-4 py-3"
            >
              <p className="text-sm font-semibold text-foreground">{entry.propertyLabel}</p>
              <p className="mt-0.5 text-xs text-muted">{entry.roomLabel}</p>
              <p className="mt-2 text-sm font-medium text-foreground">
                {bookingGuestLabel(entry.summary)}
              </p>
              <p className="mt-1 text-xs text-muted">
                Stay · {formatStayRange(entry.start, entry.end)} · Airbnb
              </p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
