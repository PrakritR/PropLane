"use client";

/**
 * The booking record page's "Edit dates" header action (PLAN-0920-1058, area
 * 1e) — a focused sheet, not the combined Add-booking/Link-calendars dialog.
 * Only a block-sourced booking (a manager-made hold) can actually be edited
 * here; the record page gates when this opens.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Modal, ModalFooter, MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import {
  bookingConflictsFor,
  lastNightBeforeCheckout,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, describeBookingConflict } from "@/lib/channel-calendar/bookings-ui";

export function BookingsEditDatesSheet({
  open,
  onClose,
  entry,
  entries,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  /** The booking being edited — must carry `blockId`, the only kind this sheet can save. */
  entry: PropertyBookingEntry;
  /** Everything else on the calendar, for the overlap check. */
  entries: readonly PropertyBookingEntry[];
  onSave: (next: { checkIn: string; checkOut: string }) => Promise<void>;
}) {
  const [checkIn, setCheckIn] = useState(entry.start);
  const [checkOut, setCheckOut] = useState(addDaysToDateKey(entry.end, 1));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCheckIn(entry.start);
    setCheckOut(addDaysToDateKey(entry.end, 1));
    setError(null);
    setBusy(false);
  }, [open, entry.start, entry.end]);

  const rangeValid = Boolean(checkIn && checkOut && checkOut > checkIn);

  const conflicts = useMemo(() => {
    if (!rangeValid) return [];
    const pool = entries.filter((candidate) => candidate.blockId !== entry.blockId);
    return bookingConflictsFor(pool, {
      propertyId: entry.propertyId,
      roomId: entry.roomId,
      start: checkIn,
      end: lastNightBeforeCheckout(checkOut),
    });
  }, [entries, entry.blockId, entry.propertyId, entry.roomId, checkIn, checkOut, rangeValid]);

  const canSave = rangeValid && conflicts.length === 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ checkIn, checkOut });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save those dates.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit dates"
      dataAttr="bookings-edit-dates-sheet"
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canSave} data-attr="bookings-edit-dates-save">
            Save dates
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={MODAL_FIELD_LABEL_CLASS}>Move in</span>
            <DateField
              value={checkIn}
              onChange={setCheckIn}
              disabled={busy}
              data-attr="bookings-edit-dates-checkin"
            />
          </label>
          <label className="block">
            <span className={MODAL_FIELD_LABEL_CLASS}>Move out</span>
            <DateField
              value={checkOut}
              onChange={setCheckOut}
              disabled={busy}
              data-attr="bookings-edit-dates-checkout"
            />
          </label>
        </div>

        {conflicts.length > 0 ? (
          <div role="alert" className="rounded-lg border px-3 py-2 text-sm portal-banner-danger" data-attr="bookings-edit-dates-conflicts">
            {conflicts.slice(0, 4).map((conflict, index) => (
              <p key={`${index}-${conflict.source}-${conflict.start}`} className="py-0.5">
                {describeBookingConflict(conflict, entry.roomLabel)}
              </p>
            ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-lg border px-3 py-2 text-sm portal-banner-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
