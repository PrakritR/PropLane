"use client";

import { useWorkspaceDraft } from "@/components/portal/add-workspace/draft";

/**
 * Add booking — the same AddWorkspace as Add task (PLAN-0922-1225).
 * Link calendars is its own PortalDialog in channel-calendar-link-modal.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { Input, Select } from "@/components/ui/input";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import { bookingCancelLabel, canRemoveBooking } from "@/lib/channel-calendar/booking-presentation";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { POPUP_FIELD_LABEL_CLASS, POPUP_FIELD_LINK_CLASS } from "@/components/portal/popup-phone-styles";
import {
  PORTAL_MODAL_FORM_FIELD_CLASS,
  PORTAL_MODAL_FORM_FULL_ROW_CLASS,
} from "@/components/ui/modal";
import {
  bookingConflictsFor,
  lastNightBeforeCheckout,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { getPropertyById, getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import { stayTimeOptions } from "@/lib/bookings/stay-time-options";
import { normalizePropertyStayTimes } from "@/lib/bookings/stay-times";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";
import { airbnbLinkForRoom, type ChannelRoomLink } from "@/lib/channel-calendar/channel-links";
import { roomDateBlockNameError } from "@/lib/channel-calendar/room-block-name-rule";
import { cn } from "@/lib/utils";

const FIELD_LINK = POPUP_FIELD_LINK_CLASS;

/** Stable defaults: an inline `[]` default is a new array every render and would retrigger the open effect forever. */
const NO_RESIDENTS: readonly BlockDatesResidentOption[] = [];
const NO_CHANNEL_LINKS: readonly ChannelRoomLink[] = [];

/** The select's value for "new resident" — never a real identity key, which are `email:` / `name:` / `id:` prefixed. */
export const NEW_RESIDENT_CHOICE = "__new__";
/** The select's value for a room closed with no guest — a reason is required instead of a name. */
export const CLOSED_ROOM_CHOICE = "__closed__";

export type BlockDatesDraft = {
  openEnded?: boolean;
  isBookingResidency?: boolean;
  bookingStatus?: PropertyBookingEntry["bookingStatus"];
  rate?: number;
  rateBasis?: PropertyBookingEntry["rateBasis"];
  stayDetails?: PropertyBookingEntry["stayDetails"];
  /** "HH:MM" property wall time. Left out = the property's standard time (or, on an edit, the stored row's). */
  checkInTime?: string;
  checkOutTime?: string;
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
  /** "closed" = no guest, the room is shut and `reason` says why. Only set with an empty `residentName`. */
  blockKind?: "closed";
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
    // A block with nobody attached is a closed room; its reason is what stays editable.
    setResidentChoice(entry.blockKind === "closed" || entry.reason?.trim() ? CLOSED_ROOM_CHOICE : "");
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
  initialCheckOut,
  initialResident,
  initialReason,
  readsPending = false,
  editingBlock = null,
  entries,
  residentOptions = NO_RESIDENTS,
  onSave,
  onRemoveBooking,
  onDeleteBlock,
  mode = "add",
  channelLinks = NO_CHANNEL_LINKS,
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  initialRoomId?: string;
  /** Day the manager clicked in the calendar — becomes check-in, with check-out the next day. */
  initialDayKey?: string | null;
  /** Check-out to open on (Quick book from an application); absent = the day after check-in. */
  initialCheckOut?: string | null;
  /** Someone to hold the room for (Quick book): matched to a resident on the books by email, else a new resident. */
  initialResident?: { name: string; email: string; phone?: string } | null;
  /** Pre-filled reason, e.g. "Application AXIS-123". */
  initialReason?: string;
  /**
   * The Bookings reads behind `entries` / `residentOptions` have not all answered yet. Both lists are
   * the only guard the save has — `entries` is the collision check and `residentOptions` decides
   * whether the prefilled applicant is a NEW resident (and so gets an account-setup invite) — so while
   * this is true the sheet opens and fills but will not save.
   */
  readsPending?: boolean;
  editingBlock?: PropertyBookingEntry | null;
  /** Everything already on the calendar, for the collision check and the hold list. */
  entries: readonly PropertyBookingEntry[];
  /** People the room can be held for. Empty is fine — "New resident" still works. */
  residentOptions?: readonly BlockDatesResidentOption[];
  onSave: (draft: BlockDatesDraft) => Promise<BlockDatesSaveResult>;
  /**
   * The one removal decision, owned by the host: a marked reservation goes to the Delete confirm,
   * a block held for a named person to the cancel dialog. The hold list gates on
   * `canRemoveBooking` first, exactly as the list row, the day row and the Edit sheet's footer do.
   */
  onRemoveBooking?: (entry: PropertyBookingEntry) => void;
  /**
   * Legacy: delete the block outright by id, with no confirm. Only Quick book (which renders no
   * removal dialogs of its own) still uses it, and only when `onRemoveBooking` is absent.
   */
  onDeleteBlock?: (blockId: string) => Promise<boolean | void>;
  /**
   * "reserve" is a click on an empty room-day: titled Mark reserved, opens on the
   * review step with the house, room and night already filled, and saves with one press.
   */
  mode?: "add" | "reserve";
  /** Rooms linked to a channel, so the review can say Airbnb picks the change up. */
  channelLinks?: readonly ChannelRoomLink[];
}) {
  const initialResidentName = initialResident?.name?.trim() ?? "";
  const initialResidentEmail = initialResident?.email?.trim() ?? "";
  const initialResidentPhone = initialResident?.phone?.trim() ?? "";
  /**
   * The option lists are read inside the reset effect but deliberately NOT among its dependencies: both
   * are memos whose identity changes while the Bookings reads land (and `propertyOptions` is rebuilt on
   * every parent render), and re-running the reset would wipe whatever the manager has already typed.
   * Only `soloPropertyOptionId` — the one thing about them the reset actually decides on — is a dependency.
   */
  const residentOptionsRef = useRef(residentOptions);
  const soloPropertyOptionId = propertyOptions.length === 1 ? propertyOptions[0]!.id : "";
  /** Who the sheet still owes a match against the resident list, once that list arrives. */
  const pendingResidentMatch = useRef<{ email: string; name: string } | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [propertyId, setPropertyId] = useState("");
  const [roomChoice, setRoomChoice] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [reason, setReason] = useState("");
  const [stayDetails, setStayDetails] = useState<NonNullable<PropertyBookingEntry["stayDetails"]>>({});
  // "" = not chosen: the dropdowns then read the house's standard times and a new booking stores them.
  const [checkInTime, setCheckInTime] = useState("");
  const [checkOutTime, setCheckOutTime] = useState("");
  const [residentChoice, setResidentChoice] = useState("");
  const [newResidentName, setNewResidentName] = useState("");
  const [newResidentEmail, setNewResidentEmail] = useState("");
  const [newResidentPhone, setNewResidentPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  /** Set after a NEW resident is saved — keeps the workspace open on a confirmation line instead of closing blind. */
  const [inviteResult, setInviteResult] = useState<string | null>(null);

  // Declared BEFORE the reset effect so the ref is already current when that one reads it in the same commit.
  useEffect(() => {
    residentOptionsRef.current = residentOptions;
  }, [residentOptions]);

  useEffect(() => {
    if (!open) return;
    const property = initialPropertyId || soloPropertyOptionId;
    setPropertyId(property);
    setRoomChoice(initialRoomId && property ? `${property}::${initialRoomId}` : "");
    setCheckIn(initialDayKey ?? "");
    setCheckOut(
      initialDayKey ? (initialCheckOut && initialCheckOut > initialDayKey ? initialCheckOut : addDaysToDateKey(initialDayKey, 1)) : "",
    );
    setStepIdx(mode === "reserve" && !editingBlock && property && initialDayKey ? 2 : 0);
    setReason(initialReason ?? "");
    setStayDetails(editingBlock?.stayDetails ?? {});
    setCheckInTime(editingBlock?.checkInTime ?? "");
    setCheckOutTime(editingBlock?.checkOutTime ?? "");
    setResidentChoice("");
    setNewResidentName("");
    setNewResidentEmail("");
    setNewResidentPhone("");
    pendingResidentMatch.current = null;
    if (initialResidentName || initialResidentEmail) {
      const email = initialResidentEmail.toLowerCase();
      const match = email ? residentOptionsRef.current.find((option) => option.email.toLowerCase() === email) : undefined;
      if (match) {
        setResidentChoice(match.key);
      } else {
        setResidentChoice(NEW_RESIDENT_CHOICE);
        setNewResidentName(initialResidentName);
        setNewResidentEmail(initialResidentEmail);
        setNewResidentPhone(initialResidentPhone);
        if (email) pendingResidentMatch.current = { email, name: initialResidentName };
      }
    }
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
      residentOptionsRef.current,
    );
    if (editingBlock?.blockId && editingBlock.residentName && !residentOptionsRef.current.some((option) => option.name === editingBlock.residentName)) {
      pendingResidentMatch.current = { email: "", name: editingBlock.residentName };
    }
  }, [open, mode, initialPropertyId, initialRoomId, initialDayKey, initialCheckOut, initialReason, initialResidentName, initialResidentEmail, initialResidentPhone, editingBlock, soloPropertyOptionId]);

  /**
   * The resident list arrives after the sheet opens. Upgrade a prefilled "new resident" to the person
   * already on the books once they show up — and only until the manager picks someone themselves.
   */
  useEffect(() => {
    if (!open) return;
    const pending = pendingResidentMatch.current;
    if (!pending) return;
    const match = residentOptions.find((option) =>
      pending.email ? option.email.toLowerCase() === pending.email : option.name === pending.name,
    );
    if (!match) return;
    pendingResidentMatch.current = null;
    setResidentChoice(match.key);
    setNewResidentName("");
    setNewResidentEmail("");
    setNewResidentPhone("");
  }, [open, residentOptions]);

  /** Any manual resident choice settles it — the late list must not overwrite it. */
  const chooseResident = useCallback((value: string) => {
    pendingResidentMatch.current = null;
    setResidentChoice(value);
  }, []);

  const roomOptions = useMemo(
    () => (propertyId ? getRoomOptionsForProperty(propertyId, { includeUnavailable: true, includeUnnamed: true }) : []),
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
  const isClosed = residentChoice === CLOSED_ROOM_CHOICE;
  // Every booking has a name: a typed or picked resident. A room with no guest is Closed, with a reason.
  const residentValid = isClosed
    ? roomDateBlockNameError({ blockKind: "closed", reason }) === null
    : isNewResident
      ? newResidentName.trim().length > 0 && (newResidentEmail.trim().length > 0 || newResidentPhone.trim().length > 0)
      : pickedResident !== null;

  const canSave = Boolean(propertyId) && rangeValid && conflicts.length === 0 && residentValid && !busy && !readsPending;

  const existingBlocks = useMemo(
    () => entries.filter((entry) => entry.source === "block" && entry.blockId),
    [entries],
  );

  const airbnbLink = airbnbLinkForRoom(channelLinks, propertyId, roomId);
  const reserving = mode === "reserve" && !editingBlockId;
  const selectedProperty = propertyOptions.find((property) => property.id === propertyId) ?? null;
  // The house's standard times: what the Check-in / Check-out dropdowns read until the manager picks their own.
  const houseTimes = normalizePropertyStayTimes(getPropertyById(propertyId)?.listingSubmission?.stayTimes);
  const selectedRoom = roomOptions.find((room) => room.value === roomChoice) ?? null;
  const residentSummary = isClosed
    ? "Closed"
    : isNewResident
      ? newResidentName.trim() || "New resident"
      : pickedResident
        ? pickedResident.name
        : "—";
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
      // A closed room has no guest, whatever was typed into the resident fields before switching.
      if (isClosed) Object.assign(resident, { residentName: "", residentEmail: "", residentPhone: "" });
      const result = await onSave({
        ...(editingBlockId ? { id: editingBlockId } : {}),
        propertyId,
        roomId,
        checkIn,
        checkOut,
        reason,
        ...(isClosed ? { blockKind: "closed" as const } : {}),
        stayDetails,
        ...(checkInTime ? { checkInTime } : {}),
        ...(checkOutTime ? { checkOutTime } : {}),
        bookingStatus: editingBlock?.bookingStatus,
        rate: editingBlock?.rate,
        rateBasis: editingBlock?.rateBasis,
        isBookingResidency: editingBlock?.isBookingResidency,
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
        setStepIdx(2);
      } else {
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save booking. House and move-in are required.");
      setStepIdx(2);
    } finally {
      setBusy(false);
    }
  };

  const workspaceDraft = useWorkspaceDraft({
    scope: `booking:${editingBlock?.blockId ?? initialPropertyId ?? "new"}:${initialRoomId ?? ""}:${initialDayKey ?? ""}`,
    open, value: { stepIdx, propertyId, roomChoice, checkIn, checkOut, reason, residentChoice, newResidentName, newResidentEmail, newResidentPhone, editingBlockId },
    restore: (saved) => { pendingResidentMatch.current = null; setStepIdx(saved.stepIdx); setPropertyId(saved.propertyId); setRoomChoice(saved.roomChoice); setCheckIn(saved.checkIn); setCheckOut(saved.checkOut); setReason(saved.reason); setResidentChoice(saved.residentChoice); setNewResidentName(saved.newResidentName); setNewResidentEmail(saved.newResidentEmail); setNewResidentPhone(saved.newResidentPhone); setEditingBlockId(saved.editingBlockId); },
  });

  if (!open) return null;

  const steps: AddWorkspaceStep[] = [
    {
      id: "property",
      label: "Property",
      incomplete: !propertyId,
    },
    {
      id: "when",
      label: "When",
      incomplete: !rangeValid || conflicts.length > 0,
    },
    {
      id: "review",
      label: "Review",
    },
  ];
  const current = Math.min(stepIdx, steps.length - 1);
  const stepId = steps[current]!.id;

  return (
    <div data-attr="bookings-block-dates-modal">
      <AddWorkspace
        title={editingBlockId ? "Edit booking" : reserving ? "Mark reserved" : "Add booking"}
        steps={steps}
        current={current}
        onJump={setStepIdx}
        onClose={() => { if (!reserving) workspaceDraft.preserve(); (onClose)(); }}
        keepsDraft={!reserving}
        onDiscardDraft={workspaceDraft.clear}
        dirty={reserving ? Boolean(residentChoice || reason) : Boolean(propertyId || checkIn || residentChoice)}
        discardTitle={editingBlockId ? "Discard these edits?" : "Discard this booking?"}
        assistantContext={editingBlockId ? "Edit booking" : "Add booking"}
        assistantScopeKey={editingBlockId ? "edit-booking" : "add-booking"}
        lastLabel={inviteResult ? "Done" : editingBlockId ? "Save booking" : reserving ? "Save" : "Add booking"}
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
        <div hidden={stepId !== "property"} className="sm:space-y-4">
          <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
            <div className={POPUP_FIELD_LABEL_CLASS}>
              Property
            </div>
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
            <div className={`${POPUP_FIELD_LABEL_CLASS} flex items-center`}>
              <span>Resident</span>
              {isNewResident ? (
                <button
                  type="button"
                  className={`ml-auto ${FIELD_LINK}`}
                  disabled={busy}
                  data-attr="bookings-block-resident-pick-list"
                  onClick={() => chooseResident("")}
                >
                  Pick from list instead
                </button>
              ) : (
                <button
                  type="button"
                  className={`ml-auto ${FIELD_LINK}`}
                  disabled={busy}
                  data-attr="bookings-block-resident-new"
                  onClick={() => chooseResident(NEW_RESIDENT_CHOICE)}
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
                onChange={(e) => chooseResident(e.target.value)}
                disabled={busy}
                aria-label="Resident"
                data-attr="bookings-block-resident"
              >
                <option value="">Select resident</option>
                {residentOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.meta ? `${option.name} · ${option.meta}` : option.name}
                  </option>
                ))}
                <option value={NEW_RESIDENT_CHOICE}>+ New resident…</option>
                <option value={CLOSED_ROOM_CHOICE}>Closed (no guest)</option>
              </Select>
            )}
          </div>

          {isClosed ? (
            <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
              <label className={POPUP_FIELD_LABEL_CLASS} htmlFor="bookings-block-closed-reason">
                Reason
              </label>
              <Input
                id="bookings-block-closed-reason"
                value={reason}
                maxLength={200}
                placeholder="Painting, Owner use"
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
                aria-invalid={reason.trim() && !residentValid ? true : undefined}
                data-attr="bookings-block-closed-reason"
              />
            </div>
          ) : null}

          {propertyId ? (
            <div className={cn(PORTAL_MODAL_FORM_FIELD_CLASS, PORTAL_MODAL_FORM_FULL_ROW_CLASS)}>
              <div className={POPUP_FIELD_LABEL_CLASS}>
                Room
              </div>
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
              <label className={POPUP_FIELD_LABEL_CLASS} htmlFor="bookings-block-check-in">
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
              <label className={POPUP_FIELD_LABEL_CLASS} htmlFor="bookings-block-check-out">
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
          <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div><span className={POPUP_FIELD_LABEL_CLASS}>Source</span><Select aria-label="Source" id="booking-stay-source" value={stayDetails.source ?? "Direct"} disabled={busy} onChange={(event) => setStayDetails({ ...stayDetails, source: event.target.value })}>{["Direct", "Tenant", "Airbnb", "Booking.com", "Application", "Other"].map((source) => <option key={source} value={source}>{source}</option>)}</Select></div>
            {isClosed ? null : <label><span className={POPUP_FIELD_LABEL_CLASS}>Notes</span><Input value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>}
            {(["linen", "baggage"] as const).map((key) => <div key={key}><span className={POPUP_FIELD_LABEL_CLASS}>{key === "linen" ? "Linen" : "Baggage"}</span><Select aria-label={key === "linen" ? "Linen" : "Baggage"} id={`booking-stay-${key}`} value={stayDetails[key] ?? ""} disabled={busy} onChange={(event) => setStayDetails({ ...stayDetails, [key]: event.target.value })}><option value="">Not set</option>{(key === "linen" ? ["Requested", "Delivered"] : ["Yes", "No"]).map((value) => <option key={value} value={value}>{value}</option>)}</Select></div>)}
            <div><span className={POPUP_FIELD_LABEL_CLASS}>Check-in</span><Select aria-label="Check-in" id="booking-stay-check-in" value={checkInTime || houseTimes.checkInTime} disabled={busy} onChange={(event) => setCheckInTime(event.target.value)}>{stayTimeOptions(checkInTime || houseTimes.checkInTime).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
            <div><span className={POPUP_FIELD_LABEL_CLASS}>Check-out</span><Select aria-label="Check-out" id="booking-stay-check-out" value={checkOutTime || houseTimes.checkOutTime} disabled={busy} onChange={(event) => setCheckOutTime(event.target.value)}>{stayTimeOptions(checkOutTime || houseTimes.checkOutTime).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</Select></div>
          </div>
        </div>

        <div hidden={stepId !== "review"}>
          <dl className="divide-y divide-border">
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="text-sm text-muted max-lg:text-[16px]">Property</dt>
              <dd className="text-right text-sm font-semibold text-foreground max-lg:text-[16px]">{selectedProperty?.label || "—"}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="text-sm text-muted max-lg:text-[16px]">Room</dt>
              <dd className="text-right text-sm font-semibold text-foreground max-lg:text-[16px]">
                {selectedRoom?.label || (propertyId ? "Whole home" : "—")}
              </dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="text-sm text-muted max-lg:text-[16px]">Resident</dt>
              <dd className="text-right text-sm font-semibold text-foreground max-lg:text-[16px]">{residentSummary}</dd>
            </div>
            <div className="flex items-start justify-between gap-4 py-3">
              <dt className="text-sm text-muted max-lg:text-[16px]">When</dt>
              <dd className="text-right text-sm font-semibold text-foreground max-lg:text-[16px]">{checkIn && checkOut ? whenSummary : "—"}</dd>
            </div>
            {airbnbLink ? (
              <div className="flex items-start justify-between gap-4 py-3" data-attr="bookings-block-airbnb-fact">
                <dt className="text-sm text-muted max-lg:text-[16px]">Airbnb</dt>
                <dd className="text-right text-sm font-semibold text-foreground max-lg:text-[16px]">Updates when Airbnb next checks PropLane</dd>
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
                      <p className="truncate text-sm font-semibold text-foreground max-lg:text-[16px]">{name}</p>
                      <p className="truncate text-xs text-muted max-lg:text-[13px]">{subtitle}</p>
                    </div>
                    <BookingsRowOverflow
                      label={name}
                      onEditDates={() => {
                        pendingResidentMatch.current = null;
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
                        setStepIdx(1);
                      }}
                      onCancel={
                        onRemoveBooking
                          ? canRemoveBooking(entry)
                            ? () => onRemoveBooking(entry)
                            : undefined
                          : onDeleteBlock && entry.blockId
                            ? () => void onDeleteBlock(entry.blockId!)
                            : undefined
                      }
                      cancelLabel={onRemoveBooking ? bookingCancelLabel(entry) : undefined}
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}

          {readsPending ? (
            <p role="status" className="mt-4 text-sm text-muted" data-attr="bookings-block-reads-pending">
              Checking the calendar for these dates…
            </p>
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
