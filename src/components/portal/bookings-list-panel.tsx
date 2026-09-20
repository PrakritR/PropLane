"use client";

import { useMemo, useState } from "react";
import { Tag } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { bookingRowSourceLabel, bookingRowStatusFact } from "@/components/portal/manager-bookings-list-view";
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
  return entry.source === "airbnb" || entry.source === "booking_com"
    ? bookingGuestLabel(entry.summary, entry.source)
    : entry.summary;
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
          emptyCard={{
            title: listTab === "all" ? "No bookings yet" : listTab === "check_ins" ? "No arrivals coming up" : "No departures coming up",
            section: "bookings",
          }}
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
            const status = bookingRowStatusFact(entry);
            return (
              // The overflow provides the row's ⋯ (Edit); the card draws it in
              // the selection slot, so there is one menu and no checkbox.
              <BookingsRowOverflow key={bookingEntryKey(entry)} label={name} onEdit={() => openEntry(entry)}>
                <PortalApplicantRecordRow
                  name={name}
                  address={subtitle}
                  facts={
                    <>
                      <PortalRowFact icon={Tag} srLabel="Source">
                        {bookingRowSourceLabel(entry.source)}
                      </PortalRowFact>
                      {status ? <span data-attr="booking-row-status">{status}</span> : null}
                    </>
                  }
                  onSelectedChange={() => {}}
                  omitActionView
                  onOpen={() => openEntry(entry)}
                  dataAttr={`bookings-list-row-${bookingEntryKey(entry)}`}
                />
              </BookingsRowOverflow>
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
