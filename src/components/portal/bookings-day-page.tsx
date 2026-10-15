"use client";

/**
 * The Bookings day popup (PLAN-0922-1013 / PLAN-0922-1904) — a wizard
 * PortalDialog over the month calendar. `/portal/bookings/<yyyy-mm-dd>` still
 * opens this dialog; closing it returns to `/portal/bookings/calendar`.
 *
 * Add booking lives on the calendar command-bar +, not here. Edit / Remove
 * stay siblings of this dialog so the workspace is not painted under the card.
 */

import { useMemo, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Lock, Tag } from "lucide-react";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalApplicantRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import {
  BookingsBlockDatesModal,
  type BlockDatesDraft,
  type BlockDatesSaveResult,
} from "@/components/portal/bookings-block-dates-modal";
import { bookingCancelLabel, canRemoveBooking } from "@/lib/channel-calendar/booking-presentation";
import { bookingEntriesForDayKey, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  addDaysToDateKey,
  bookingEntryKey,
  bookingOpenTarget,
  bookingSourceLabel,
  formatBookingStayRange,
} from "@/lib/channel-calendar/bookings-ui";
import { dayOccupancy, dayOccupancyFromLookup, type OccupancyDayLookup } from "@/lib/channel-calendar/bookings-occupancy";
import { bookingOccupancyCapacities } from "@/lib/channel-calendar/bookings-room-counts";
import { dayStayDisplayName, groupStaysByRoom, isAvailabilityBlockRow } from "@/lib/occupancy/snapshot";
import { bookingRecordHref, managerBookingDayHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { dateKey, startOfLocalDay } from "@/lib/room-availability-calendar";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";

function dayTitle(dayKey: string): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const monthDay = date.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `${weekday}, ${monthDay}`;
}

export function BookingsDayPage({
  dayKey,
  basePath,
  entries,
  occupancyDays,
  loading,
  propertyOptions,
  residentOptions,
  onSaveBlock,
  onDeleteBlock,
  showToast,
  onClose,
}: {
  dayKey: string;
  basePath: string;
  entries: readonly PropertyBookingEntry[];
  occupancyDays?: OccupancyDayLookup;
  loading: boolean;
  propertyOptions: ManagerPropertyFilterOption[];
  residentOptions: readonly BlockDatesResidentOption[];
  onSaveBlock: (draft: BlockDatesDraft) => Promise<BlockDatesSaveResult>;
  /**
   * The one removal decision, owned by the parent: a marked reservation goes to the Delete confirm,
   * a block held for a named person to the cancel dialog — the same router the list row and the
   * Edit sheet's footer use, so `bookingCancelLabel` always names what actually happens.
   */
  onDeleteBlock: (entry: PropertyBookingEntry) => void;
  showToast: (message: string) => void;
  /** Close the day dialog — parent navigates back to the calendar tab. */
  onClose?: () => void;
}) {
  const navigate = usePortalNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingBlock, setEditingBlock] = useState<PropertyBookingEntry | null>(null);
  const todayKey = useMemo(() => dateKey(startOfLocalDay(new Date())), []);

  const propertyIds = useMemo(() => propertyOptions.map((option) => option.id), [propertyOptions]);

  const dayBookings = useMemo(
    () => [...bookingEntriesForDayKey(entries, dayKey)].sort((a, b) => a.propertyLabel.localeCompare(b.propertyLabel)),
    [entries, dayKey],
  );

  const overall = useMemo(
    () =>
      dayOccupancyFromLookup(occupancyDays, dayKey, propertyIds, () =>
        dayOccupancy(entries, dayKey, propertyIds, bookingOccupancyCapacities),
      ),
    [occupancyDays, entries, dayKey, propertyIds],
  );

  const groups = useMemo(() => {
    const byProperty = new Map<string, { propertyId: string; propertyLabel: string; bookings: PropertyBookingEntry[] }>();
    for (const booking of dayBookings) {
      const existing = byProperty.get(booking.propertyId);
      if (existing) existing.bookings.push(booking);
      else byProperty.set(booking.propertyId, { propertyId: booking.propertyId, propertyLabel: booking.propertyLabel, bookings: [booking] });
    }
    return [...byProperty.values()]
      .map((group) => ({
        ...group,
        occupancy: dayOccupancyFromLookup(occupancyDays, dayKey, [group.propertyId], () =>
          dayOccupancy(entries, dayKey, [group.propertyId], bookingOccupancyCapacities),
        ),
        rooms: groupStaysByRoom(group.bookings),
      }))
      .sort((a, b) => a.propertyLabel.localeCompare(b.propertyLabel));
  }, [dayBookings, occupancyDays, entries, dayKey]);

  const openEdit = (entry: PropertyBookingEntry) => {
    setEditingBlock(entry);
    setSheetOpen(true);
  };

  const copyLink = async (entry: PropertyBookingEntry) => {
    const href = bookingRecordHref(basePath, bookingEntryKey(entry));
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${href}`);
      showToast("Link copied.");
    } catch {
      showToast("Could not copy the link.");
    }
  };

  // Match the month cell (beds occupied / beds total) — never lead with a
  // booking-row count that fights the occupancy fraction (PLAN-0923-1737).
  const summaryLine = `${overall.occupied} of ${overall.rooms} beds occupied · ${overall.checkIns} check-in${
    overall.checkIns === 1 ? "" : "s"
  }`;

  const closeDay = onClose ?? (() => navigate(`${basePath}/bookings/calendar`));

  return (
    <>
      <PortalDialog
        open={!sheetOpen}
        onClose={closeDay}
        title={dayTitle(dayKey)}
        size="wizard"
        primaryAction={null}
        // A list, not a form: no left rail and no "Preview · No changes" box to squeeze the rows.
        contextPanel={null}
        preview={null}
        dataAttr="bookings-day-detail-modal"
        headerAction={
          <div className="flex shrink-0 items-center gap-1" data-attr="bookings-day-page-header">
            <button
              type="button"
              aria-label="Previous day"
              data-attr="bookings-day-prev"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted shadow-[var(--shadow-sm)] transition hover:border-primary/45 hover:text-foreground"
              onClick={() => navigate(managerBookingDayHref(basePath, addDaysToDateKey(dayKey, -1)))}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Next day"
              data-attr="bookings-day-next"
              className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-card text-muted shadow-[var(--shadow-sm)] transition hover:border-primary/45 hover:text-foreground"
              onClick={() => navigate(managerBookingDayHref(basePath, addDaysToDateKey(dayKey, 1)))}
            >
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        }
      >
        <p className="mb-3 min-w-0 truncate text-[13px] text-muted" data-attr="bookings-day-summary">
          {summaryLine}
        </p>

        <PortalRecordListSurface
          isEmpty={!loading && dayBookings.length === 0}
          emptyCard={{ title: "No bookings this day", section: "bookings" }}
          dataAttr="bookings-day-list"
        >
          {groups.map((group) => (
            <div key={group.propertyId} data-attr={`bookings-day-group-${group.propertyId}`}>
              <div className="flex items-baseline justify-between gap-3 border-b border-border/60 px-3 pb-1.5 pt-3.5 sm:px-4" data-attr="bookings-day-group-header">
                <span className="min-w-0 truncate text-[14px] font-semibold text-foreground">{group.propertyLabel}</span>
                <span className="shrink-0 text-[13px] font-semibold tabular-nums text-muted">
                  {group.occupancy.occupied} of {group.occupancy.rooms} beds
                </span>
              </div>
              {group.rooms.map((room) => (
                <div key={room.roomId || room.roomLabel} data-attr={`bookings-day-room-${room.roomId || "home"}`}>
                  {room.stays.map((entry) => {
                    const key = bookingEntryKey(entry);
                    const name = dayStayDisplayName(entry);
                    const isBlock = entry.source === "block" && Boolean(entry.blockId);
                    const isAvailabilityBlock = isAvailabilityBlockRow(entry);
                    // The house is the group header, so the place line is just the room.
                    const placeLine = entry.roomLabel || "Whole home";
                    const openTarget = isBlock ? null : bookingOpenTarget(entry, basePath);
                    const row = (
                      <PortalApplicantRecordRow
                        name={name}
                        tileIcon={isAvailabilityBlock ? Lock : undefined}
                        tileLabel={name.replace(/\s*·\s*/g, " ")}
                        address={placeLine}
                        facts={
                          <>
                            <PortalRowFact icon={CalendarDays} srLabel="Stay">
                              {formatBookingStayRange(entry.start, entry.end, entry.openEnded)}
                            </PortalRowFact>
                            <PortalRowFact icon={Tag} srLabel="Source">
                              {bookingSourceLabel(entry.source, entry.channelLabel)}
                              {entry.statusLabel ? ` · ${entry.statusLabel}` : ""}
                            </PortalRowFact>
                          </>
                        }
                        onOpen={() => navigate(bookingRecordHref(basePath, key))}
                        omitActionView
                        dataAttr={`bookings-day-row-${key}`}
                        onSelectedChange={() => {}}
                      />
                    );
                    // Nobody to message on an availability block. The row itself opens the booking,
                    // so a ⋯ appears only when it would hold two or more actions.
                    const removable = canRemoveBooking(entry, todayKey);
                    const actionCount =
                      (isBlock || openTarget ? 1 : 0) + (isAvailabilityBlock ? 0 : 1) + 1 + (removable ? 1 : 0);
                    if (actionCount < 2) return <RecordActionContext.Provider key={key} value={null}>{row}</RecordActionContext.Provider>;
                    return (
                      <BookingsRowOverflow
                        key={key}
                        label={name}
                        onEditDates={
                          isBlock ? () => openEdit(entry) : openTarget ? () => navigate(openTarget.href) : undefined
                        }
                        editDatesLabel={isBlock ? "Edit booking" : openTarget?.label}
                        onMessage={isAvailabilityBlock ? undefined : () => navigate(bookingRecordHref(basePath, key, "communication"))}
                        onCopyLink={() => void copyLink(entry)}
                        onCancel={removable ? () => onDeleteBlock(entry) : undefined}
                        cancelLabel={bookingCancelLabel(entry)}
                      >
                        {row}
                      </BookingsRowOverflow>
                    );
                  })}
                </div>
              ))}
            </div>
          ))}
        </PortalRecordListSurface>
      </PortalDialog>

      <BookingsBlockDatesModal
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        propertyOptions={propertyOptions}
        initialPropertyId={propertyOptions.length === 1 ? propertyOptions[0]!.id : undefined}
        initialDayKey={dayKey}
        editingBlock={editingBlock}
        entries={entries}
        residentOptions={residentOptions}
        onSave={onSaveBlock}
        onRemoveBooking={onDeleteBlock}
      />
    </>
  );
}
