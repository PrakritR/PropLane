"use client";
import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";
import type { BlockDatesDraft } from "@/components/portal/bookings-block-dates-modal";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { canCancelBooking } from "@/lib/channel-calendar/booking-presentation";
import { canNotifyBookingGuest, sendBookingCancelNotice } from "@/lib/channel-calendar/booking-cancel-notice";

/** Keep mounted until Undo is dismissed; archival saves retain the original record id. */
export function BookingsCancelDialog({ entry, onClose, onSave, notify = sendBookingCancelNotice }: { entry: PropertyBookingEntry; onClose: () => void; onSave: (draft: BlockDatesDraft) => Promise<unknown>; notify?: typeof sendBookingCancelNotice }) {
  const canNotify = canNotifyBookingGuest(entry);
  const [notifyGuest, setNotifyGuest] = useState(canNotify);
  const [notice, setNotice] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const draft: BlockDatesDraft = { id: entry.blockId, isBookingResidency: entry.isBookingResidency, openEnded: entry.openEnded, propertyId: entry.propertyId, roomId: entry.roomId, checkIn: entry.start, checkOut: addDaysToDateKey(entry.end, 1), reason: entry.reason ?? "", residentName: entry.residentName ?? "", residentEmail: entry.residentEmail ?? "", residentPhone: entry.residentPhone, bookingStatus: entry.bookingStatus ?? "hold", rate: entry.rate, rateBasis: entry.rateBasis, stayDetails: entry.stayDetails };
  const save = async (undo: boolean) => { setBusy(true); setError(""); try { await onSave({ ...draft, bookingStatus: undo ? draft.bookingStatus : "cancelled" }); if (undo) onClose(); else { setCancelled(true); if (notifyGuest && canNotify) { const sent = await notify(entry).catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : "Could not send the notice." })); setNotice(sent.ok ? " · guest notified" : ` · guest not notified: ${sent.error}`); } } } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update booking."); } finally { setBusy(false); } };
  if (cancelled) return <div role="status" className="fixed bottom-20 right-4 z-50 rounded-xl border border-border bg-card p-4 shadow-lg"><div className="flex items-center gap-3">Booking cancelled{notice}<Button variant="ghost" onClick={() => save(true)} disabled={busy}>Undo</Button><Button variant="ghost" onClick={onClose}>Dismiss</Button></div>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div>;
  return <PortalDialog open onClose={onClose} title={`Cancel ${entry.residentName || entry.summary}’s booking?`} tone="danger" primaryAction={{ label: "Cancel booking", onClick: () => save(false), disabled: busy || !canCancelBooking(entry), loading: busy }}><div className="space-y-4"><p>{entry.propertyLabel} · {entry.roomLabel}</p><p>{formatBookingStayRange(entry.start, addDaysToDateKey(entry.end, 1), entry.openEnded)}</p><label className="flex gap-2"><input type="checkbox" checked={notifyGuest && canNotify} disabled={!canNotify || busy} onChange={(event) => setNotifyGuest(event.target.checked)} />Notify guest</label>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div></PortalDialog>;
}
