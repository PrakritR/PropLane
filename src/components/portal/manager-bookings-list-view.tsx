"use client";

import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import {
  BookingsDayDetailModal,
  type BookingsDayEntry,
} from "@/components/portal/bookings-day-detail-modal";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  bookingEntryKey,
  bookingSourceLabel,
  bookingStatusTone,
  formatBookingStayRange,
  type ManagerBookingListBucketId,
} from "@/lib/channel-calendar/bookings-ui";
import { bookingEntriesForDayKey } from "@/lib/channel-calendar/property-bookings";

function guestName(entry: PropertyBookingEntry): string {
  return entry.source === "airbnb" ? bookingGuestLabel(entry.summary) : entry.summary;
}

export function ManagerBookingsListView({
  entries,
  loading = false,
  bucket,
  selectedKeys,
  onToggleSelected,
  onOpenDay,
  bulkActions,
}: {
  entries: PropertyBookingEntry[];
  loading?: boolean;
  bucket: ManagerBookingListBucketId;
  selectedKeys: ReadonlySet<string>;
  onToggleSelected: (key: string, selected: boolean) => void;
  onOpenDay?: (dayKey: string) => void;
  bulkActions?: ReactNode;
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

  const emptyCopy =
    bucket === "past"
      ? "No past stays in this view."
      : bucket === "inhouse"
        ? "No guests are in-house right now."
        : "Use Link Airbnb above or sign a lease to see bookings here.";

  return (
    <>
      <PortalRecordListSurface
        isEmpty={!loading && entries.length === 0}
        empty={
          <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
            <CalendarDays className="h-8 w-8 text-muted" aria-hidden />
            <p className="text-sm font-medium text-foreground">No stays in this view</p>
            <p className="max-w-xs text-xs text-muted">{emptyCopy}</p>
          </div>
        }
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
            return (
              <PortalPersonRecordRow
                key={key}
                name={name}
                subtitle={subtitle}
                checked={selectedKeys.has(key)}
                onSelectedChange={(selected) => onToggleSelected(key, selected)}
                onOpen={() => openEntry(entry)}
                dataAttr={`bookings-list-row-${key}`}
                trailing={
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
                    <Badge tone={entry.source === "airbnb" ? "pending" : "info"}>
                      {bookingSourceLabel(entry.source)}
                    </Badge>
                    {entry.statusLabel ? (
                      <Badge tone={bookingStatusTone(entry)}>{entry.statusLabel}</Badge>
                    ) : entry.source === "airbnb" ? (
                      <Badge tone="confirmed">Confirmed</Badge>
                    ) : null}
                  </div>
                }
              />
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
