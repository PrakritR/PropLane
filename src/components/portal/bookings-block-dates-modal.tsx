"use client";

/**
 * "Block dates" — a manager closes a room (or the whole home) for a range with
 * a reason. Check-out is exclusive, like a stay: block Sep 10 → 12 and the 12th
 * is still bookable. The form refuses a range that collides with a stay, a
 * hold, or another block on the same room, and names what it hit.
 *
 * A block can optionally be FOR someone: pick a resident already on the books,
 * or type a new name inline. That puts the name on the hold so the calendar
 * reads "Maya Zuneh · Held" instead of a grey "Blocked" — it does not create a
 * login, an application, or a lease; Residents → Add resident still owns that.
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
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";

const FIELD_LABEL = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";
const FIELD_LINK = "text-xs font-semibold normal-case tracking-normal text-primary hover:underline disabled:opacity-50";

/** The select's value for "new resident" — never a real identity key, which are `email:` / `name:` / `id:` prefixed. */
export const NEW_RESIDENT_CHOICE = "__new__";

export type BlockDatesDraft = {
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  reason: string;
  /** Who the room is held for; "" when the block is just closing the room. */
  residentName: string;
  residentEmail: string;
};

export function BookingsBlockDatesModal({
  open,
  onClose,
  propertyOptions,
  initialPropertyId,
  initialRoomId = "",
  initialDayKey,
  entries,
  residentOptions = [],
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
  /** People the room can be held for. Empty is fine — "New resident" still works. */
  residentOptions?: readonly BlockDatesResidentOption[];
  onSave: (draft: BlockDatesDraft) => Promise<void>;
}) {
  const [propertyId, setPropertyId] = useState("");
  const [roomChoice, setRoomChoice] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [reason, setReason] = useState("");
  /** "" = no one, an option key = that resident, NEW_RESIDENT_CHOICE = the inline fields. */
  const [residentChoice, setResidentChoice] = useState("");
  const [newResidentName, setNewResidentName] = useState("");
  const [newResidentEmail, setNewResidentEmail] = useState("");
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
    setResidentChoice("");
    setNewResidentName("");
    setNewResidentEmail("");
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

  const isNewResident = residentChoice === NEW_RESIDENT_CHOICE;
  const pickedResident = useMemo(
    () => (residentChoice && !isNewResident ? residentOptions.find((option) => option.key === residentChoice) ?? null : null),
    [residentChoice, isNewResident, residentOptions],
  );
  // A new resident needs at least a name; an empty "new" is the same as no one.
  const residentValid = !isNewResident || newResidentName.trim().length > 0;

  const canSave = Boolean(propertyId) && rangeValid && conflicts.length === 0 && residentValid && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const resident = isNewResident
        ? { residentName: newResidentName.trim(), residentEmail: newResidentEmail.trim().toLowerCase() }
        : pickedResident
          ? { residentName: pickedResident.name, residentEmail: pickedResident.email }
          : { residentName: "", residentEmail: "" };
      await onSave({ propertyId, roomId, checkIn, checkOut, reason, ...resident });
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
        <ModalFooter>
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

        <div>
          <div className={`${FIELD_LABEL} flex items-center`}>
            <span>
              Resident <span className="font-medium normal-case tracking-normal text-muted/70">optional</span>
            </span>
            {isNewResident ? (
              <button
                type="button"
                className={`ml-auto ${FIELD_LINK}`}
                disabled={busy}
                data-attr="bookings-block-resident-pick-list"
                onClick={() => setResidentChoice("")}
              >
                Pick from list instead
              </button>
            ) : (
              <button
                type="button"
                className={`ml-auto ${FIELD_LINK}`}
                disabled={busy}
                data-attr="bookings-block-resident-new"
                onClick={() => setResidentChoice(NEW_RESIDENT_CHOICE)}
              >
                + New resident
              </button>
            )}
          </div>
          {isNewResident ? (
            <div
              className="space-y-2 rounded-xl border border-dashed border-primary/40 bg-primary/5 p-3"
              data-attr="bookings-block-resident-new-fields"
            >
              <Input
                value={newResidentName}
                placeholder="Full name"
                autoFocus
                maxLength={120}
                onChange={(e) => setNewResidentName(e.target.value)}
                disabled={busy}
                aria-label="New resident name"
                data-attr="bookings-block-resident-name"
              />
              <Input
                type="email"
                value={newResidentEmail}
                placeholder="Email (optional)"
                maxLength={200}
                onChange={(e) => setNewResidentEmail(e.target.value)}
                disabled={busy}
                aria-label="New resident email"
                data-attr="bookings-block-resident-email"
              />
              <p className="text-xs text-muted">
                Puts their name on the hold. Add their application and lease from Residents when you’re ready.
              </p>
            </div>
          ) : (
            <Select
              value={residentChoice}
              onChange={(e) => setResidentChoice(e.target.value)}
              disabled={busy}
              aria-label="Resident"
              data-attr="bookings-block-resident"
            >
              <option value="">
                {residentOptions.length === 0 ? "No residents yet — just close the room" : "No one — just close the room"}
              </option>
              {residentOptions.map((option) => (
                <option key={option.key} value={option.key}>
                  {option.meta ? `${option.name} · ${option.meta}` : option.name}
                </option>
              ))}
              <option value={NEW_RESIDENT_CHOICE}>+ New resident…</option>
            </Select>
          )}
        </div>

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
