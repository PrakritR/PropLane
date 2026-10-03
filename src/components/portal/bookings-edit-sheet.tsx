"use client";

import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Input, Select } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import type { BlockDatesDraft } from "@/components/portal/bookings-block-dates-modal";
import { bookingConflictsFor, lastNightBeforeCheckout, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, describeBookingConflict } from "@/lib/channel-calendar/bookings-ui";
import { bookingRoomRate } from "@/lib/channel-calendar/booking-presentation";
import { getRoomOptionsForProperty, parseRoomChoiceValue } from "@/lib/rental-application/data";
import type { ManagerPropertyFilterOption } from "@/lib/manager-portfolio-access";

export function BookingsEditSheet({ entry, entries, propertyOptions = [], onClose, onSave }: {
  entry: PropertyBookingEntry; entries: readonly PropertyBookingEntry[]; propertyOptions?: readonly ManagerPropertyFilterOption[];
  onClose: () => void; onSave: (draft: BlockDatesDraft) => Promise<unknown>;
}) {
  const locked = entry.source !== "block" || !entry.blockId || entry.bookingStatus === "cancelled";
  const initialRate = bookingRoomRate(entry.propertyId, entry.roomId);
  const [propertyId, setPropertyId] = useState(entry.propertyId);
  const [roomId, setRoomId] = useState(entry.roomId);
  const [openEnded, setOpenEnded] = useState(Boolean(entry.openEnded));
  const [checkIn, setCheckIn] = useState(entry.start);
  const [checkOut, setCheckOut] = useState(addDaysToDateKey(entry.end, 1));
  const [status, setStatus] = useState(entry.bookingStatus === "confirmed" ? "confirmed" : "hold");
  const [rate, setRate] = useState(String(entry.rate ?? initialRate.amount ?? ""));
  const [basis, setBasis] = useState(entry.rateBasis ?? initialRate.basis);
  const [notes, setNotes] = useState(entry.reason ?? "");
  const [details, setDetails] = useState(entry.stayDetails ?? {});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = Boolean(checkIn && (openEnded || (checkOut && checkOut > checkIn)));
  const pool = entries.filter((candidate) => candidate !== entry && (!entry.blockId || candidate.blockId !== entry.blockId));
  const conflictsForRoom = (id: string) => valid ? bookingConflictsFor(pool, { propertyId, roomId: id, start: checkIn, end: openEnded ? "9999-12-30" : lastNightBeforeCheckout(checkOut) }) : [];
  const rooms = getRoomOptionsForProperty(propertyId, { includeUnavailable: true }).map((option) => ({ ...option, id: parseRoomChoiceValue(option.value).listingRoomId ?? "", conflicts: conflictsForRoom(parseRoomChoiceValue(option.value).listingRoomId ?? "") })).sort((a, b) => Number(Boolean(a.conflicts.length)) - Number(Boolean(b.conflicts.length)));
  const conflicts = conflictsForRoom(roomId);
  const properties = propertyOptions.length ? propertyOptions : [{ id: entry.propertyId, label: entry.propertyLabel }];
  const chooseRoom = (id: string, property = propertyId) => { setRoomId(id); const next = bookingRoomRate(property, id); setRate(String(next.amount ?? "")); setBasis(next.basis); };
  const rateValid = rate === "" || (Number.isFinite(Number(rate)) && Number(rate) >= 0);
  const save = async () => {
    if (locked || !valid || !rateValid || conflicts.length || busy) return;
    setBusy(true); setError("");
    try { await onSave({ id: entry.blockId, isBookingResidency: entry.isBookingResidency, openEnded, propertyId, roomId, checkIn, checkOut, residentName: entry.residentName ?? entry.summary, residentEmail: entry.residentEmail ?? "", residentPhone: entry.residentPhone, reason: notes, bookingStatus: status as "hold" | "confirmed", rate: rate === "" ? undefined : Number(rate), rateBasis: basis, stayDetails: details }); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save booking."); }
    finally { setBusy(false); }
  };
  return <PortalDialog open onClose={onClose} title="Edit booking" dataAttr="bookings-edit-sheet" primaryAction={locked ? null : { label: "Save booking", onClick: save, disabled: !valid || Boolean(conflicts.length) || busy || !rateValid, loading: busy }}>
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2"><span className={MODAL_FIELD_LABEL_CLASS}>Guest</span><div className="py-2 font-medium">{entry.residentName || entry.summary}</div></div>
      <label htmlFor="booking-edit-property"><span className={MODAL_FIELD_LABEL_CLASS}>Property</span><Select id="booking-edit-property" disabled={locked || busy} value={propertyId} onChange={(event) => { setPropertyId(event.target.value); chooseRoom("", event.target.value); }}>{properties.map((property) => <option key={property.id} value={property.id}>{property.label}</option>)}</Select></label>
      <label htmlFor="booking-edit-room"><span className={MODAL_FIELD_LABEL_CLASS}>Room</span><Select id="booking-edit-room" disabled={locked || busy} value={roomId} onChange={(event) => chooseRoom(event.target.value)}><option value="">Whole home</option>{rooms.map((room) => <option key={room.id} value={room.id}>{room.label}{room.conflicts.length ? " · Booked" : ""}</option>)}</Select></label>
      <label><span className={MODAL_FIELD_LABEL_CLASS}>Check-in</span><Input type="date" disabled={locked || busy} value={checkIn} onChange={(event) => setCheckIn(event.target.value)} /></label>
      <label><span className={MODAL_FIELD_LABEL_CLASS}>Check-out</span><Input type="date" disabled={locked || busy || openEnded} value={openEnded ? "" : checkOut} onChange={(event) => setCheckOut(event.target.value)} /></label>
      <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" role="switch" checked={openEnded} disabled={locked || busy} onChange={(event) => setOpenEnded(event.target.checked)} />Open-ended</label>
      <label htmlFor="booking-edit-status"><span className={MODAL_FIELD_LABEL_CLASS}>Status</span><Select id="booking-edit-status" disabled={locked || busy} value={status} onChange={(event) => setStatus(event.target.value)}><option value="hold">Hold</option><option value="confirmed">Confirmed</option></Select></label>
      <label><span className={MODAL_FIELD_LABEL_CLASS}>Rate / {basis === "daily" ? "day" : basis === "weekly" ? "week" : "month"}</span><Input type="number" min="0" step="0.01" disabled={locked || busy} value={rate} onChange={(event) => setRate(event.target.value)} /></label>
      <label className="sm:col-span-2"><span className={MODAL_FIELD_LABEL_CLASS}>Notes</span><Input disabled={locked || busy} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
      <label htmlFor="booking-edit-source"><span className={MODAL_FIELD_LABEL_CLASS}>Source</span><Select id="booking-edit-source" disabled={locked || busy} value={details.source ?? "Direct"} onChange={(event) => setDetails({ ...details, source: event.target.value })}>{["Direct", "Tenant", "Airbnb", "Booking.com", "Application", "Other"].map((value) => <option key={value}>{value}</option>)}</Select></label>
      {(["linen", "baggage"] as const).map((key) => <label key={key} htmlFor={`booking-edit-${key}`}><span className={MODAL_FIELD_LABEL_CLASS}>{key === "linen" ? "Linen" : "Baggage"}</span><Select id={`booking-edit-${key}`} disabled={locked || busy} value={details[key] ?? ""} onChange={(event) => setDetails({ ...details, [key]: event.target.value })}><option value="">Not set</option>{(key === "linen" ? ["Requested", "Delivered"] : ["Yes", "No"]).map((value) => <option key={value}>{value}</option>)}</Select></label>)}
      {(["earlyCheckIn", "lateCheckOut"] as const).map((key) => <label key={key}><span className={MODAL_FIELD_LABEL_CLASS}>{key === "earlyCheckIn" ? "Early check-in" : "Late check-out"}</span><Input type="time" disabled={locked || busy} value={details[key] ?? ""} onChange={(event) => setDetails({ ...details, [key]: event.target.value })} /></label>)}
      {conflicts.length && !locked ? <p className="text-sm text-danger sm:col-span-2" role="alert" data-bk-alert>{describeBookingConflict(conflicts[0], conflicts[0].roomLabel)}</p> : null}
      {error ? <p role="alert" className="text-danger sm:col-span-2">{error}</p> : null}
    </div>
  </PortalDialog>;
}
