"use client";

import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import {
  BookingsDayDetailModal,
  type BookingsDayEntry,
} from "@/components/portal/bookings-day-detail-modal";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  bookingEntryKey,
  formatBookingStayRange,
  type ManagerBookingListBucketId,
} from "@/lib/channel-calendar/bookings-ui";
import { bookingEntriesForDayKey } from "@/lib/channel-calendar/property-bookings";

function guestName(entry: PropertyBookingEntry): string {
  return entry.source === "airbnb" || entry.source === "booking_com"
    ? bookingGuestLabel(entry.summary, entry.source)
    : entry.summary;
}

export function ManagerBookingsListView({
  entries,
  loading = false,
  bucket,
  selectedKeys,
  onToggleSelected,
  onOpenDay,
  onEditBlock,
  onDeleteBlock,
  bulkActions,
  emptyCard,
}: {
  entries: PropertyBookingEntry[];
  loading?: boolean;
  bucket: ManagerBookingListBucketId;
  selectedKeys: ReadonlySet<string>;
  onToggleSelected: (key: string, selected: boolean) => void;
  onOpenDay?: (dayKey: string) => void;
  onEditBlock?: (entry: PropertyBookingEntry) => void;
  onDeleteBlock?: (entry: PropertyBookingEntry) => void;
  bulkActions?: ReactNode;
  /** The tab's empty card — the page owns the copy, tab counts and Link Airbnb. */
  emptyCard?: ComponentProps<typeof PortalRecordListSurface>["emptyCard"];
}) {
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailDayKey, setDetailDayKey] = useState<string | null>(null);

  const openEntry = (entry: PropertyBookingEntry) => {
    const key = entry.start;
    if (onOpenDay) {
      onOpenDay(key);
      return;
    }
    setDetailDayKey(key);
    setDetailOpen(true);
  };

  const detailEntries = useMemo<BookingsDayEntry[]>(
    () => (detailDayKey ? bookingEntriesForDayKey(entries, detailDayKey) : []),
    [detailDayKey, entries],
  );

  const detailLabel = useMemo(() => {
    if (!detailDayKey) return "";
    const [y, m, d] = detailDayKey.split("-").map(Number);
    if (!y || !m || !d) return detailDayKey;
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
  }, [detailDayKey]);

  return (
    <>
      <PortalRecordListSurface
        isEmpty={!loading && entries.length === 0}
        emptyCard={emptyCard ?? { title: portalEmptyCopy(`bookings.${bucket}`).title, section: "bookings" }}
        onBulkClear={() => { for (const key of selectedKeys) onToggleSelected(key, false); }}
        bulkCount={selectedKeys.size}
        bulkActions={bulkActions}
        dataAttr="bookings-list-panel"
      >
        {loading ? (
          <div className="space-y-0">
            {Array.from({ length: 3 }, (_, index) => (
              <div
                key={index}
                className="flex items-center gap-3 border-b border-border/50 px-3 py-4"
                aria-hidden
              >
                <div className="h-4 w-4 shrink-0 rounded bg-muted/40" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3.5 w-32 rounded bg-muted/50" />
                  <div className="h-3 w-48 max-w-full rounded bg-muted/30" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          entries.map((entry) => {
            const key = bookingEntryKey(entry);
            const name = guestName(entry);
            const subtitle = [
              formatBookingStayRange(entry.start, entry.end, entry.openEnded),
              entry.roomLabel,
              entry.propertyLabel,
            ]
              .filter(Boolean)
              .join(" · ");
            const isBlock = entry.source === "block" && Boolean(entry.blockId);
            return (
              <BookingsRowOverflow
                key={key}
                label={name}
                onEdit={() => (isBlock && onEditBlock ? onEditBlock(entry) : openEntry(entry))}
                onDelete={isBlock && onDeleteBlock ? () => onDeleteBlock(entry) : undefined}
              >
                <PortalPersonRecordRow
                  name={name}
                  subtitle={subtitle}
                  checked={selectedKeys.has(key)}
                  onSelectedChange={(selected) => onToggleSelected(key, selected)}
                  onOpen={() => openEntry(entry)}
                  omitActionView
                  dataAttr={`bookings-list-row-${key}`}
                />
              </BookingsRowOverflow>
            );
          })
        )}
      </PortalRecordListSurface>

      <BookingsDayDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        dayLabel={detailLabel}
        entries={detailEntries}
      />
    </>
  );
}
