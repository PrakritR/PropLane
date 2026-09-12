"use client";

/**
 * "Block dates" — a manager closes a room (or the whole home) for a range with
 * a reason. Check-out is exclusive, like a stay: block Sep 10 → 12 and the 12th
 * is still bookable. The form refuses a range that collides with a stay, a
 * hold, or another block on the same room, and names what it hit.
 */

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import {
  bookingConflictsFor,
  lastNightBeforeCheckout,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { formatBookingStayRange, addDaysToDateKey } from "@/lib/channel-calendar/bookings-ui";
import { getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";

const FIELD_LABEL = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";

export type BlockDatesDraft = {
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  reason: string;
};

export function BookingsBlockDatesModal({
  open,
  onClose,
  propertyOptions,
  initialPropertyId,
  initialRoomId = "",
  initialDayKey,
  entries,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  initialRoomId?: string;
  /** Day the manager clicked in the calendar — becomes check-in, with check-out the next day. */
  initialDayKey?: string | null;
  /** Everything already on the calendar, for the collision check. */
  entries: readonly PropertyBookingEntry[];
  onSave: (draft: BlockDatesDraft) => Promise<void>;
}) {
  const [propertyId, setPropertyId] = useState("");
  const [roomChoice, setRoomChoice] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const property = initialPropertyId || (propertyOptions.length === 1 ? propertyOptions[0]!.id : "");
    setPropertyId(property);
    setRoomChoice(initialRoomId && property ? `${property}::${initialRoomId}` : "");
    setCheckIn(initialDayKey ?? "");
    setCheckOut(initialDayKey ? addDaysToDateKey(initialDayKey, 1) : "");
    setReason("");
    setError(null);
    setBusy(false);
  }, [open, initialPropertyId, initialRoomId, initialDayKey, propertyOptions]);

  const roomOptions = useMemo(
    () => (propertyId ? getRoomOptionsForProperty(propertyId, { includeUnavailable: true }) : []),
    [propertyId],
  );

  const roomId = useMemo(() => parseRoomChoiceValue(roomChoice).listingRoomId ?? "", [roomChoice]);

  const rangeValid = Boolean(checkIn && checkOut && checkOut > checkIn);

  const conflicts = useMemo(() => {
    if (!propertyId || !rangeValid) return [];
    return bookingConflictsFor(entries, {
      propertyId,
      roomId,
      start: checkIn,
      end: lastNightBeforeCheckout(checkOut),
    });
  }, [entries, propertyId, roomId, checkIn, checkOut, rangeValid]);

  const canSave = Boolean(propertyId) && rangeValid && conflicts.length === 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ propertyId, roomId, checkIn, checkOut, reason });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not block those dates.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Block dates"
      description="Close a room to new bookings. Check-out is the day it opens again."
      dataAttr="bookings-block-dates-modal"
      footer={
        <ModalFooter className="justify-start">
          <Button
            type="button"
            variant="primary"
            disabled={!canSave}
            data-attr="bookings-block-dates-save"
            onClick={() => save()}
          >
            {busy ? "Blocking…" : "Block dates"}
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-4">
        <label className="block">
          <span className={FIELD_LABEL}>Property</span>
          <Select
            value={propertyId}
            onChange={(e) => {
              setPropertyId(e.target.value);
              setRoomChoice("");
            }}
            disabled={busy || propertyOptions.length === 0}
            data-attr="bookings-block-property"
          >
            <option value="">Select a house…</option>
            {propertyOptions.map((property) => (
              <option key={property.id} value={property.id}>
                {property.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="block">
          <span className={FIELD_LABEL}>Room</span>
          <Select
            value={roomChoice}
            onChange={(e) => setRoomChoice(e.target.value)}
            disabled={busy || !propertyId || roomOptions.length === 0}
            data-attr="bookings-block-room"
          >
            <option value="">{roomOptions.length === 0 ? "Whole home" : "Whole home (every room)"}</option>
            {roomOptions.map((room) => (
              <option key={room.value} value={room.value}>
                {room.label}
              </option>
            ))}
          </Select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className={FIELD_LABEL}>Check-in</span>
            <Input
              type="date"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
              disabled={busy}
              data-attr="bookings-block-check-in"
            />
          </label>
          <label className="block">
            <span className={FIELD_LABEL}>Check-out</span>
            <Input
              type="date"
              value={checkOut}
              min={checkIn || undefined}
              onChange={(e) => setCheckOut(e.target.value)}
              disabled={busy}
              aria-invalid={checkIn && checkOut && !rangeValid ? true : undefined}
              data-attr="bookings-block-check-out"
            />
          </label>
        </div>
        {checkIn && checkOut && !rangeValid ? (
          <p className="text-xs text-[var(--status-overdue-fg)]" role="alert">
            Check-out must be after check-in.
          </p>
        ) : null}

        <label className="block">
          <span className={FIELD_LABEL}>Reason</span>
          <Textarea
            rows={2}
            value={reason}
            maxLength={200}
            placeholder="Repairs, owner stay, deep clean…"
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            data-attr="bookings-block-reason"
          />
        </label>

        {conflicts.length > 0 ? (
          <div
            role="alert"
            className="rounded-lg border px-3 py-2 text-sm portal-banner-danger"
            data-attr="bookings-block-conflicts"
          >
            <p className="font-semibold">These dates are already taken.</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {conflicts.slice(0, 4).map((entry, index) => (
                <li key={`${index}-${entry.source}-${entry.roomId}-${entry.start}`}>
                  {entry.summary} · {entry.roomLabel} · {formatBookingStayRange(entry.start, entry.end, entry.openEnded)}
                </li>
              ))}
              {conflicts.length > 4 ? <li>+{conflicts.length - 4} more</li> : null}
            </ul>
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
