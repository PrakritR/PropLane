"use client";

/**
 * The Bookings day popup (PLAN-0922-1013) — a wizard PortalDialog over the
 * month calendar. `/portal/bookings/<yyyy-mm-dd>` still opens this dialog;
 * closing it returns to `/portal/bookings/calendar`. Rows are grouped by
 * property and open the booking's own record page.
 *
 * Add / Edit booking is a sibling of this dialog, not a child: the workspace
 * lives at z-80 and the day card at z-90, so a nested open left the schedule
 * painted on top of the form.
 */

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPersonRecordRow } from "@/components/portal/portal-record-row";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import {
  BookingsBlockDatesModal,
  type BlockDatesDraft,
  type BlockDatesSaveResult,
} from "@/components/portal/bookings-block-dates-modal";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { bookingEntriesForDayKey, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import {
  addDaysToDateKey,
  bookingDeleteRefusalReason,
  bookingEntryKey,
  bookingOpenTarget,
  bookingSourceLabel,
  formatBookingStayRange,
} from "@/lib/channel-calendar/bookings-ui";
import { dayOccupancy } from "@/lib/channel-calendar/bookings-occupancy";
import { roomCountForProperty } from "@/lib/channel-calendar/bookings-room-counts";
import { bookingRecordHref, managerBookingDayHref } from "@/lib/portal-detail-routes";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { dateKey, startOfLocalDay } from "@/lib/room-availability-calendar";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";

function guestName(entry: PropertyBookingEntry): string {
  return entry.source === "airbnb" || entry.source === "booking_com"
    ? bookingGuestLabel(entry.summary, entry.source)
    : entry.summary;
}

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
  loading,
  propertyOptions,
  residentOptions,
  onSaveBlock,
  onRemoveBlock,
  showToast,
  onClose,
}: {
  dayKey: string;
  basePath: string;
  entries: readonly PropertyBookingEntry[];
  loading: boolean;
  propertyOptions: ManagerPropertyFilterOption[];
  residentOptions: readonly BlockDatesResidentOption[];
  onSaveBlock: (draft: BlockDatesDraft) => Promise<BlockDatesSaveResult>;
  onRemoveBlock: (blockId: string) => Promise<void>;
  showToast: (message: string) => void;
  /** Close the day dialog — parent navigates back to the calendar tab. */
  onClose?: () => void;
}) {
  const navigate = usePortalNavigate();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingBlock, setEditingBlock] = useState<PropertyBookingEntry | null>(null);
  const [deletingEntry, setDeletingEntry] = useState<PropertyBookingEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const todayKey = useMemo(() => dateKey(startOfLocalDay(new Date())), []);

  const propertyIds = useMemo(() => propertyOptions.map((option) => option.id), [propertyOptions]);

  const dayBookings = useMemo(
    () => [...bookingEntriesForDayKey(entries, dayKey)].sort((a, b) => a.propertyLabel.localeCompare(b.propertyLabel)),
    [entries, dayKey],
  );

  const overall = useMemo(
    () => dayOccupancy(entries, dayKey, propertyIds, roomCountForProperty),
    [entries, dayKey, propertyIds],
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
        occupancy: dayOccupancy(entries, dayKey, [group.propertyId], roomCountForProperty),
      }))
      .sort((a, b) => a.propertyLabel.localeCompare(b.propertyLabel));
  }, [dayBookings, entries, dayKey]);

  const openEdit = (entry: PropertyBookingEntry) => {
    setEditingBlock(entry);
    setSheetOpen(true);
  };

  const openAdd = () => {
    setEditingBlock(null);
    setSheetOpen(true);
  };

  // "Delete booking" — refuse outright for an in-house active tenancy (no
  // existing rule covered this; `bookingDeleteRefusalReason` is the new one),
  // otherwise confirm before actually removing the hold.
  const requestDelete = (entry: PropertyBookingEntry) => {
    const refusal = bookingDeleteRefusalReason(entry, todayKey);
    if (refusal) {
      showToast(refusal);
      return;
    }
    setDeletingEntry(entry);
  };

  const confirmDelete = async () => {
    if (!deletingEntry?.blockId) return;
    setDeleting(true);
    try {
      await onRemoveBlock(deletingEntry.blockId);
      showToast("Booking deleted.");
      setDeletingEntry(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "Could not delete that booking.");
    } finally {
      setDeleting(false);
    }
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

  const summaryLine = `${dayBookings.length} booking${dayBookings.length === 1 ? "" : "s"} · ${overall.checkIns} check-in${
    overall.checkIns === 1 ? "" : "s"
  } · ${overall.occupied} of ${overall.rooms} rooms occupied`;

  const closeDay = onClose ?? (() => navigate(`${basePath}/bookings/calendar`));

  // Add booking is ListingWizardOverlay at z-80. The day card is a PortalDialog
  // at z-90. Nesting the workspace inside the day dialog both painted the
  // schedule card on top of the form and left two aria-modal layers fighting
  // (the Next overlay's "2 Issues"). Close the day card while the workspace is
  // open, and keep Add / Delete as siblings so they survive that close.
  return (
    <>
      <PortalDialog
        open={!sheetOpen}
        onClose={closeDay}
        title={dayTitle(dayKey)}
        size="wizard"
        primaryAction={null}
        dismissBlocked={deleting}
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
            <PortalPrimaryIconAction
              label="Add booking"
              icon={Plus}
              data-attr="bookings-day-add"
              disabled={propertyOptions.length === 0}
              onClick={openAdd}
            />
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
              <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-3 py-2 text-[12px] font-semibold uppercase tracking-wide text-muted sm:px-4">
                <span className="truncate">{group.propertyLabel}</span>
                <span className="shrink-0 tabular-nums">
                  {group.occupancy.occupied} of {group.occupancy.rooms} rooms
                </span>
              </div>
              {group.bookings.map((entry) => {
                const key = bookingEntryKey(entry);
                const name = guestName(entry);
                const isBlock = entry.source === "block" && Boolean(entry.blockId);
                const meta = [
                  formatBookingStayRange(entry.start, entry.end, entry.openEnded),
                  bookingSourceLabel(entry.source),
                  entry.statusLabel,
                ]
                  .filter(Boolean)
                  .join(" · ");
                // Every card gets an Edit + Delete pair: a manager-made hold
                // edits/deletes right here, while a signed lease or channel
                // import jumps to the record that actually owns it — same
                // repurposing the Upcoming list uses (bookingOpenTarget) — and
                // stays undeletable from this sheet.
                const openTarget = isBlock ? null : bookingOpenTarget(entry, basePath);
                return (
                  <BookingsRowOverflow
                    key={key}
                    label={name}
                    onEditDates={
                      isBlock ? () => openEdit(entry) : openTarget ? () => navigate(openTarget.href) : undefined
                    }
                    editDatesLabel={isBlock ? "Edit booking" : openTarget?.label}
                    onMessage={() => navigate(bookingRecordHref(basePath, key, "communication"))}
                    onCopyLink={() => void copyLink(entry)}
                    onCancel={isBlock ? () => requestDelete(entry) : undefined}
                    cancelLabel="Delete booking"
                  >
                    <PortalPersonRecordRow
                      name={`${name} · ${entry.roomLabel}`}
                      subtitle={meta}
                      onOpen={() => navigate(bookingRecordHref(basePath, key))}
                      omitActionView
                      dataAttr={`bookings-day-row-${key}`}
                      // Inside `BookingsRowOverflow`'s context, `RowSelectCheckbox`
                      // swaps its checkbox for the ⋯ trigger, but only renders at
                      // all once something asks for it here — without
                      // `onSelectedChange` this row drew no ⋯ whatsoever, so every
                      // card's Edit/Delete was unreachable (the actual root cause
                      // of the day pop-up's dead actions).
                      onSelectedChange={() => {}}
                    />
                  </BookingsRowOverflow>
                );
              })}
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
        onDeleteBlock={onRemoveBlock}
      />

      <PortalDialog
        open={Boolean(deletingEntry)}
        onClose={() => (deleting ? undefined : setDeletingEntry(null))}
        title="Delete booking"
        tone="danger"
        dismissBlocked={deleting}
        dataAttr="bookings-day-delete-confirm"
        secondaryAction={{ label: "Keep", onClick: () => setDeletingEntry(null), disabled: deleting }}
        primaryAction={{
          label: deleting ? "Deleting…" : "Delete",
          onClick: () => void confirmDelete(),
          disabled: deleting,
          loading: deleting,
          dataAttr: "bookings-day-delete-confirm-primary",
        }}
      >
        <p className="text-sm text-muted">
          {deletingEntry
            ? `Delete ${guestName(deletingEntry)}’s booking at ${deletingEntry.roomLabel}? This cannot be undone.`
            : ""}
        </p>
      </PortalDialog>
    </>
  );
}
