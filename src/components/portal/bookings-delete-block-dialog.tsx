"use client";
import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { formatBookingStayRange } from "@/lib/channel-calendar/bookings-ui";

/**
 * Delete a PropLane block for good (hard delete, native blocks only). Unblock is the undoable
 * cancel; this is the one that cannot be undone, so it asks once in a danger dialog whose
 * primary is the labelled destructive confirm.
 */
export function BookingsDeleteBlockDialog({ entry, onClose, onDelete }: { entry: PropertyBookingEntry; onClose: () => void; onDelete: (blockId: string) => Promise<boolean | void> }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!entry.blockId) return;
    setBusy(true);
    try { if ((await onDelete(entry.blockId)) !== false) onClose(); } finally { setBusy(false); }
  };
  return <PortalDialog open onClose={onClose} fullScreenMobile={false} title="Delete this block?" tone="danger" dataAttr="bookings-delete-block-dialog" primaryAction={{ label: "Delete", onClick: run, disabled: busy || !entry.blockId, loading: busy, dataAttr: "bookings-delete-block-confirm" }}>
    <div className="space-y-2 text-sm"><p>{[entry.propertyLabel, entry.roomLabel].filter(Boolean).join(" · ")}</p><p>{formatBookingStayRange(entry.start, entry.end, entry.openEnded)}</p></div>
  </PortalDialog>;
}
