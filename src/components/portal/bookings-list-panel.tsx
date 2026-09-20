"use client";

import { useMemo, useState } from "react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { PortalSectionActionRow } from "@/components/portal/portal-section-action-row";
import { PortalSegmentedControl } from "@/components/portal/portal-metrics";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  bookingEntryKey,
  bookingsForListTab,
  formatBookingStayRange,
  type BookingsListTabId,
} from "@/lib/channel-calendar/bookings-ui";
import { bookingRecordHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
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

/**
 * The calendar hub's alternate "List" layout — a row opens the booking's own
 * record page, same as the Upcoming/In-house/Past tabs (PLAN-0920-1058, area
 * 1e). This surface has no per-row edit sheet of its own; open the record (or
 * the Upcoming/In-house/Past tab) to edit a manager-made hold.
 */
export function ManagerBookingsListPanel({
  entries,
  basePath = "/portal",
  showToast,
}: {
  entries: PropertyBookingEntry[];
  basePath?: string;
  showToast?: (message: string) => void;
}) {
  const navigate = usePortalNavigate();
  const [listTab, setListTab] = useState<BookingsListTabId>("all");

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

  const copyLink = async (entry: PropertyBookingEntry) => {
    const href = bookingRecordHref(basePath, bookingEntryKey(entry));
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${href}`);
      showToast?.("Link copied.");
    } catch {
      showToast?.("Could not copy the link.");
    }
  };

  return (
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
          const key = bookingEntryKey(entry);
          const name = guestName(entry);
          const subtitle = [
            formatBookingStayRange(entry.start, entry.end, entry.openEnded),
            entry.roomLabel,
            entry.propertyLabel,
          ]
            .filter(Boolean)
            .join(" · ");
          const href = bookingRecordHref(basePath, key);
          return (
            <BookingsRowOverflow
              key={key}
              label={name}
              onMessage={() => navigate(bookingRecordHref(basePath, key, "communication"))}
              onCopyLink={() => void copyLink(entry)}
            >
              <PortalPersonRecordRow
                name={name}
                subtitle={subtitle}
                onOpen={() => navigate(href)}
                omitActionView
                dataAttr={`bookings-list-row-${key}`}
              />
            </BookingsRowOverflow>
          );
        })}
      </PortalRecordListSurface>
    </div>
  );
}
