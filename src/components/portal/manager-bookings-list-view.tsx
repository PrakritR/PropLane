"use client";

import type { ComponentProps, ReactNode } from "react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { portalEmptyCopy } from "@/lib/portal-empty-copy";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  bookingEntryKey,
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
          const href = bookingRecordHref(basePath, key);
          return (
            <BookingsRowOverflow
              key={key}
              label={name}
              onEditDates={isBlock && onEditBlock ? () => onEditBlock(entry) : undefined}
              onMoveRoom={isBlock && onEditBlock ? () => onEditBlock(entry) : undefined}
              onMessage={() => navigate(bookingRecordHref(basePath, key, "communication"))}
              onCopyLink={() => void copyLink(entry)}
              onCancel={isBlock && onDeleteBlock ? () => onDeleteBlock(entry) : undefined}
            >
              <PortalPersonRecordRow
                name={name}
                subtitle={subtitle}
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
