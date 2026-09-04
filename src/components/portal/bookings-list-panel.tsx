"use client";

import { useMemo, useState } from "react";
import { CalendarDays } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalSegmentedControl } from "@/components/portal/portal-metrics";
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
  bookingsForListTab,
  formatBookingStayRange,
  type BookingsListTabId,
} from "@/lib/channel-calendar/bookings-ui";
import { bookingEntriesForDayKey } from "@/lib/channel-calendar/property-bookings";
import { dateKey, startOfLocalDay } from "@/lib/room-availability-calendar";

const LIST_TABS: { id: BookingsListTabId; label: string }[] = [
  { id: "all", label: "All stays" },
  { id: "check_ins", label: "Check-ins" },
  { id: "check_outs", label: "Check-outs" },
];

function guestName(entry: PropertyBookingEntry): string {
  return entry.source === "airbnb" ? bookingGuestLabel(entry.summary) : entry.summary;
}

export function ManagerBookingsListPanel({
  entries,
  onOpenDay,
}: {
  entries: PropertyBookingEntry[];
  onOpenDay?: (dayKey: string) => void;
}) {
  const [listTab, setListTab] = useState<BookingsListTabId>("all");
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailDayKey, setDetailDayKey] = useState<string | null>(null);

  const todayKey = useMemo(() => dateKey(startOfLocalDay(new Date())), []);

  const filtered = useMemo(
    () => bookingsForListTab(entries, listTab, todayKey),
    [entries, listTab, todayKey],
  );

  const tabCounts = useMemo(
    () => ({
      all: bookingsForListTab(entries, "all", todayKey).length,
      check_ins: bookingsForListTab(entries, "check_ins", todayKey).length,
      check_outs: bookingsForListTab(entries, "check_outs", todayKey).length,
    }),
    [entries, todayKey],
  );

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
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
        <PortalSectionActionRow variant="header">
          <PortalSegmentedControl
            options={LIST_TABS.map((tab) => ({
              id: tab.id,
              label: `${tab.label} (${tabCounts[tab.id]})`,
            }))}
            value={listTab}
            onChange={setListTab}
            size="sm"
            ariaLabel="Bookings list filter"
          />
        </PortalSectionActionRow>

        <PortalRecordListSurface
          isEmpty={filtered.length === 0}
          empty={
            <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
              <CalendarDays className="h-8 w-8 text-muted" aria-hidden />
              <p className="text-sm font-medium text-foreground">No stays in this view</p>
              <p className="max-w-xs text-xs text-muted">
                {listTab === "all"
                  ? "Link Airbnb or sign a lease to see bookings here."
                  : listTab === "check_ins"
                    ? "No arrivals in the next two weeks."
                    : "No departures in the next two weeks."}
              </p>
            </div>
          }
          dataAttr="bookings-list-panel"
        >
          {filtered.map((entry) => {
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
                key={bookingEntryKey(entry)}
                name={name}
                subtitle={subtitle}
                meta={entry.statusLabel}
                onOpen={() => openEntry(entry)}
                dataAttr={`bookings-list-row-${bookingEntryKey(entry)}`}
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
          })}
        </PortalRecordListSurface>
      </div>

      <BookingsDayDetailModal
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
        dayLabel={detailLabel}
        entries={detailEntries}
      />
    </>
  );
}
