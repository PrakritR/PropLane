"use client";

/**
 * Add booking — the same AddWorkspace as Add task (PLAN-0922-1225).
 * Link calendars is its own PortalDialog in channel-calendar-link-modal.tsx.
 */

import { useEffect, useMemo, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { Input, Select, Textarea } from "@/components/ui/input";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import {
  MODAL_FIELD_LABEL_CLASS,
  PORTAL_MODAL_FORM_FIELD_CLASS,
  PORTAL_MODAL_FORM_FULL_ROW_CLASS,
} from "@/components/ui/modal";
import {
  bookingConflictsFor,
  lastNightBeforeCheckout,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";
import { cn } from "@/lib/utils";

const FIELD_LINK = "text-xs font-semibold normal-case tracking-normal text-primary hover:underline disabled:opacity-50";

/** The select's value for "new resident" — never a real identity key, which are `email:` / `name:` / `id:` prefixed. */
export const NEW_RESIDENT_CHOICE = "__new__";

export type BlockDatesDraft = {
  id?: string;
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  reason: string;
  /** Who the room is held for; "" when the block is just closing the room. */
  residentName: string;
  residentEmail: string;
  /** E.164, or "" — at least one of email/phone is required for a new resident. Optional so an older caller's draft shape still compiles. */
  residentPhone?: string;
  /** True only for a person typed into "+ New resident" this save — never an existing pick. Optional so an older caller's draft shape still compiles. */
  isNewResident?: boolean;
};

/** What `onSave` reports back — surfaced in the sheet as a plain result line, never a toast-only aside. */
export type BlockDatesSaveResult = { message?: string } | void;

function applyEditingBlock(
  entry: PropertyBookingEntry | null | undefined,
  setPropertyId: (id: string) => void,
  setRoomChoice: (value: string) => void,
  setCheckIn: (value: string) => void,
  setCheckOut: (value: string) => void,
  setReason: (value: string) => void,
  setResidentChoice: (value: string) => void,
  setNewResidentName: (value: string) => void,
  setNewResidentPhone: (value: string) => void,
  setEditingBlockId: (id: string | null) => void,
  residentOptions: readonly BlockDatesResidentOption[],
) {
  if (!entry?.blockId) {
    setEditingBlockId(null);
    return;
  }
  setEditingBlockId(entry.blockId);
  setPropertyId(entry.propertyId);
  setRoomChoice(entry.roomId ? `${entry.propertyId}::${entry.roomId}` : "");
  setCheckIn(entry.start);
  setCheckOut(addDaysToDateKey(entry.end, 1));
  setReason(entry.reason ?? "");
  const match = entry.residentName
    ? residentOptions.find((option) => option.name === entry.residentName)
    : null;
  if (match) {
    setResidentChoice(match.key);
    setNewResidentName("");
    setNewResidentPhone("");
  } else if (entry.residentName) {
    setResidentChoice(NEW_RESIDENT_CHOICE);
    setNewResidentName(entry.residentName);
    setNewResidentPhone(entry.residentPhone ?? "");
  } else {
    setResidentChoice("");
    setNewResidentName("");
    setNewResidentPhone("");
  }
}

export function BookingsBlockDatesModal({
  open,
  onClose,
  propertyOptions,
  initialPropertyId,
  initialRoomId = "",
  initialDayKey,
  editingBlock = null,
  entries,
  residentOptions = [],
  onSave,
  onDeleteBlock,
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  initialRoomId?: string;
  /** Day the manager clicked in the calendar — becomes check-in, with check-out the next day. */
  initialDayKey?: string | null;
  editingBlock?: PropertyBookingEntry | null;
  /** Everything already on the calendar, for the collision check and the hold list. */
  entries: readonly PropertyBookingEntry[];
  /** People the room can be held for. Empty is fine — "New resident" still works. */
  residentOptions?: readonly BlockDatesResidentOption[];
  onSave: (draft: BlockDatesDraft) => Promise<BlockDatesSaveResult>;
  onDeleteBlock?: (blockId: string) => Promise<void>;
}) {
  const [stepIdx, setStepIdx] = useState(0);
  const [propertyId, setPropertyId] = useState("");
  const [roomChoice, setRoomChoice] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [reason, setReason] = useState("");
  const [residentChoice, setResidentChoice] = useState("");
  const [newResidentName, setNewResidentName] = useState("");
  const [newResidentEmail, setNewResidentEmail] = useState("");
  const [newResidentPhone, setNewResidentPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  /** Set after a NEW resident is saved — keeps the workspace open on a confirmation line instead of closing blind. */
  const [inviteResult, setInviteResult] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStepIdx(0);
    const property = initialPropertyId || (propertyOptions.length === 1 ? propertyOptions[0]!.id : "");
    setPropertyId(property);
    setRoomChoice(initialRoomId && property ? `${property}::${initialRoomId}` : "");
    setCheckIn(initialDayKey ?? "");
    setCheckOut(initialDayKey ? addDaysToDateKey(initialDayKey, 1) : "");
    setReason("");
    setResidentChoice("");
    setNewResidentName("");
    setNewResidentEmail("");
    setNewResidentPhone("");
    setError(null);
    setBusy(false);
    setInviteResult(null);
    applyEditingBlock(
      editingBlock,
      setPropertyId,
      setRoomChoice,
      setCheckIn,
      setCheckOut,
      setReason,
      setResidentChoice,
      setNewResidentName,
      setNewResidentPhone,
      setEditingBlockId,
      residentOptions,
    );
  }, [open, initialPropertyId, initialRoomId, initialDayKey, editingBlock, propertyOptions, residentOptions]);

  const roomOptions = useMemo(
    () => (propertyId ? getRoomOptionsForProperty(propertyId, { includeUnavailable: true }) : []),
    [propertyId],
  );

  const roomId = useMemo(() => parseRoomChoiceValue(roomChoice).listingRoomId ?? "", [roomChoice]);

  const rangeValid = Boolean(checkIn && checkOut && checkOut > checkIn);

  const conflictPool = useMemo(
    () => (editingBlockId ? entries.filter((entry) => entry.blockId !== editingBlockId) : entries),
    [editingBlockId, entries],
  );

  const conflicts = useMemo(() => {
    if (!propertyId || !rangeValid) return [];
    return bookingConflictsFor(conflictPool, {
      propertyId,
      roomId,
      start: checkIn,
      end: lastNightBeforeCheckout(checkOut),
    });
  }, [conflictPool, propertyId, roomId, checkIn, checkOut, rangeValid]);

  const isNewResident = residentChoice === NEW_RESIDENT_CHOICE;
  const pickedResident = useMemo(
    () => (residentChoice && !isNewResident ? residentOptions.find((option) => option.key === residentChoice) ?? null : null),
    [residentChoice, isNewResident, residentOptions],
  );
  // A new resident needs a name plus at least one way to reach them — email,
  // phone, or both — so the invite that skips application/lease has somewhere to go.
  const residentValid =
    !isNewResident || (newResidentName.trim().length > 0 && (newResidentEmail.trim().length > 0 || newResidentPhone.trim().length > 0));

  const canSave = Boolean(propertyId) && rangeValid && conflicts.length === 0 && residentValid && !busy;

  const existingBlocks = useMemo(
    () => entries.filter((entry) => entry.source === "block" && entry.blockId),
    [entries],
  );

  const selectedProperty = propertyOptions.find((property) => property.id === propertyId) ?? null;
  const selectedRoom = roomOptions.find((room) => room.value === roomChoice) ?? null;
  const residentSummary = isNewResident
    ? newResidentName.trim() || "New resident"
    : pickedResident
      ? pickedResident.name
      : "No one";
  const whenSummary =
    checkIn && checkOut
      ? formatBookingStayRange(checkIn, lastNightBeforeCheckout(checkOut))
      : checkIn || "Move in";

  const save = async () => {
    if (inviteResult) {
      onClose();
      return;
    }
    if (!canSave) return;
    setBusy(true);
    setError(null);
    setInviteResult(null);
    try {
      const resident = isNewResident
        ? {
            residentName: newResidentName.trim(),
            residentEmail: newResidentEmail.trim().toLowerCase(),
            residentPhone: newResidentPhone.trim(),
          }
        : pickedResident
          ? { residentName: pickedResident.name, residentEmail: pickedResident.email, residentPhone: "" }
          : { residentName: "", residentEmail: "", residentPhone: "" };
      const result = await onSave({
        ...(editingBlockId ? { id: editingBlockId } : {}),
        propertyId,
        roomId,
        checkIn,
        checkOut,
        reason,
        ...resident,
        // Editing an existing block never re-invites — only a fresh "+ New
        // resident" save on a brand-new hold does.
        isNewResident: isNewResident && !editingBlockId,
      });
      // A brand-new resident gets a confirmation line (did the invite go by
      // text or email?) instead of the workspace vanishing on them — everyone
      // else (no one / an existing pick / an edit) closes as before.
      if (isNewResident && result?.message) {
        setInviteResult(result.message);
        setStepIdx(3);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save booking. House and move-in are required.");
      setStepIdx(3);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const steps: AddWorkspaceStep[] = [
    {
      id: "booking",
      label: "Booking",
      summary: reason.trim() || "Reason",
    },
    {
      id: "property",
      label: "Property",
      incomplete: !propertyId,
      summary: selectedProperty?.label || "Pick a house",
    },
    {
      id: "when",
      label: "When",
      incomplete: !rangeValid || conflicts.length > 0,
      summary: whenSummary,
    },
    {
      id: "review",
      label: "Review",
      summary: editingBlockId ? "Save booking" : "Add booking",
    },
  ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  return (
    <div data-attr="bookings-block-dates-modal">
      <AddWorkspace
        title={editingBlockId ? "Edit booking" : "Add booking"}
        steps={steps}
        current={current}
        onJump={setStepIdx}
        onClose={onClose}
        dirty={Boolean(propertyId || checkIn || reason.trim() || residentChoice)}
        discardTitle={editingBlockId ? "Discard these edits?" : "Discard this booking?"}
        assistantContext={editingBlockId ? "Edit booking" : "Add booking"}
        assistantScopeKey={editingBlockId ? "edit-booking" : "add-booking"}
        lastLabel={inviteResult ? "Done" : editingBlockId ? "Save booking" : "Add booking"}
        lastDisabled={!inviteResult && !canSave}
        nextDisabled={
          (stepId === "property" && !propertyId) ||
          (stepId === "when" && (!rangeValid || conflicts.length > 0))
        }
        onBeforeNext={() => {
          if (stepId === "property" && !propertyId) return false;
          if (stepId === "when" && (!rangeValid || conflicts.length > 0)) return false;
          return true;
        }}
        busy={busy}
        onFinish={() => void save()}
        saveState={undefined}
        dataAttrPrefix="bookings-block-dates"
        finishDataAttr={inviteResult ? "bookings-block-dates-done" : "bookings-block-dates-save"}
      >
        <div hidden={stepId !== "booking"}>
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="bookings-block-reason">
              Reason
            </label>
            <Textarea
              id="bookings-block-reason"
              rows={3}
              value={reason}
              maxLength={200}
              placeholder="Repairs, owner stay, deep clean…"
              onChange={(e) => setReason(e.target.value)}
              disabled={busy}
              data-attr="bookings-block-reason"
            />
          </div>
        </div>

        <div hidden={stepId !== "property"}>
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <label className={MODAL_FIELD_LABEL_CLASS}>
              Property
            </label>
            <Select
              value={propertyId}
              onChange={(e) => {
                setPropertyId(e.target.value);
                setRoomChoice("");
              }}
              disabled={busy || propertyOptions.length === 0}
              aria-label="Property"
              data-attr="bookings-block-property"
            >
              <option value="">{propertyOptions.length === 0 ? "No houses yet" : "Select property"}</option>
              {propertyOptions.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.label}
                </option>
              ))}
            </Select>
          </div>

          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <div className={`${MODAL_FIELD_LABEL_CLASS} flex items-center`}>
              <span>Resident</span>
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
                  placeholder="Email"
                  maxLength={200}
                  onChange={(e) => setNewResidentEmail(e.target.value)}
                  disabled={busy}
                  aria-label="New resident email"
                  data-attr="bookings-block-resident-email"
                />
                <PhoneNumberField
                  id="bookings-block-resident-phone"
                  value={newResidentPhone}
                  onChange={setNewResidentPhone}
                  disabled={busy}
                  placeholder="Phone"
                  dataAttr="bookings-block-resident-phone"
                />
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

          {propertyId ? (
            <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
              <label className={MODAL_FIELD_LABEL_CLASS}>
                Room
              </label>
              <Select
                value={roomChoice}
                onChange={(e) => setRoomChoice(e.target.value)}
                disabled={busy || roomOptions.length === 0}
                aria-label="Room"
                data-attr="bookings-block-room"
              >
                <option value="">{roomOptions.length === 0 ? "Whole home" : "Whole home (every room)"}</option>
                {roomOptions.map((room) => (
                  <option key={room.value} value={room.value}>
                    {room.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>

        <div hidden={stepId !== "when"}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="bookings-block-check-in">
                Move in
              </label>
              <Input
                id="bookings-block-check-in"
                type="date"
                value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)}
                disabled={busy}
                data-attr="bookings-block-check-in"
              />
            </div>
            <div className={PORTAL_MODAL_FORM_FIELD_CLASS}>
              <label className={MODAL_FIELD_LABEL_CLASS} htmlFor="bookings-block-check-out">
                Move out
              </label>
              <Input
                id="bookings-block-check-out"
                type="date"
                value={checkOut}
                min={checkIn || undefined}
                onChange={(e) => setCheckOut(e.target.value)}
                disabled={busy}
                aria-invalid={checkIn && checkOut && !rangeValid ? true : undefined}
                data-attr="bookings-block-check-out"
              />
            </div>
          </div>
          {checkIn && checkOut && !rangeValid ? (
            <p className="mt-3 text-xs text-[var(--status-overdue-fg)]" role="alert">
              Move out must be after move in.
            </p>
          ) : null}
          {conflicts.length > 0 ? (
            <div
              role="alert"
              className="mt-4 rounded-lg border px-3 py-2 text-sm portal-banner-danger"
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
        </div>

        <div hidden={stepId !== "review"}>
          <dl className="divide-y divide-border">
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="text-sm text-muted">Property</dt>
              <dd className="text-right text-sm font-semibold text-foreground">{selectedProperty?.label || "—"}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="text-sm text-muted">Room</dt>
              <dd className="text-right text-sm font-semibold text-foreground">
                {selectedRoom?.label || (propertyId ? "Whole home" : "—")}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="text-sm text-muted">Resident</dt>
              <dd className="text-right text-sm font-semibold text-foreground">{residentSummary}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="text-sm text-muted">When</dt>
              <dd className="text-right text-sm font-semibold text-foreground">{checkIn && checkOut ? whenSummary : "—"}</dd>
            </div>
            {reason.trim() ? (
              <div className="flex items-start justify-between gap-4 py-3">
                <dt className="text-sm text-muted">Reason</dt>
                <dd className="text-right text-sm font-semibold text-foreground">{reason.trim()}</dd>
              </div>
            ) : null}
          </dl>

          {existingBlocks.length > 0 ? (
            <ul className="mt-4 overflow-hidden rounded-xl border border-border" data-attr="bookings-sheet-existing-blocks">
              {existingBlocks.map((entry) => {
                const name = formatBookingStayRange(entry.start, entry.end, entry.openEnded);
                const subtitle = [entry.summary, entry.roomLabel, entry.propertyLabel].filter(Boolean).join(" · ");
                return (
                  <li
                    key={entry.blockId}
                    className="flex items-center gap-2 border-b border-border px-3 py-2 last:border-b-0"
                    data-attr={`bookings-sheet-block-${entry.blockId}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-foreground">{name}</p>
                      <p className="truncate text-xs text-muted">{subtitle}</p>
                    </div>
                    <BookingsRowOverflow
                      label={name}
                      onEditDates={() => {
                        applyEditingBlock(
                          entry,
                          setPropertyId,
                          setRoomChoice,
                          setCheckIn,
                          setCheckOut,
                          setReason,
                          setResidentChoice,
                          setNewResidentName,
                          setNewResidentPhone,
                          setEditingBlockId,
                          residentOptions,
                        );
                        setStepIdx(2);
                      }}
                      onCancel={
                        onDeleteBlock && entry.blockId
                          ? () => void onDeleteBlock(entry.blockId!)
                          : undefined
                      }
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}

          {error ? (
            <p role="alert" className="mt-4 rounded-lg border px-3 py-2 text-sm portal-banner-danger">
              {error}
            </p>
          ) : null}
          {inviteResult ? (
            <p className="mt-4 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-foreground" data-attr="bookings-invite-result">
              {inviteResult}
            </p>
          ) : null}
        </div>
      </AddWorkspace>
    </div>
  );
}
