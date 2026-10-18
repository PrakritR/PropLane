"use client";
import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Button } from "@/components/ui/button";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";
import { bookingEntryGuestLabel } from "@/lib/channel-calendar/booking-guest-label";
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
  const guest = bookingEntryGuestLabel(entry);
  // A host block's identity is its UID plus the RAW imported range's dates. A visible entry may be
  // the trimmed remainder of an echoed block, so its own dates would match no stored range.
  const ref = {
    connectionId: entry.connectionId ?? "",
    sourceUid: entry.sourceUid ?? "",
    start: entry.channelRangeStart ?? entry.start,
    end: entry.channelRangeEnd ?? entry.end,
  };
  const run = async (undo: boolean) => {
    setBusy(true); setError("");
    try { await (undo ? restore(ref) : remove(ref)); onChanged(); if (undo) onClose(); else setRemoved(true); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not update the stay."); }
    finally { setBusy(false); }
  };
  if (removed) return <div role="status" className="fixed inset-x-4 bottom-[max(5rem,calc(env(safe-area-inset-bottom,0px)+1rem))] z-50 rounded-xl border border-border bg-card p-4 shadow-lg sm:inset-x-auto sm:right-4" data-attr="bookings-remove-stay-undo"><div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[16px] sm:text-sm">Removed {guest}’s stay<Button variant="ghost" onClick={() => run(true)} disabled={busy}>Undo</Button><Button variant="ghost" onClick={onClose}>Dismiss</Button></div>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div>;
  return <PortalDialog open onClose={onClose} fullScreenMobile={false} title={`Remove ${guest}’s stay?`} tone="danger" dataAttr="bookings-remove-stay-dialog" primaryAction={{ label: "Remove stay", onClick: () => run(false), disabled: busy || !canRemoveChannelStay(entry), loading: busy }}><div className="space-y-4"><p>{entry.propertyLabel} · {entry.roomLabel}</p><p>{formatBookingStayRange(entry.start, entry.end, entry.openEnded)}</p>{error ? <p role="alert" className="text-danger">{error}</p> : null}</div></PortalDialog>;
}
