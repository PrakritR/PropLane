"use client";

import type { ComponentProps, ReactNode } from "react";
import { CalendarDays, CircleCheck, Globe } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { BookingsAirbnbIcon } from "@/components/portal/bookings-airbnb-icon";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  addDaysToDateKey,
  bookingEntryKey,
  bookingSourceLabel,
  bookingPlaceLine,
  formatBookingStayRangeShort,
  type ManagerBookingListBucketId,
} from "@/lib/channel-calendar/bookings-ui";
import { bookingRecordHref } from "@/lib/portal-detail-routes";
import { bookingRateLabel, bookingStatusLabel, canCancelBooking, canRemoveChannelStay } from "@/lib/channel-calendar/booking-presentation";
import { usePortalNavigate } from "@/lib/portal-nav-client";

function guestName(entry: PropertyBookingEntry): string {
  return entry.source === "airbnb" || entry.source === "booking_com"
    ? bookingGuestLabel(entry.summary, entry.source)
    : entry.summary;
}

/**
 * Where a stay came from, as the row's tag fact — "Airbnb", "Booking.com",
 * "PropLane", "Hold", "Block". A closed range is a block, not a "Blocked"
 * state, so the fact names the thing rather than restating the row.
 */
export function bookingRowSourceLabel(source: PropertyBookingEntry["source"]): string {
  return source === "block" ? "Block" : bookingSourceLabel(source);
}

/**
 * The stage a stay is at, as plain fact text — only when it adds to the row.
 * Confirmed is the default and says nothing; a block's "Blocked" / "Held" is
 * already its source fact. No pill on a row (`tests/unit/portal-list-rows-no-pills.test.ts`).
 */
export function bookingRowStatusFact(entry: PropertyBookingEntry): string {
  return bookingStatusLabel(entry);
}

/**
 * The Upcoming / In-house / Past list — a row is a booking RECORD now
 * (PLAN-0920-1058, area 1e): the whole row opens `/bookings/<id>/overview`.
 * `onEditBlock` / `onDeleteBlock` still drive the one combined Add/Edit
 * sheet for a manager-made hold, the only kind this screen can edit
 * directly; other sources get Message + Copy link only.
 */
export function ManagerBookingsListView({
  entries,
  loading = false,
  showStayDetails = false,
  bucket,
  selectedKeys,
  onToggleSelected,
  onEditBlock,
  onDeleteBlock,
  onRemoveStay,
  bulkActions,
  emptyCard,
  basePath = "/portal",
}: {
  entries: PropertyBookingEntry[];
  loading?: boolean;
  showStayDetails?: boolean;
  bucket: ManagerBookingListBucketId;
  selectedKeys: ReadonlySet<string>;
  onToggleSelected: (key: string, selected: boolean) => void;
  onEditBlock?: (entry: PropertyBookingEntry) => void;
  onDeleteBlock?: (entry: PropertyBookingEntry) => void;
  /** Remove stay on a channel-feed reservation (C2-AB7): tombstoned, so the next sync does not bring it back. */
  onRemoveStay?: (entry: PropertyBookingEntry) => void;
  bulkActions?: ReactNode;
  /** The tab's empty card — the page owns the copy, tab counts and Link Airbnb. */
  emptyCard?: ComponentProps<typeof PortalRecordListSurface>["emptyCard"];
  basePath?: string;
  showToast?: (message: string) => void;
}) {
  const navigate = usePortalNavigate();


  return (
    <PortalRecordListSurface
      isEmpty={!loading && entries.length === 0}
      emptyCard={emptyCard ?? { title: portalEmptyCopy(`bookings.${bucket}`).title, section: "bookings" }}
      onBulkClear={() => { for (const key of selectedKeys) onToggleSelected(key, false); }}
      bulkCount={selectedKeys.size}
      bulkActions={bulkActions}
      dataAttr="bookings-list-panel"
    >
      {loading ? (
        // Same shimmering skeleton every other list uses (AXI night sweep
        // area 2b) — this row used to be its own static grey blocks with no
        // shimmer, reading as broken rather than "still loading."
        <ListSkeleton rows={3} />
      ) : (
        entries.map((entry) => {
          const key = bookingEntryKey(entry);
          const name = guestName(entry);
          const subtitle = bookingPlaceLine(entry.propertyLabel, entry.roomLabel);
          const href = bookingRecordHref(basePath, key);
          const status = bookingRowStatusFact(entry);
          // A signed lease's dates belong to the Lease record, and a channel
          // import is owned by Airbnb — the same jump the record page's header
          // icon takes, reached here from the row's own ⋯ (PLAN-0920-1058, area 1c).

          return (
            <BookingsRowOverflow
              key={key}
              label={name}
              onView={() => navigate(href)}
              onEditDates={entry.source !== "airbnb" && entry.source !== "booking_com" ? () => onEditBlock ? onEditBlock(entry) : navigate(href) : undefined}
              onMessage={() => navigate(bookingRecordHref(basePath, key, "communication"))}
              onCancel={
                canCancelBooking(entry) && onDeleteBlock
                  ? () => onDeleteBlock(entry)
                  : canRemoveChannelStay(entry) && onRemoveStay
                    ? () => onRemoveStay(entry)
                    : undefined
              }
              cancelLabel={canRemoveChannelStay(entry) ? "Remove stay" : undefined}
            >
              <PortalApplicantRecordRow
                name={name}
                address={subtitle}
                amount={bookingRateLabel(entry)}
                facts={
                  <>
                    <PortalRowFact icon={CalendarDays} srLabel="Dates">{formatBookingStayRangeShort(entry.start, addDaysToDateKey(entry.end, 1), entry.openEnded)}</PortalRowFact>
                    <PortalRowFact icon={CircleCheck} srLabel="Status">{status}</PortalRowFact>
                    {showStayDetails ? <PortalRowFact icon={Globe} srLabel="Stay details">{[entry.stayDetails?.source || bookingSourceLabel(entry.source), entry.stayDetails?.linen && `Linen ${entry.stayDetails.linen}`, entry.stayDetails?.baggage && `Baggage ${entry.stayDetails.baggage}`, entry.stayDetails?.earlyCheckIn && `Early ${entry.stayDetails.earlyCheckIn}`, entry.stayDetails?.lateCheckOut && `Late ${entry.stayDetails.lateCheckOut}`].filter(Boolean).join(" · ")}</PortalRowFact> : null}
                    {entry.source === "airbnb" || entry.source === "booking_com" ? <PortalRowFact icon={entry.source === "airbnb" ? BookingsAirbnbIcon : Globe} srLabel="Source">{bookingSourceLabel(entry.source)}</PortalRowFact> : null}
                  </>
                }
                checked={selectedKeys.has(key)}
                onSelectedChange={(selected) => onToggleSelected(key, selected)}
                onOpen={() => navigate(href)}
                omitActionView
                dataAttr={`bookings-list-row-${key}`}
              />
            </BookingsRowOverflow>
          );
        })
      )}
    </PortalRecordListSurface>
  );
}
