"use client";

import type { ComponentProps, ReactNode } from "react";
import { Tag } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  bookingEntryKey,
  bookingOpenTarget,
  bookingSourceLabel,
  formatBookingStayRange,
  type ManagerBookingListBucketId,
} from "@/lib/channel-calendar/bookings-ui";
import { bookingRecordHref } from "@/lib/portal-detail-routes";
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
  if (entry.source === "block") return "";
  const status = entry.statusLabel?.trim() ?? "";
  return status && status !== "Confirmed" ? status : "";
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
  bucket,
  selectedKeys,
  onToggleSelected,
  onEditBlock,
  onDeleteBlock,
  bulkActions,
  emptyCard,
  basePath = "/portal",
  showToast,
}: {
  entries: PropertyBookingEntry[];
  loading?: boolean;
  bucket: ManagerBookingListBucketId;
  selectedKeys: ReadonlySet<string>;
  onToggleSelected: (key: string, selected: boolean) => void;
  onEditBlock?: (entry: PropertyBookingEntry) => void;
  onDeleteBlock?: (entry: PropertyBookingEntry) => void;
  bulkActions?: ReactNode;
  /** The tab's empty card — the page owns the copy, tab counts and Link Airbnb. */
  emptyCard?: ComponentProps<typeof PortalRecordListSurface>["emptyCard"];
  basePath?: string;
  showToast?: (message: string) => void;
}) {
  const navigate = usePortalNavigate();

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
          const subtitle = [
            formatBookingStayRange(entry.start, entry.end, entry.openEnded),
            entry.roomLabel,
            entry.propertyLabel,
          ]
            .filter(Boolean)
            .join(" · ");
          const isBlock = entry.source === "block" && Boolean(entry.blockId);
          const href = bookingRecordHref(basePath, key);
          const status = bookingRowStatusFact(entry);
          // A signed lease's dates belong to the Lease record, and a channel
          // import is owned by Airbnb — the same jump the record page's header
          // icon takes, reached here from the row's own ⋯ (PLAN-0920-1058, area 1c).
          const openTarget = isBlock ? null : bookingOpenTarget(entry, basePath);
          return (
            <BookingsRowOverflow
              key={key}
              label={name}
              onEditDates={
                isBlock && onEditBlock
                  ? () => onEditBlock(entry)
                  : openTarget
                    ? () => navigate(openTarget.href)
                    : undefined
              }
              editDatesLabel={openTarget?.label}
              onMoveRoom={isBlock && onEditBlock ? () => onEditBlock(entry) : undefined}
              onMessage={() => navigate(bookingRecordHref(basePath, key, "communication"))}
              onCopyLink={() => void copyLink(entry)}
              onCancel={isBlock && onDeleteBlock ? () => onDeleteBlock(entry) : undefined}
            >
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
