"use client";
import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDaysToDateKey, formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { bookingGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
import { canRemoveChannelStay } from "@/lib/channel-calendar/booking-presentation";
import { removeChannelStay, restoreChannelStay } from "@/lib/channel-calendar/client";

/**
 * Remove stay (C2-AB7) for a reservation a channel calendar feed brought in.
 * Asks once, writes a tombstone through the server, then offers Undo. Stays
 * mounted until the Undo toast is dismissed, like the cancel dialog.
 */
export function BookingsRemoveStayDialog({ entry, onClose, onChanged, remove = removeChannelStay, restore = restoreChannelStay }: {
  entry: PropertyBookingEntry; onClose: () => void; onChanged: () => void;
  remove?: typeof removeChannelStay; restore?: typeof restoreChannelStay;
}) {
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const guest = bookingGuestLabel(entry.summary, entry.source === "booking_com" ? "booking_com" : "airbnb");
  const ref = { connectionId: entry.connectionId ?? "", sourceUid: entry.sourceUid ?? "" };
  const run = async (undo: boolean) => {
    setBusy(true); setError("");
    try { await (undo ? restore(ref) : remove(ref)); onChanged(); if (undo) onClose(); else setRemoved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the stay."); }
    finally { setBusy(false); }
  };
  if (removed) return <div role="status" className="fixed bottom-20 right-4 z-50 rounded-xl border border-border bg-card p-4 shadow-lg" data-attr="bookings-remove-stay-undo"><div className="flex items-center gap-3">Removed {guest}’s stay<Button variant="ghost" onClick={() => run(true)} disabled={busy}>Undo</Button><Button variant="ghost" onClick={onClose}>Dismiss</Button></div>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div>;
  return <PortalDialog open onClose={onClose} title={`Remove ${guest}’s stay?`} tone="danger" dataAttr="bookings-remove-stay-dialog" primaryAction={{ label: "Remove stay", onClick: () => run(false), disabled: busy || !canRemoveChannelStay(entry), loading: busy }}><div className="space-y-4"><p>{entry.propertyLabel} · {entry.roomLabel}</p><p>{formatBookingStayRange(entry.start, addDaysToDateKey(entry.end, 1), entry.openEnded)}</p>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div></PortalDialog>;
}
