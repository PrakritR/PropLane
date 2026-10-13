"use client";
import { useState } from "react";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { Input } from "@/components/ui/input";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { saveChannelStayDetailsClient } from "@/lib/channel-calendar/client";
import {
  CHANNEL_STAY_GUEST_NAME_MAX,
  CHANNEL_STAY_PHONE_MAX,
  dollarsToStayCents,
  stayCentsToDollars,
} from "@/lib/channel-calendar/stay-details";
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

/**
 * One popup, one Save, for what a manager knows about an Airbnb stay that the feed never says:
 * the guest's name and phone, the nightly rate, what Airbnb pays out and the day it landed.
 * Stored beside the synced stay (`channel_stay_details`), so every sync leaves it alone.
 * A blank field clears that value.
 */
export function BookingsStayDetailsDialog({ entry, onClose, onSaved, save = saveChannelStayDetailsClient }: {
  entry: PropertyBookingEntry; onClose: () => void; onSaved: () => void;
  save?: typeof saveChannelStayDetailsClient;
}) {
  const [name, setName] = useState(entry.guestName ?? "");
  const [phone, setPhone] = useState(entry.guestPhone ?? "");
  const [nightly, setNightly] = useState(stayCentsToDollars(entry.nightlyCents));
  const [payout, setPayout] = useState(stayCentsToDollars(entry.payoutCents));
  const [paidOn, setPaidOn] = useState(entry.paidAt ? entry.paidAt.slice(0, 10) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    const nightlyCents = dollarsToStayCents(nightly);
    const payoutCents = dollarsToStayCents(payout);
    if (nightly.trim() && nightlyCents === null) return setError("Nightly rate is not a valid amount.");
    if (payout.trim() && payoutCents === null) return setError("Payout is not a valid amount.");
    setBusy(true); setError("");
    try {
      await save({
        connectionId: entry.connectionId ?? "",
        sourceUid: entry.sourceUid ?? "",
        guestName: name,
        guestPhone: phone,
        nightlyCents,
        payoutCents,
        paidAt: paidOn.trim() ? paidOn.trim() : null,
      });
      onSaved();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the booking details.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <PortalDialog open onClose={onClose} title="Booking details" dataAttr="booking-stay-details-dialog" primaryAction={{ label: "Save", onClick: submit, disabled: busy || !entry.connectionId || !entry.sourceUid, loading: busy, dataAttr: "booking-stay-details-save" }}>
      <div className="space-y-4">
        <label className="block"><span className={MODAL_FIELD_LABEL_CLASS}>Name</span><Input value={name} maxLength={CHANNEL_STAY_GUEST_NAME_MAX} autoFocus disabled={busy} onChange={(event) => setName(event.target.value)} data-attr="booking-stay-name-input" /></label>
        <label className="block"><span className={MODAL_FIELD_LABEL_CLASS}>Phone</span><Input type="tel" value={phone} maxLength={CHANNEL_STAY_PHONE_MAX} disabled={busy} onChange={(event) => setPhone(event.target.value)} data-attr="booking-stay-phone-input" /></label>
        <label className="block"><span className={MODAL_FIELD_LABEL_CLASS}>Nightly</span><Input inputMode="decimal" value={nightly} disabled={busy} onChange={(event) => setNightly(event.target.value)} data-attr="booking-stay-nightly-input" /></label>
        <label className="block"><span className={MODAL_FIELD_LABEL_CLASS}>Payout</span><Input inputMode="decimal" value={payout} disabled={busy} onChange={(event) => setPayout(event.target.value)} data-attr="booking-stay-payout-input" /></label>
        <label className="block"><span className={MODAL_FIELD_LABEL_CLASS}>Paid on</span><Input type="date" value={paidOn} disabled={busy} onChange={(event) => setPaidOn(event.target.value)} data-attr="booking-stay-paid-on-input" /></label>
        {error ? <p role="alert" className="text-danger">{error}</p> : null}
      </div>
    </PortalDialog>
  );
}
