"use client";
import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Input } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { saveChannelStayGuestName } from "@/lib/channel-calendar/client";
import { CHANNEL_STAY_GUEST_NAME_MAX } from "@/lib/channel-calendar/stay-details";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

/**
 * Name the guest on a channel stay. The Airbnb feed only says "Reserved" plus a reservation code, so
 * the manager types who is coming; it is stored beside the synced stay and survives every sync.
 * Clearing the field and saving removes the name.
 */
export function BookingsGuestNameDialog({ entry, onClose, onSaved, save = saveChannelStayGuestName }: {
  entry: PropertyBookingEntry; onClose: () => void; onSaved: (guestName: string) => void;
  save?: typeof saveChannelStayGuestName;
}) {
  const [value, setValue] = useState(entry.guestName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const saved = await save({ connectionId: entry.connectionId ?? "", sourceUid: entry.sourceUid ?? "", guestName: value });
      onSaved(saved);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the guest name.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <PortalDialog open onClose={onClose} title="Guest name" dataAttr="booking-guest-name-dialog" primaryAction={{ label: "Save", onClick: submit, disabled: busy || !entry.connectionId || !entry.sourceUid, loading: busy, dataAttr: "booking-guest-name-save" }}>
      <div className="space-y-4">
        <label className="block"><span className={MODAL_FIELD_LABEL_CLASS}>Name</span><Input value={value} maxLength={CHANNEL_STAY_GUEST_NAME_MAX} autoFocus disabled={busy} onChange={(event) => setValue(event.target.value)} data-attr="booking-guest-name-input" /></label>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
      </div>
    </PortalDialog>
  );
}
