"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  bookingSourceBadgeTone,
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
  const stays = entries.filter((entry) => entry.source !== "block");
  const blocks = entries.filter((entry) => entry.source === "block");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={dayLabel}
      description={
        entries.length === 0
          ? "Nothing booked on this date."
          : [
              stays.length > 0 ? `${stays.length} booking${stays.length === 1 ? "" : "s"}` : null,
              blocks.length > 0 ? `${blocks.length} blocked` : null,
            ]
              .filter(Boolean)
              .join(" · ")
      }
      dataAttr="bookings-day-detail-modal"
      footer={
        onBlockDates ? (
          <Button type="button" variant="outline" onClick={onBlockDates} data-attr="bookings-day-block-dates">
            Block dates from here
          </Button>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-muted">
          No PropLane stays and nothing from synced Airbnb calendars.
        </p>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry, index) => (
            <li
              key={`${index}-${entry.source}-${entry.propertyId}-${entry.roomId}-${entry.start}`}
              className="rounded-xl border border-border bg-card px-4 py-3 shadow-[var(--shadow-sm)]"
              data-attr={entry.source === "block" ? "bookings-day-block" : "bookings-day-stay"}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">{entry.propertyLabel}</p>
                  <p className="mt-0.5 text-xs text-muted">{entry.roomLabel}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  <Badge tone={bookingSourceBadgeTone(entry.source)}>
                    {bookingSourceLabel(entry.source)}
                  </Badge>
                  {entry.statusLabel && entry.source !== "block" ? (
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
              {entry.source === "block" && entry.blockId && onRemoveBlock ? (
                <div className="mt-2 flex justify-end">
                  <Button
                    type="button"
                    variant="danger"
                    className="px-2 text-[13px]"
                    data-attr="bookings-day-block-remove"
                    onClick={() => onRemoveBlock(entry.blockId!)}
                  >
                    Remove block
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
