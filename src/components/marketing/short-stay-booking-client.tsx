"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { sha256HexFromUtf8 } from "@/lib/document-body-sha256";
import { shortTermNightlyRate } from "@/lib/short-term-stay-pricing";
import { buildRentalApplyHref } from "@/lib/rental-application/apply-from-listing";

export function ShortStayBookingClient() {
  const searchParams = useSearchParams();
  const propertyId = searchParams.get("propertyId")?.trim() ?? "";
  const roomId = searchParams.get("roomId")?.trim() ?? "";
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuests] = useState(1);
  const [name, setName] = useState("");
  const [agreementHash, setAgreementHash] = useState<string | null>(null);
  const nightly = shortTermNightlyRate("120");
  const nights = useMemo(() => {
    if (!checkIn || !checkOut) return 0;
    const a = new Date(`${checkIn}T12:00:00`);
    const b = new Date(`${checkOut}T12:00:00`);
    const diff = Math.round((b.getTime() - a.getTime()) / 86400000);
    return diff > 0 ? diff : 0;
  }, [checkIn, checkOut]);
  const total = nightly * nights * guests;
  const agreement =
    "Short-term stay agreement — guest agrees to house rules, quiet hours, and the nightly rate shown before payment.";

  const listingHref =
    propertyId && roomId
      ? buildRentalApplyHref({ propertyId, listingRoomId: roomId, rentalType: "short_term" })
      : propertyId
        ? `/rent/listings/${encodeURIComponent(propertyId)}`
        : "/rent/browse";

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6" data-st9-wrap>
      <Link href={listingHref} className="text-sm font-semibold text-primary">Back to listing</Link>
      <section className="grid gap-4 md:grid-cols-2" data-st9-dates>
        <div className="rounded-2xl border border-border bg-card p-4">
          <h1 className="text-lg font-bold text-foreground">Book a short stay</h1>
          <label className="mt-3 block text-sm font-bold text-foreground">
            Check-in
            <input
              type="date"
              className="mt-1 w-full rounded-xl border border-border px-3 py-2.5 text-sm"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
            />
          </label>
          <label className="mt-3 block text-sm font-bold text-foreground">
            Check-out
            <input
              type="date"
              className="mt-1 w-full rounded-xl border border-border px-3 py-2.5 text-sm"
              value={checkOut}
              onChange={(e) => setCheckOut(e.target.value)}
            />
          </label>
          <label className="mt-3 block text-sm font-bold text-foreground">
            Guests
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded-xl border border-border px-3 py-2.5 text-sm"
              value={guests}
              onChange={(e) => setGuests(Math.max(1, Number(e.target.value) || 1))}
            />
          </label>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="text-sm font-bold text-foreground">${nightly.toFixed(2)} / night</p>
          <p className="mt-2 text-sm font-semibold text-foreground">
            {nights} nights × {guests} guest{guests === 1 ? "" : "s"} = ${total.toFixed(2)}
          </p>
        </div>
      </section>
      <section className="rounded-2xl border border-border bg-card p-4" data-st9-agreement>
        <h2 className="text-sm font-bold text-foreground">Agreement</h2>
        <p className="mt-2 text-sm text-foreground">{agreement}</p>
        <label className="mt-3 block text-sm font-bold text-foreground">
          Full name
          <input
            className="mt-1 w-full rounded-xl border border-border px-3 py-2.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <Button
          type="button"
          className="mt-3"
          onClick={() => void sha256HexFromUtf8(agreement).then(setAgreementHash)}
          disabled={!name.trim()}
        >
          Sign agreement
        </Button>
        {agreementHash ? (
          <p className="mt-2 text-xs font-semibold text-muted">SHA-256: {agreementHash}</p>
        ) : null}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4" data-st9-pay>
        <Button type="button" disabled={!agreementHash || nights < 1}>
          Pay by card
        </Button>
      </section>
    </div>
  );
}
