"use client";

import { useState, type ReactNode } from "react";
import { Check, X } from "lucide-react";
import { AddWorkspace, type AddWorkspaceStep } from "@/components/portal/add-workspace";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Input } from "@/components/ui/input";
import { PhoneNumberField } from "@/components/ui/phone-number-field";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import type { BlockDatesDraft } from "@/components/portal/bookings-block-dates-modal";
import { bookingConflictsFor, lastNightBeforeCheckout, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, describeBookingConflict } from "@/lib/channel-calendar/bookings-ui";
import { bookingCancelLabel, bookingRoomRate, canCancelBooking, canDeleteReservation, isReservedBlock } from "@/lib/channel-calendar/booking-presentation";
import { stayMetaRefOf, type StayMeta } from "@/lib/channel-calendar/stay-meta";
import { ROOM_DATE_BLOCKS_CHANGED } from "@/lib/channel-calendar/room-date-blocks";
import { roomDateBlockNameError } from "@/lib/channel-calendar/room-block-name-rule";
import { isShortStayRequestSource } from "@/lib/short-stay/guest-stays";
import { getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";

/**
 * The Room dropdown's choices. A property whose rooms are not configured falls back to its building's units,
 * whose values carry no listing room id: each parsed to "" (the "Whole home" value), so React saw several
 * options keyed "". Only real, distinct room ids are choices; "Whole home" is the one "" option.
 */
export function bookingRoomChoices<C>(
  options: readonly { value: string; label: string }[],
  conflictsFor: (roomId: string) => C[],
): { value: string; label: string; id: string; conflicts: C[] }[] {
  const seen = new Set<string>();
  const out: { value: string; label: string; id: string; conflicts: C[] }[] = [];
  for (const option of options) {
    const id = parseRoomChoiceValue(option.value).listingRoomId ?? "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...option, id, conflicts: conflictsFor(id) });
  }
  return out.sort((a, b) => Number(Boolean(a.conflicts.length)) - Number(Boolean(b.conflicts.length)));
}

/** One section of the form: a heading and its fields. The rail scrolls to it; nothing hides. */
function EditSection({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return <section id={`booking-edit-section-${id}`} data-section={id} className="mb-8 scroll-mt-4"><h3 className="mb-3 text-base font-semibold text-foreground">{label}</h3><div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div></section>;
}

export function BookingsEditSheet({ entry, entries, propertyOptions = [], onClose, onSave, onSaveStayMeta, onDelete }: {
  entry: PropertyBookingEntry; entries: readonly PropertyBookingEntry[]; propertyOptions?: readonly ManagerPropertyFilterOption[];
  onClose: () => void; onSave: (draft: BlockDatesDraft) => Promise<unknown>;
  /** Signed-lease / application stays: notes and stay details save here (authenticated server route); everything else stays locked. */
  onSaveStayMeta?: (meta: StayMeta) => Promise<unknown>;
  /** Footer Delete reservation / Cancel booking: the caller closes this sheet and opens the confirm. */
  onDelete?: (entry: PropertyBookingEntry) => void;
}) {
  const locked = entry.source !== "block" || !entry.blockId || entry.bookingStatus === "cancelled";
  const metaRef = locked && onSaveStayMeta ? stayMetaRefOf(entry) : null;
  // Notes and housekeeping stay editable on a stay whose dates belong to a lease/application.
  const metaOnly = metaRef !== null;
  const lockedDetails = locked && !metaOnly;
  // Marked-reserved dates have nobody attached: no guest, rate, status or stay details - just where, when and a label.
  const reservation = isReservedBlock(entry);
  const initialRate = bookingRoomRate(entry.propertyId, entry.roomId);
  const initialStatus = entry.bookingStatus === "confirmed" ? "confirmed" : "hold";
  const initialRateText = String(entry.rate ?? initialRate.amount ?? "");
  const initialCheckOut = addDaysToDateKey(entry.end, 1);
  const [propertyId, setPropertyId] = useState(entry.propertyId);
  const [roomId, setRoomId] = useState(entry.roomId);
  const [openEnded, setOpenEnded] = useState(Boolean(entry.openEnded));
  const [checkIn, setCheckIn] = useState(entry.start);
  const [checkOut, setCheckOut] = useState(initialCheckOut);
  const [status, setStatus] = useState(initialStatus);
  // The block row stores resident name, email and phone: the Guest section edits exactly those.
  const initialName = entry.residentName ?? entry.summary;
  const [guestName, setGuestName] = useState(initialName);
  const [guestEmail, setGuestEmail] = useState(entry.residentEmail ?? "");
  const [guestPhone, setGuestPhone] = useState(entry.residentPhone ?? "");
  const [rate, setRate] = useState(initialRateText);
  const [basis, setBasis] = useState(entry.rateBasis ?? initialRate.basis);
  const [notes, setNotes] = useState(entry.reason ?? "");
  // Dates with nobody attached are a closed room until a guest is named; every booking has a name.
  const [reservedName, setReservedName] = useState("");
  const [details, setDetails] = useState(entry.stayDetails ?? {});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [section, setSection] = useState(0);
  const valid = Boolean(checkIn && (openEnded || (checkOut && checkOut > checkIn)));
  // A named hold keeps its name: clearing it would silently turn the hold into a reservation.
  // An invited resident (isBookingResidency) is keyed on this email: editing it would detach their account, so the identity stays read-only.
  const guestLocked = locked || entry.isBookingResidency === true;
  const reservationValid = roomDateBlockNameError({ residentName: reservedName, blockKind: "closed", reason: notes }) === null;
  const guestValid = reservation ? reservationValid : locked || guestName.trim().length > 0;
  const pool = entries.filter((candidate) => candidate !== entry && (!entry.blockId || candidate.blockId !== entry.blockId));
  const conflictsForRoom = (id: string) => valid ? bookingConflictsFor(pool, { propertyId, roomId: id, start: checkIn, end: openEnded ? "9999-12-30" : lastNightBeforeCheckout(checkOut) }) : [];
  const rooms = bookingRoomChoices(getRoomOptionsForProperty(propertyId, { includeUnavailable: true, includeUnnamed: true }), conflictsForRoom);
  const conflicts = conflictsForRoom(roomId);
  const properties = propertyOptions.length ? propertyOptions : [{ id: entry.propertyId, label: entry.propertyLabel }];
  const chooseRoom = (id: string, property = propertyId) => { setRoomId(id); if (reservation) return; const next = bookingRoomRate(property, id); setRate(String(next.amount ?? "")); setBasis(next.basis); };
  // A guest's request (portal or public card) is answered with Approve / Decline, not the Status menu.
  const decidable = entry.source === "block" && entry.bookingStatus === "hold" && Boolean(entry.blockId) && isShortStayRequestSource(entry.stayDetails?.source);
  const decide = async (decision: "approve" | "decline") => {
    if (busy || !entry.blockId) return;
    setBusy(true); setError("");
    try {
      const res = await fetch("/api/portal/bookings/short-stay-decision", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ blockId: entry.blockId, decision }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(typeof body.error === "string" && body.error ? body.error : "Could not save that answer.");
      }
      window.dispatchEvent(new Event(ROOM_DATE_BLOCKS_CHANGED));
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save that answer."); }
    finally { setBusy(false); }
  };
  const rateValid = rate === "" || (Number.isFinite(Number(rate)) && Number(rate) >= 0);
  const dirty = guestName !== initialName || guestEmail !== (entry.residentEmail ?? "") || guestPhone !== (entry.residentPhone ?? "") || propertyId !== entry.propertyId || roomId !== entry.roomId || openEnded !== Boolean(entry.openEnded) || checkIn !== entry.start || checkOut !== initialCheckOut || status !== initialStatus || rate !== initialRateText || basis !== (entry.rateBasis ?? initialRate.basis) || notes !== (entry.reason ?? "") || reservedName !== "" || JSON.stringify(details) !== JSON.stringify(entry.stayDetails ?? {});
  const save = async () => {
    if (lockedDetails) { onClose(); return; }
    if (metaRef && onSaveStayMeta) {
      if (busy) return;
      setBusy(true); setError("");
      try {
        const { source: _source, ...housekeeping } = details;
        void _source;
        await onSaveStayMeta({ kind: metaRef.kind, refId: metaRef.refId, notes, stayDetails: housekeeping });
        onClose();
      } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save booking."); }
      finally { setBusy(false); }
      return;
    }
    if (locked || !valid || !guestValid || !rateValid || conflicts.length || busy) return;
    setBusy(true); setError("");
    try {
      await onSave(reservation
        ? { id: entry.blockId, openEnded, propertyId, roomId, checkIn, checkOut, residentName: reservedName.trim(), residentEmail: "", reason: notes, ...(reservedName.trim() ? {} : { blockKind: "closed" as const }), bookingStatus: entry.bookingStatus ?? "confirmed", rate: entry.rate, rateBasis: entry.rateBasis, stayDetails: entry.stayDetails }
        : { id: entry.blockId, isBookingResidency: entry.isBookingResidency, openEnded, propertyId, roomId, checkIn, checkOut, residentName: guestName.trim(), residentEmail: guestEmail.trim(), residentPhone: guestPhone, reason: notes, bookingStatus: status as "hold" | "confirmed", rate: rate === "" ? undefined : Number(rate), rateBasis: basis, stayDetails: details });
      onClose();
    }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save booking."); }
    finally { setBusy(false); }
  };
  const rateUnit = basis === "daily" ? "day" : basis === "weekly" ? "week" : "month";
  const sections: (AddWorkspaceStep & { id: string })[] = [
    ...(reservation ? [] : [{ id: "guest", label: "Guest" }]),
    { id: "where", label: "Where", incomplete: !lockedDetails && conflicts.length > 0 },
    { id: "when", label: "When", incomplete: !lockedDetails && !valid },
    ...(reservation ? [{ id: "label", label: "Label" }] : [
      { id: "rate", label: "Rate", incomplete: !rateValid },
      { id: "details", label: "Stay details" },
    ]),
  ];
  const showDelete = Boolean(onDelete) && !locked && (canDeleteReservation(entry) || canCancelBooking(entry));
  const jump = (index: number) => {
    setSection(index);
    const node = document.getElementById(`booking-edit-section-${sections[index]?.id}`);
    node?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };
  const has = (id: string) => sections.some((candidate) => candidate.id === id);
  return <div data-attr="bookings-edit-sheet"><AddWorkspace
    title={reservation ? "Edit reservation" : "Edit booking"}
    steps={sections}
    current={Math.min(section, sections.length - 1)}
    onJump={jump}
    tabRail
    finishCount={0}
    hideFooterStepCount
    onClose={onClose}
    dirty={dirty}
    discardTitle="Discard these edits?"
    saveState={busy ? "Saving…" : dirty ? "Unsaved changes" : "No changes"}
    assistantContext={reservation ? "Edit reservation" : "Edit booking"}
    assistantScopeKey="edit-booking"
    lastLabel={lockedDetails ? "Close" : "Save"}
    lastDisabled={lockedDetails ? false : metaOnly ? busy : !valid || !guestValid || Boolean(conflicts.length) || busy || !rateValid}
    busy={busy}
    onFinish={() => void save()}
    dangerAction={showDelete ? <Button type="button" variant="danger" disabled={busy} data-attr="bookings-edit-delete" onClick={() => onDelete?.(entry)}>{bookingCancelLabel(entry)}</Button> : undefined}
    headerActions={decidable ? <span className="flex items-center" data-attr="bookings-short-stay-decision"><PortalIconAction icon={Check} label="Approve" tone="primary" disabled={busy} onClick={() => void decide("approve")} data-attr="bookings-short-stay-approve" /><PortalIconAction icon={X} label="Decline" tone="danger" disabled={busy} onClick={() => void decide("decline")} data-attr="bookings-short-stay-decline" /></span> : undefined}
    dataAttrPrefix="bookings-edit"
    finishDataAttr="bookings-edit-save"
  >
    {has("guest") ? <EditSection id="guest" label="Guest">
      <label><span className={MODAL_FIELD_LABEL_CLASS}>Name</span><Input disabled={guestLocked || busy} maxLength={120} value={guestName} onChange={(event) => setGuestName(event.target.value)} /></label>
      <label><span className={MODAL_FIELD_LABEL_CLASS}>Email</span><Input type="email" disabled={guestLocked || busy} maxLength={200} value={guestEmail} onChange={(event) => setGuestEmail(event.target.value)} /></label>
      <div><span className={MODAL_FIELD_LABEL_CLASS}>Phone</span><PhoneNumberField id="booking-edit-phone" value={guestPhone} onChange={setGuestPhone} disabled={guestLocked || busy} dataAttr="booking-edit-phone" /></div>
      <FieldSingleSelect label="Status" dataAttr="select-booking-edit-status" disabled={locked || busy || decidable} value={status} onChange={setStatus} options={[{ value: "hold", label: "Hold" }, { value: "confirmed", label: "Confirmed" }]} />
    </EditSection> : null}
    <EditSection id="where" label="Where">
      <FieldSingleSelect label="Property" dataAttr="select-booking-edit-property" disabled={locked || busy} value={propertyId} onChange={(next) => { setPropertyId(next); chooseRoom("", next); }} options={properties.map((property) => ({ value: property.id, label: property.label }))} />
      <FieldSingleSelect label="Room" dataAttr="select-booking-edit-room" disabled={locked || busy} value={roomId} onChange={(next) => chooseRoom(next)} options={[{ value: "", label: "Whole home" }, ...rooms.map((room) => ({ value: room.id, label: `${room.label}${room.conflicts.length ? " · Booked" : ""}` }))]} />
    </EditSection>
    <EditSection id="when" label="When">
      <label><span className={MODAL_FIELD_LABEL_CLASS}>Check-in</span><Input type="date" disabled={locked || busy} value={checkIn} onChange={(event) => setCheckIn(event.target.value)} /></label>
      <label><span className={MODAL_FIELD_LABEL_CLASS}>Check-out</span><Input type="date" disabled={locked || busy || openEnded} value={openEnded ? "" : checkOut} onChange={(event) => setCheckOut(event.target.value)} /></label>
      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" role="switch" checked={openEnded} disabled={locked || busy} onChange={(event) => setOpenEnded(event.target.checked)} />Open-ended</label>
      {conflicts.length && !locked ? <p className="text-sm text-danger sm:col-span-2" role="alert" data-bk-alert>{describeBookingConflict(conflicts[0], conflicts[0].roomLabel)}</p> : null}
    </EditSection>
    {reservation ? <EditSection id="label" label="Label">
      <label className="sm:col-span-2"><span className={MODAL_FIELD_LABEL_CLASS}>Guest name</span><Input disabled={busy} maxLength={120} value={reservedName} onChange={(event) => setReservedName(event.target.value)} /></label>
      <label className="sm:col-span-2"><span className={MODAL_FIELD_LABEL_CLASS}>{reservedName.trim() ? "Notes" : "Reason"}</span><Input disabled={busy} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    </EditSection> : <>
      <EditSection id="rate" label="Rate">
        <label><span className={MODAL_FIELD_LABEL_CLASS}>Rate / {rateUnit}</span><Input type="number" min="0" step="0.01" disabled={locked || busy} value={rate} onChange={(event) => setRate(event.target.value)} /></label>
      </EditSection>
      <EditSection id="details" label="Stay details">
        <FieldSingleSelect label="Source" dataAttr="select-booking-edit-source" disabled={locked || busy || decidable} value={details.source ?? "Direct"} onChange={(next) => setDetails({ ...details, source: next })} options={[...["Direct", "Tenant", "Airbnb", "Booking.com", "Application", "Other"].map((value) => ({ value, label: value })), ...(isShortStayRequestSource(details.source) ? [{ value: details.source as string, label: details.source === "guest_portal" ? "Guest portal" : "Public request" }] : [])]} />
        <label><span className={MODAL_FIELD_LABEL_CLASS}>Notes</span><Input disabled={lockedDetails || busy} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
        {(["linen", "baggage"] as const).map((key) => <FieldSingleSelect key={key} label={key === "linen" ? "Linen" : "Baggage"} dataAttr={`select-booking-edit-${key}`} disabled={lockedDetails || busy} value={details[key] ?? ""} onChange={(next) => setDetails({ ...details, [key]: next })} options={[{ value: "", label: "Not set" }, ...(key === "linen" ? ["Requested", "Delivered"] : ["Yes", "No"]).map((value) => ({ value, label: value }))]} />)}
        {(["earlyCheckIn", "lateCheckOut"] as const).map((key) => <label key={key}><span className={MODAL_FIELD_LABEL_CLASS}>{key === "earlyCheckIn" ? "Early check-in" : "Late check-out"}</span><Input type="time" disabled={lockedDetails || busy} value={details[key] ?? ""} onChange={(event) => setDetails({ ...details, [key]: event.target.value })} /></label>)}
      </EditSection>
    </>}
    {error ? <p role="alert" className="text-danger">{error}</p> : null}
  </AddWorkspace></div>;
}
