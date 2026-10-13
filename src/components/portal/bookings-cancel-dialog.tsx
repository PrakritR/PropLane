"use client";
import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { BlockDatesDraft } from "@/components/portal/bookings-block-dates-modal";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { canCancelBooking, canDeleteReservation, isReservedBlock } from "@/lib/channel-calendar/booking-presentation";
import { canNotifyBookingGuest, sendBookingCancelNotice } from "@/lib/channel-calendar/booking-cancel-notice";
import { deleteRoomDateBlock } from "@/lib/channel-calendar/room-date-blocks";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { roomDateBlockRecordIdPrefix } from "@/lib/portal-schedule-record-scope";

/** The booking as a block draft: what Undo re-saves, and what a soft cancel flips to `cancelled`. */
function draftOf(entry: PropertyBookingEntry): BlockDatesDraft {
  return { id: entry.blockId, isBookingResidency: entry.isBookingResidency, openEnded: entry.openEnded, propertyId: entry.propertyId, roomId: entry.roomId, checkIn: entry.start, checkOut: addDaysToDateKey(entry.end, 1), reason: entry.reason ?? "", residentName: entry.residentName ?? "", residentEmail: entry.residentEmail ?? "", residentPhone: entry.residentPhone, bookingStatus: entry.bookingStatus ?? "hold", rate: entry.rate, rateBasis: entry.rateBasis, stayDetails: entry.stayDetails };
}

/**
 * A marked-reserved block (nobody attached) is hard-deleted at any date, with a toast Undo that re-saves the
 * same row. A named hold keeps the soft cancel (kept mounted until its Undo is dismissed; archival saves retain
 * the original record id).
 */
export function BookingsCancelDialog({ entry, onClose, onSave, notify = sendBookingCancelNotice, onDelete = deleteRoomDateBlock, viewerUserId }: { entry: PropertyBookingEntry; onClose: () => void; onSave: (draft: BlockDatesDraft) => Promise<unknown>; notify?: typeof sendBookingCancelNotice; onDelete?: (blockId: string) => Promise<void>; /** Overrides the signed-in user the Undo ownership check reads. */ viewerUserId?: string | null }) {
  const reserved = isReservedBlock(entry);
  const { showToast } = useAppUi();
  const session = useManagerUserId();
  const viewerId = viewerUserId ?? session.userId;
  const canNotify = !reserved && canNotifyBookingGuest(entry);
  const [notifyGuest, setNotifyGuest] = useState(canNotify);
  const [notice, setNotice] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const draft = draftOf(entry);
  const save = async (undo: boolean) => { setBusy(true); setError(""); try { await onSave({ ...draft, bookingStatus: undo ? draft.bookingStatus : "cancelled" }); if (undo) onClose(); else { setCancelled(true); if (notifyGuest && canNotify) { const sent = await notify(entry).catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : "Could not send the notice." })); setNotice(sent.ok ? " · guest notified" : ` · guest not notified: ${sent.error}`); } } } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update booking."); } finally { setBusy(false); } };
  const remove = async () => {
    if (!entry.blockId) return;
    setBusy(true); setError("");
    try {
      await onDelete(entry.blockId);
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : "Couldn’t delete this reservation. Try again.");
      setBusy(false);
      return;
    }
    // Undo re-saves the same row (same id, room, dates and label) through the page's own save path.
    // Undo re-inserts the row, and the route only accepts an insert whose id carries the writer's own user id
    // (`assertInsertAllowed`). A co-manager deleting the owner's block is allowed to delete but not to re-create it,
    // so they get no Undo that would fail.
    const canUndo = Boolean(viewerId) && (entry.blockId ?? "").startsWith(roomDateBlockRecordIdPrefix(viewerId!));
    if (!canUndo) showToast("Reservation deleted.");
    else showToast("Reservation deleted.", { undo: async () => { try { await onSave(draft); } catch (cause) { showToast(cause instanceof Error ? cause.message : "Could not restore that reservation."); } } });
    onClose();
  };
  if (reserved) {
    const rows: [string, string][] = [["Room", [entry.propertyLabel, entry.roomLabel].filter(Boolean).join(" · ")], ["Dates", formatBookingStayRange(entry.start, entry.end, entry.openEnded)], ["Label", entry.reason?.trim() || "Reserved"]];
    return <PortalDialog open onClose={onClose} title="Delete this reservation?" tone="danger" contextPanel={null} preview={null} primaryAction={{ label: "Delete", onClick: remove, disabled: busy || !canDeleteReservation(entry) || !entry.blockId, loading: busy, dataAttr: "bookings-delete-reservation" }}><div className="space-y-4"><dl className="divide-y divide-border" data-attr="bookings-cancel-summary">{rows.map(([label, value]) => <div key={label} className="flex items-start justify-between gap-4 py-2"><dt className="text-sm text-muted">{label}</dt><dd className="text-right text-sm font-semibold text-foreground">{value}</dd></div>)}</dl>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div></PortalDialog>;
  }
  if (cancelled) return <div role="status" className="fixed bottom-20 right-4 z-50 rounded-xl border border-border bg-card p-4 shadow-lg"><div className="flex items-center gap-3">Booking cancelled{notice}<Button variant="ghost" onClick={() => save(true)} disabled={busy}>Undo</Button><Button variant="ghost" onClick={onClose}>Dismiss</Button></div>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div>;
  return <PortalDialog open onClose={onClose} title={`Cancel ${entry.residentName || entry.summary}’s booking?`} tone="danger" previewLabel="What changes" preview={<div className="space-y-4 rounded-xl border border-border bg-card p-4 text-sm" data-attr="bookings-cancel-preview"><ul className="list-disc space-y-1 pl-5 text-foreground"><li>The dates open up on the calendar</li><li>{notifyGuest && canNotify ? "The guest is told it was cancelled" : "The guest is not notified"}</li><li>You can undo it right after</li></ul></div>} primaryAction={{ label: "Cancel booking", onClick: () => save(false), disabled: busy || !canCancelBooking(entry), loading: busy }}><div className="space-y-4"><p>{entry.propertyLabel} · {entry.roomLabel}</p><p>{formatBookingStayRange(entry.start, entry.end, entry.openEnded)}</p><label className="flex gap-2"><input type="checkbox" checked={notifyGuest && canNotify} disabled={!canNotify || busy} onChange={(event) => setNotifyGuest(event.target.checked)} />Notify guest</label>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div></PortalDialog>;
}
