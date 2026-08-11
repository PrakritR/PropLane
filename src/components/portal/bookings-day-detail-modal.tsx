"use client";

import { Modal } from "@/components/ui/modal";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

/**
 * The day detail shows PropLane stays and Airbnb reservations side by side, so
 * every line has to say WHICH — otherwise a resident mid-signature is
 * indistinguishable from a confirmed Airbnb guest.
 */
export type BookingsDayEntry = PropertyBookingEntry;

function formatStayRange(start: string, end: string, openEnded?: boolean): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  // An open-ended stay's `end` is the internal horizon key, not a date the
  // manager entered — printing it reads as a real (and often earlier-looking)
  // move-out date, so show the start alone and let the "onward" suffix carry it.
  if (openEnded || start === end) return fmt(start);
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
              className="rounded-lg border border-border bg-accent/20 px-4 py-3"
            >
              <p className="text-sm font-semibold text-foreground">{entry.propertyLabel}</p>
              <p className="mt-0.5 text-xs text-muted">{entry.roomLabel}</p>
              <p className="mt-2 text-sm font-medium text-foreground">
                {entry.source === "airbnb" ? bookingGuestLabel(entry.summary) : entry.summary}
              </p>
              <p className="mt-1 text-xs text-muted">
                Stay · {formatStayRange(entry.start, entry.end, entry.openEnded)}
                {entry.openEnded ? " onward" : ""} ·{" "}
                {entry.source === "airbnb" ? "Airbnb" : "PropLane"}
                {entry.statusLabel ? ` · ${entry.statusLabel}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
