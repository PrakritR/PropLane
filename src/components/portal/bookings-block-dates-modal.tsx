"use client";

/**
 * Bookings calendar sheet — Add booking and Link calendars in one dialog.
 * A segmented control switches the pane; there are not two stacked modals.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { RadixSegmentedTabs } from "@/components/ui/radix-segmented-tabs";
import { BookingsRowOverflow } from "@/components/portal/bookings-row-overflow";
import {
  ChannelCalendarLinkFields,
  type ChannelCalendarLinkActions,
  type ChannelCalendarLinkFooterState,
} from "@/components/portal/channel-calendar-link-modal";
import {
  bookingConflictsFor,
  lastNightBeforeCheckout,
  type PropertyBookingEntry,
} from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";
import type { BlockDatesResidentOption } from "@/lib/channel-calendar/block-dates-residents";

const FIELD_LABEL = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";
const FIELD_LINK = "text-xs font-semibold normal-case tracking-normal text-primary hover:underline disabled:opacity-50";

/** The select's value for "new resident" — never a real identity key, which are `email:` / `name:` / `id:` prefixed. */
export const NEW_RESIDENT_CHOICE = "__new__";

export type BookingsSheetPane = "block" | "airbnb";

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
};

function applyEditingBlock(
  entry: PropertyBookingEntry | null | undefined,
  setPropertyId: (id: string) => void,
  setRoomChoice: (value: string) => void,
  setCheckIn: (value: string) => void,
  setCheckOut: (value: string) => void,
  setReason: (value: string) => void,
  setResidentChoice: (value: string) => void,
  setNewResidentName: (value: string) => void,
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
  } else if (entry.residentName) {
    setResidentChoice(NEW_RESIDENT_CHOICE);
    setNewResidentName(entry.residentName);
  } else {
    setResidentChoice("");
    setNewResidentName("");
  }
}

export function BookingsBlockDatesModal({
  open,
  onClose,
  propertyOptions,
  initialPropertyId,
  initialRoomId = "",
  initialDayKey,
  initialPane = "block",
  pane: paneProp,
  onPaneChange,
  editingBlock = null,
  entries,
  residentOptions = [],
  onSave,
  onDeleteBlock,
  propertyIds,
  showToast,
  onAirbnbChanged,
}: {
  open: boolean;
  onClose: () => void;
  propertyOptions: ManagerPropertyFilterOption[];
  initialPropertyId?: string;
  initialRoomId?: string;
  /** Day the manager clicked in the calendar — becomes check-in, with check-out the next day. */
  initialDayKey?: string | null;
  initialPane?: BookingsSheetPane;
  pane?: BookingsSheetPane;
  onPaneChange?: (pane: BookingsSheetPane) => void;
  editingBlock?: PropertyBookingEntry | null;
  /** Everything already on the calendar, for the collision check and the hold list. */
  entries: readonly PropertyBookingEntry[];
  /** People the room can be held for. Empty is fine — "New resident" still works. */
  residentOptions?: readonly BlockDatesResidentOption[];
  onSave: (draft: BlockDatesDraft) => Promise<void>;
  onDeleteBlock?: (blockId: string) => Promise<void>;
  propertyIds?: string[];
  showToast?: (message: string) => void;
  onAirbnbChanged?: () => void;
}) {
  const [internalPane, setInternalPane] = useState<BookingsSheetPane>(initialPane);
  const pane = paneProp ?? internalPane;
  const setPane = (next: BookingsSheetPane) => {
    onPaneChange?.(next);
    if (paneProp == null) setInternalPane(next);
  };

  const [propertyId, setPropertyId] = useState("");
  const [roomChoice, setRoomChoice] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [reason, setReason] = useState("");
  const [residentChoice, setResidentChoice] = useState("");
  const [newResidentName, setNewResidentName] = useState("");
  const [newResidentEmail, setNewResidentEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);

  const [airbnbFooter, setAirbnbFooter] = useState<ChannelCalendarLinkFooterState>({
    canSave: false,
    busy: false,
    syncing: false,
    syncableCount: 0,
  });
  const airbnbActionsRef = useRef<ChannelCalendarLinkActions | null>(null);

  useEffect(() => {
    if (!open) return;
    setInternalPane(paneProp ?? initialPane);
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
    applyEditingBlock(
      editingBlock,
      setPropertyId,
      setRoomChoice,
      setCheckIn,
      setCheckOut,
      setReason,
      setResidentChoice,
      setNewResidentName,
      setEditingBlockId,
      residentOptions,
    );
    // Reset the form when the sheet opens, not when the manager switches panes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialPropertyId, initialRoomId, initialDayKey, initialPane, editingBlock, propertyOptions, residentOptions]);

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
  const residentValid = !isNewResident || newResidentName.trim().length > 0;

  const canSave = Boolean(propertyId) && rangeValid && conflicts.length === 0 && residentValid && !busy;

  const existingBlocks = useMemo(
    () => entries.filter((entry) => entry.source === "block" && entry.blockId),
    [entries],
  );

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
      await onSave({
        ...(editingBlockId ? { id: editingBlockId } : {}),
        propertyId,
        roomId,
        checkIn,
        checkOut,
        reason,
        ...resident,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save booking. House and move-in are required.");
    } finally {
      setBusy(false);
    }
  };

  const airbnbBusy = airbnbFooter.busy || airbnbFooter.syncing;
  const airbnbIds = propertyIds ?? propertyOptions.map((property) => property.id);

  const footer =
    pane === "airbnb" ? (
      <ModalFooter className="justify-start">
        <Button
          type="button"
          variant="outline"
          disabled={airbnbBusy || airbnbFooter.syncableCount === 0}
          data-attr="channel-calendar-sync-all"
          onClick={() => void airbnbActionsRef.current?.syncAll()}
        >
          {airbnbFooter.syncing ? "Syncing…" : "Sync all"}
        </Button>
        <Button
          type="button"
          variant="primary"
          disabled={!airbnbFooter.canSave || airbnbBusy}
          data-attr="channel-calendar-save-link"
          onClick={() => void airbnbActionsRef.current?.save()}
        >
          {airbnbFooter.busy ? "Saving…" : "Save & sync"}
        </Button>
      </ModalFooter>
    ) : (
      <ModalFooter>
        <Button
          type="button"
          variant="primary"
          disabled={!canSave}
          data-attr="bookings-block-dates-save"
          onClick={() => save()}
        >
          {busy ? "Saving…" : "Add booking"}
        </Button>
      </ModalFooter>
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={pane === "airbnb" ? "Link calendars" : "Add booking"}
      dataAttr="bookings-block-dates-modal"
      footer={footer}
    >
      <div className="space-y-4">
        <RadixSegmentedTabs
          ariaLabel="Bookings calendar actions"
          activeId={pane}
          onChange={(id) => setPane(id as BookingsSheetPane)}
          items={[
            { id: "block", label: "Add booking", dataAttr: "bookings-sheet-pane-block" },
            { id: "airbnb", label: "Link calendars", dataAttr: "bookings-sheet-pane-airbnb" },
          ]}
        />

        <div hidden={pane !== "block"} className="space-y-4">
          <label className="block">
            <span className={FIELD_LABEL}>House</span>
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

          {existingBlocks.length > 0 ? (
            <ul className="overflow-hidden rounded-xl border border-border" data-attr="bookings-sheet-existing-blocks">
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
                      onEdit={() =>
                        applyEditingBlock(
                          entry,
                          setPropertyId,
                          setRoomChoice,
                          setCheckIn,
                          setCheckOut,
                          setReason,
                          setResidentChoice,
                          setNewResidentName,
                          setEditingBlockId,
                          residentOptions,
                        )
                      }
                      onDelete={
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
              <span className={FIELD_LABEL}>Move in</span>
              <Input
                type="date"
                value={checkIn}
                onChange={(e) => setCheckIn(e.target.value)}
                disabled={busy}
                data-attr="bookings-block-check-in"
              />
            </label>
            <label className="block">
              <span className={FIELD_LABEL}>Move out</span>
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
              Move out must be after move in.
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

        <div hidden={pane !== "airbnb"}>
          <ChannelCalendarLinkFields
            active={open && pane === "airbnb"}
            propertyIds={airbnbIds}
            propertyOptions={propertyOptions}
            initialPropertyId={initialPropertyId}
            showToast={showToast ?? (() => {})}
            onChanged={onAirbnbChanged}
            onFooterState={setAirbnbFooter}
            actionsRef={airbnbActionsRef}
          />
        </div>
      </div>
    </Modal>
  );
}
