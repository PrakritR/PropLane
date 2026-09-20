"use client";

/**
 * The booking record page's "Move room" header action (PLAN-0920-1058, area
 * 1e) — a focused sheet, not the combined Add-booking/Link-calendars dialog.
 * Only a block-sourced booking (a manager-made hold) can actually be moved;
 * the record page gates when this opens. Same house only — moving a booking
 * to a different property is a new booking, not a move.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Modal, ModalFooter, MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import {
  bookingConflictsFor,
  lastNightBeforeCheckout,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { describeBookingConflict } from "@/lib/channel-calendar/bookings-ui";
import { getRoomOptionsForProperty } from "@/lib/rental-application/data";

export function BookingsMoveRoomSheet({
  open,
  onClose,
  entry,
  entries,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  /** The booking being moved — must carry `blockId`, the only kind this sheet can save. */
  entry: PropertyBookingEntry;
  entries: readonly PropertyBookingEntry[];
  onSave: (next: { roomId: string }) => Promise<void>;
}) {
  const [roomId, setRoomId] = useState(entry.roomId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRoomId(entry.roomId);
    setError(null);
    setBusy(false);
  }, [open, entry.roomId]);

  const roomOptions = useMemo(
    () => getRoomOptionsForProperty(entry.propertyId, { includeUnavailable: true }),
    [entry.propertyId],
  );

  const conflicts = useMemo(() => {
    const pool = entries.filter((candidate) => candidate.blockId !== entry.blockId);
    return bookingConflictsFor(pool, {
      propertyId: entry.propertyId,
      roomId,
      start: entry.start,
      end: lastNightBeforeCheckout(entry.end) < entry.start ? entry.start : lastNightBeforeCheckout(entry.end),
    });
  }, [entries, entry.blockId, entry.propertyId, entry.start, entry.end, roomId]);

  const canSave = Boolean(roomId) && roomId !== entry.roomId && conflicts.length === 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ roomId });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not move that booking.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Move room"
      dataAttr="bookings-move-room-sheet"
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void save()} disabled={!canSave} data-attr="bookings-move-room-save">
            Move booking
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className={MODAL_FIELD_LABEL_CLASS}>Room</span>
          <Select
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            disabled={busy}
            data-attr="bookings-move-room-select"
          >
            {roomOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>

        {conflicts.length > 0 ? (
          <div role="alert" className="rounded-lg border px-3 py-2 text-sm portal-banner-danger" data-attr="bookings-move-room-conflicts">
            {conflicts.slice(0, 4).map((conflict, index) => (
              <p key={`${index}-${conflict.source}-${conflict.start}`} className="py-0.5">
                {describeBookingConflict(conflict, conflict.roomLabel)}
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
