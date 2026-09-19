"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";

export type BookingsDayEntry = PropertyBookingEntry;

export function BookingsDayDetailModal({
  open,
  onClose,
  dayLabel,
  entries,
  onBlockDates,
  onRemoveBlock,
}: {
  open: boolean;
  onClose: () => void;
  dayLabel: string;
  entries: BookingsDayEntry[];
  /** Present when the viewer may close dates from here. */
  onBlockDates?: () => void;
  onRemoveBlock?: (blockId: string) => Promise<void>;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={dayLabel}
      dataAttr="bookings-day-detail-modal"
      footer={
        onBlockDates ? (
          <Button type="button" variant="outline" onClick={onBlockDates} data-attr="bookings-day-block-dates">
            Add booking
          </Button>
        ) : undefined
      }
    >
      {entries.length === 0 ? null : (
        <ul className="space-y-3">
          {entries.map((entry, index) => {
            const name =
              entry.source === "airbnb" || entry.source === "booking_com"
                ? bookingGuestLabel(entry.summary, entry.source)
                : entry.summary;
            const isBlock = entry.source === "block" && Boolean(entry.blockId);
            return (
              <li
                key={`${index}-${entry.source}-${entry.propertyId}-${entry.roomId}-${entry.start}`}
                className="flex items-start gap-2 rounded-xl border border-border bg-card px-4 py-3 shadow-[var(--shadow-sm)]"
                data-attr={entry.source === "block" ? "bookings-day-block" : "bookings-day-stay"}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">{name}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {[entry.propertyLabel, entry.roomLabel].filter(Boolean).join(" · ")}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    {formatBookingStayRange(entry.start, entry.end, entry.openEnded)}
                  </p>
                </div>
                {isBlock && onRemoveBlock ? (
                  <BookingsRowOverflow
                    label={name}
                    onEdit={() => onBlockDates?.()}
                    onDelete={() => void onRemoveBlock(entry.blockId!)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
