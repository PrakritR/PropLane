"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { sha256HexFromUtf8 } from "@/lib/document-body-sha256";
import { shortTermNightlyRate, shortTermStayNightCount } from "@/lib/short-term-stay-pricing";
import { buildRentalApplyHref } from "@/lib/rental-application/apply-from-listing";
import { resolveStayPricing } from "@/lib/room-pricing";
import { getListingRichContent } from "@/data/listing-rich-content";
import type { MockProperty } from "@/data/types";
import { useListingPublicOccupancy } from "@/hooks/use-listing-public-occupancy";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";

export function ShortStayBookingClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const propertyId = searchParams.get("propertyId")?.trim() ?? "";
  const roomId = searchParams.get("roomId")?.trim() ?? "";
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  const [guests, setGuests] = useState(1);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [agreementHash, setAgreementHash] = useState<string | null>(null);
  const [listing, setListing] = useState<MockProperty | null>(null);
  const { rooms: occupancyRooms } = useListingPublicOccupancy(propertyId);
  const [loadingListing, setLoadingListing] = useState(Boolean(propertyId));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!propertyId) {
      setListing(null);
      setLoadingListing(false);
      return;
    }
    setLoadingListing(true);
    void fetch("/api/property-records/public")
      .then((res) => (res.ok ? res.json() : { listings: [] }))
      .then((payload: { listings?: MockProperty[] }) => {
        setListing(payload.listings?.find((row) => row.id === propertyId) ?? null);
      })
      .catch(() => setListing(null))
      .finally(() => setLoadingListing(false));
  }, [propertyId]);

  const rich = useMemo(() => (listing ? getListingRichContent(listing) : null), [listing]);
  const listingRooms = useMemo(
    () => rich?.floorPlans.flatMap((floor) => floor.rooms) ?? [],
    [rich],
  );
  const displayRoom = useMemo(
    () => listingRooms.find((r) => r.id === roomId) ?? listingRooms[0] ?? null,
    [listingRooms, roomId],
  );
  const submissionRoom = useMemo(
    () => listing?.listingSubmission?.rooms?.find((r) => r.id === (roomId || displayRoom?.id)) ?? null,
    [displayRoom?.id, listing, roomId],
  );

  const nightly = useMemo(() => {
    if (!listing) return shortTermNightlyRate("0");
    const pricing = resolveStayPricing({
      room: submissionRoom,
      submission: listing.listingSubmission ?? null,
      application: { rentalType: "short_term", leaseStart: checkIn, leaseEnd: checkOut },
    });
    if (pricing.dailyRate && pricing.dailyRate > 0) return pricing.dailyRate;
    return shortTermNightlyRate(listing.listingSubmission?.shortTermDailyCost);
  }, [checkIn, checkOut, listing, submissionRoom]);

  const blockedSpans = useMemo(() => {
    if (!propertyId || !displayRoom?.id) return [];
    const choice = `${propertyId}${LISTING_ROOM_CHOICE_SEP}${displayRoom.id}`;
    const occ = occupancyRooms.find((row) => row.roomChoice === choice);
    return occ?.spans ?? [];
  }, [displayRoom?.id, occupancyRooms, propertyId]);

  const nights = useMemo(() => shortTermStayNightCount(checkIn, checkOut) ?? 0, [checkIn, checkOut]);
  const total = nightly * nights * guests;
  const agreement = useMemo(() => {
    const propertyLabel = listing?.address?.trim() || listing?.title?.trim() || "this property";
    const roomLabel = displayRoom?.name?.trim() || "the selected room";
    return `Short-term stay agreement for ${propertyLabel}, ${roomLabel}. Guest ${name.trim() || "(name)"} agrees to house rules, quiet hours, and the nightly rate of $${nightly.toFixed(2)} for ${nights} night(s).`;
  }, [displayRoom, listing, name, nightly, nights]);

  const listingHref =
    propertyId && roomId
      ? buildRentalApplyHref({ propertyId, listingRoomId: roomId, rentalType: "short_term" })
      : propertyId
        ? `/rent/listings/${encodeURIComponent(propertyId)}`
        : "/rent/browse";

  const signAgreement = async () => {
    if (!name.trim()) return;
    const hash = await sha256HexFromUtf8(agreement);
    setAgreementHash(hash);
  };

  const pay = async () => {
    if (!agreementHash || nights < 1 || !propertyId || !displayRoom?.id) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch("/api/public/short-stay-booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          roomId: displayRoom.id,
          checkIn,
          checkOut,
          guests,
          guestName: name.trim(),
          guestEmail: email.trim(),
          guestPhone: phone.trim(),
          agreementSha256: agreementHash,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; confirmationPath?: string };
      if (res.status === 409) {
        setSubmitError(payload.error ?? "Those dates are no longer available.");
        return;
      }
      if (!res.ok) {
        setSubmitError(payload.error ?? "Could not start payment.");
        return;
      }
      if (payload.confirmationPath) router.push(payload.confirmationPath);
    } catch {
      setSubmitError("Could not reach the server.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-4 py-6" data-st9-wrap>
      <Link href={listingHref} className="text-sm font-semibold text-primary">Back to listing</Link>
      {loadingListing ? <p className="text-sm text-muted">Loading stay details…</p> : null}
      <section className="grid gap-4 md:grid-cols-2" data-st9-dates>
        <div className="rounded-2xl border border-border bg-card p-4">
          <h1 className="text-lg font-bold text-foreground">Book a short stay</h1>
          <label className="mt-3 block text-sm font-bold text-foreground">
            Check-in
            <input
              type="date"
              className="mt-1 w-full min-h-11 rounded-xl border border-border px-3 py-2.5 text-sm"
              value={checkIn}
              onChange={(e) => setCheckIn(e.target.value)}
            />
          </label>
          <label className="mt-3 block text-sm font-bold text-foreground">
            Check-out
            <input
              type="date"
              className="mt-1 w-full min-h-11 rounded-xl border border-border px-3 py-2.5 text-sm"
              value={checkOut}
              onChange={(e) => setCheckOut(e.target.value)}
            />
          </label>
          <label className="mt-3 block text-sm font-bold text-foreground">
            Guests
            <input
              type="number"
              min={1}
              className="mt-1 w-full min-h-11 rounded-xl border border-border px-3 py-2.5 text-sm"
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
          {blockedSpans.length > 0 ? (
            <p className="mt-3 text-xs font-semibold text-muted">
              {blockedSpans.length} occupied range(s) on this room — pick dates outside them.
            </p>
          ) : null}
        </div>
      </section>
      <section className="rounded-2xl border border-border bg-card p-4" data-st9-agreement>
        <h2 className="text-sm font-bold text-foreground">Guest details</h2>
        <label className="mt-3 block text-sm font-bold text-foreground">
          Full name
          <input
            className="mt-1 w-full min-h-11 rounded-xl border border-border px-3 py-2.5 text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="mt-3 block text-sm font-bold text-foreground">
          Email
          <input
            type="email"
            className="mt-1 w-full min-h-11 rounded-xl border border-border px-3 py-2.5 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="mt-3 block text-sm font-bold text-foreground">
          Phone
          <input
            type="tel"
            className="mt-1 w-full min-h-11 rounded-xl border border-border px-3 py-2.5 text-sm"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </label>
        <h2 className="mt-4 text-sm font-bold text-foreground">Agreement</h2>
        <p className="mt-2 text-sm text-foreground">{agreement}</p>
        <label className="mt-3 flex items-center gap-2 text-sm font-semibold text-foreground">
          <input type="checkbox" checked={Boolean(agreementHash)} onChange={() => void signAgreement()} />
          I sign with my typed name (must match the form)
        </label>
        {agreementHash ? (
          <p className="mt-2 text-xs font-semibold text-muted">SHA-256: {agreementHash}</p>
        ) : null}
      </section>
      <section className="rounded-2xl border border-border bg-card p-4" data-st9-pay>
        {submitError ? <p className="mb-2 text-sm font-semibold text-destructive">{submitError}</p> : null}
        <Button
          type="button"
          className="min-h-11"
          disabled={!agreementHash || nights < 1 || !email.trim() || submitting}
          onClick={() => void pay()}
        >
          Pay by card
        </Button>
      </section>
    </div>
  );
}
