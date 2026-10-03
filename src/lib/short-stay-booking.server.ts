import "server-only";

import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HouseholdCharge } from "@/lib/household-charges";
import { getPublicListings } from "@/lib/public-listings.server";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import { ROOM_DATE_BLOCK_RECORD_TYPE, roomDateBlockRecordId } from "@/lib/portal-schedule-record-scope";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { resolveStayPricing } from "@/lib/room-pricing";
import { shortStayRangeHasRoom } from "@/lib/short-stay-availability";
import { createHouseholdChargeCheckout } from "@/lib/stripe-household-charge-checkout.server";
import { shortStayScreeningRequired } from "@/lib/short-stay-screening";
import {
  shortTermNightlyRate,
  shortTermStayChargeTitle,
  shortTermStayNightCount,
  shortTermStayTotalAmount,
} from "@/lib/short-term-stay-pricing";

export { shortStayScreeningRequired };

export type ShortStayBookingInput = {
  propertyId: string;
  roomId: string;
  checkIn: string;
  checkOut: string;
  guests: number;
  guestName: string;
  guestEmail: string;
  guestPhone?: string;
  agreementSha256: string;
  screeningConsent?: boolean;
  appOrigin: string;
};

export type ShortStayBookingResult =
  | { ok: true; mode: "request"; confirmationPath: string; bookingId: string }
  | { ok: true; mode: "checkout"; checkoutUrl: string; bookingId: string; chargeIds: string[] }
  | { ok: false; status: number; error: string };

async function loadManagerId(db: SupabaseClient, propertyId: string): Promise<string | null> {
  const { data } = await db
    .from("manager_property_records")
    .select("manager_user_id")
    .eq("id", propertyId)
    .maybeSingle();
  return typeof data?.manager_user_id === "string" ? data.manager_user_id.trim() : null;
}

export async function createShortStayBooking(
  db: SupabaseClient,
  input: ShortStayBookingInput,
): Promise<ShortStayBookingResult> {
  const nights = shortTermStayNightCount(input.checkIn, input.checkOut);
  if (!nights || nights < 1) {
    return { ok: false, status: 400, error: "Check-out must be after check-in." };
  }

  const listings = await getPublicListings({});
  const listing = listings.find((row) => row.id === input.propertyId);
  const submission = listing?.listingSubmission;
  if (!listing || !submission?.shortTermRentalsAllowed) {
    return { ok: false, status: 404, error: "This listing is not available for short stays." };
  }

  const room = submission.rooms?.find((r) => r.id === input.roomId);
  if (!room) return { ok: false, status: 404, error: "This room is not available." };

  const managerUserId = listing.managerUserId?.trim() || (await loadManagerId(db, input.propertyId));
  if (!managerUserId) return { ok: false, status: 422, error: "This listing is not ready for booking." };

  const occupancy = await loadPublicRoomOccupancy(db, [listing]);
  const choice = `${input.propertyId}${LISTING_ROOM_CHOICE_SEP}${input.roomId}`;
  const occ = occupancy.find((row) => row.roomChoice === choice);
  const capacity = normalizeRoomOccupancyCapacity(room.occupancyCapacity);
  if (!shortStayRangeHasRoom(occ?.spans ?? [], capacity, input.checkIn, input.checkOut)) {
    return { ok: false, status: 409, error: "Those dates are no longer available." };
  }

  const screening = shortStayScreeningRequired(submission);
  if (screening && !input.screeningConsent) {
    return { ok: false, status: 400, error: "Agree to screening to continue." };
  }

  const pricing = resolveStayPricing({
    room,
    submission,
    application: { rentalType: "short_term", leaseStart: input.checkIn, leaseEnd: input.checkOut },
  });
  const nightly =
    pricing.dailyRate && pricing.dailyRate > 0
      ? pricing.dailyRate
      : shortTermNightlyRate(submission.shortTermDailyCost);
  const weeklyRate = pricing.weeklyRate ?? 0;
  const guests = Math.max(1, input.guests);
  const rentTotal = shortTermStayTotalAmount(nightly, nights, weeklyRate) * guests;
  const rentCents = Math.round(rentTotal * 100);
  if (rentCents < 100) {
    return { ok: false, status: 422, error: "This stay cannot be priced online yet." };
  }

  const bookingUid = randomUUID().replace(/-/g, "").slice(0, 12);
  const bookingId = roomDateBlockRecordId(managerUserId, `stay_${bookingUid}`);
  const now = new Date().toISOString();
  const propertyLabel = listing.address?.trim() || listing.title?.trim() || input.propertyId;

  const blockRow = {
    id: bookingId,
    recordType: ROOM_DATE_BLOCK_RECORD_TYPE,
    propertyId: input.propertyId,
    roomId: input.roomId,
    checkIn: input.checkIn,
    checkOut: input.checkOut,
    reason: screening ? "Short-stay request" : "Short-stay hold",
    bookingStatus: "hold",
    residentName: input.guestName,
    residentEmail: input.guestEmail.toLowerCase(),
    ...(input.guestPhone?.trim() ? { residentPhone: input.guestPhone.trim() } : {}),
    stayDetails: {
      source: "direct",
      screeningConsent: input.screeningConsent ? "yes" : "no",
      agreementSha256: input.agreementSha256,
      guests: String(guests),
    },
    createdAt: now,
    startsAt: `${input.checkIn}T00:00:00`,
    endsAt: `${input.checkOut}T00:00:00`,
    isBookingResidency: true,
  };

  const { error: blockErr } = await db.from("portal_schedule_records").upsert(
    {
      id: bookingId,
      manager_user_id: managerUserId,
      property_id: input.propertyId,
      record_type: ROOM_DATE_BLOCK_RECORD_TYPE,
      row_data: blockRow,
      updated_at: now,
    },
    { onConflict: "id" },
  );
  if (blockErr) {
    return { ok: false, status: 409, error: "Those dates are no longer available." };
  }

  const confirmationQuery = new URLSearchParams({
    propertyId: input.propertyId,
    bookingId,
  });
  const confirmationBase = `/rent/stay/confirmation?${confirmationQuery.toString()}`;

  if (screening) {
    const requestQuery = new URLSearchParams(confirmationQuery);
    requestQuery.set("request", "1");
    return {
      ok: true,
      mode: "request",
      bookingId,
      confirmationPath: `/rent/stay/confirmation?${requestQuery.toString()}`,
    };
  }

  const chargeId = `stay-chg-${bookingUid}`;
  const charge: HouseholdCharge = {
    id: chargeId,
    createdAt: now,
    residentEmail: input.guestEmail.toLowerCase(),
    residentName: input.guestName,
    residentUserId: null,
    propertyId: input.propertyId,
    propertyLabel,
    managerUserId,
    kind: "rent",
    title: shortTermStayChargeTitle(nights, nightly, weeklyRate),
    amountLabel: `$${(rentCents / 100).toFixed(2)}`,
    balanceLabel: `$${(rentCents / 100).toFixed(2)}`,
    status: "pending",
    blocksLeaseUntilPaid: false,
  };

  const { error: chargeErr } = await db.from("portal_household_charge_records").insert({
    id: chargeId,
    manager_user_id: managerUserId,
    resident_user_id: null,
    resident_email: input.guestEmail.toLowerCase(),
    property_id: input.propertyId,
    kind: charge.kind,
    status: "pending",
    row_data: {
      ...charge,
      shortStayBookingId: bookingId,
      agreementSha256: input.agreementSha256,
    },
    updated_at: now,
  });
  if (chargeErr) return { ok: false, status: 500, error: "Could not create the stay charge." };

  const checkout = await createHouseholdChargeCheckout(db, {
    userId: "",
    userEmail: input.guestEmail,
    chargeIds: [chargeId],
    mode: "hosted",
    paymentMethod: "card",
    expectedManagerUserId: managerUserId,
    appOrigin: input.appOrigin,
    returnPath: confirmationBase,
  });
  if (!checkout.ok) {
    return { ok: false, status: checkout.status, error: checkout.error };
  }
  if (checkout.mode !== "hosted" || !checkout.url) {
    return { ok: false, status: 503, error: "Checkout is unavailable right now." };
  }

  return {
    ok: true,
    mode: "checkout",
    bookingId,
    chargeIds: [chargeId],
    checkoutUrl: checkout.url,
  };
}
