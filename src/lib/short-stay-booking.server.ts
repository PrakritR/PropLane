import "server-only";

import { randomUUID } from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { HouseholdCharge } from "@/lib/household-charges";
import { getPublicListings } from "@/lib/public-listings.server";
import { loadPublicRoomOccupancy } from "@/lib/public-room-occupancy.server";
import {
  CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
  ROOM_DATE_BLOCK_RECORD_TYPE,
  roomDateBlockRecordId,
} from "@/lib/portal-schedule-record-scope";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";
import { resolveStayPricing } from "@/lib/room-pricing";
import type { PublicRoomOccupancy } from "@/lib/public-room-occupancy";
import { shortStayRangeHasRoom } from "@/lib/short-stay-availability";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
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

function dayKey(raw: unknown): string | null {
  const value = String(raw ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return value;
}

/** Confirmed and held short-stay blocks count toward public availability. */
async function loadShortStayBlockSpans(
  db: SupabaseClient,
  managerUserId: string,
  propertyId: string,
  roomId: string,
  excludeBookingId?: string,
): Promise<PublicRoomOccupancy["spans"]> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, row_data")
    .eq("manager_user_id", managerUserId)
    .eq("property_id", propertyId)
    .eq("record_type", ROOM_DATE_BLOCK_RECORD_TYPE);
  if (error) throw error;
  const spans: PublicRoomOccupancy["spans"] = [];
  for (const row of data ?? []) {
    if (excludeBookingId && String(row.id) === excludeBookingId) continue;
    const block = row.row_data as {
      roomId?: string;
      checkIn?: string;
      checkOut?: string;
      bookingStatus?: string;
      stayDetails?: { guests?: string };
    } | null;
    if (!block || block.roomId !== roomId) continue;
    if (block.bookingStatus === "cancelled") continue;
    const start = dayKey(block.checkIn);
    const end = dayKey(block.checkOut);
    if (!start || !end) continue;
    const guests = Math.max(1, Number.parseInt(String(block.stayDetails?.guests ?? "1"), 10) || 1);
    spans.push({ start, end, count: guests });
  }
  return spans;
}

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
  const blockSpans = await loadShortStayBlockSpans(db, managerUserId, input.propertyId, input.roomId);
  const mergedSpans = [...(occ?.spans ?? []), ...blockSpans];
  if (!shortStayRangeHasRoom(mergedSpans, capacity, input.checkIn, input.checkOut)) {
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
  // Never trust the browser's guest count past what the room holds — it multiplies the price.
  const guests = Math.min(Math.max(1, Math.floor(input.guests) || 1), Math.max(1, capacity));
  const rentTotal = shortTermStayTotalAmount(nightly, nights, weeklyRate) * guests;
  const rentCents = Math.round(rentTotal * 100);
  if (rentCents < 100) {
    return { ok: false, status: 422, error: "This stay cannot be priced online yet." };
  }

  const HOLD_MINUTES = 15;
  const holdExpiresAt = new Date(Date.now() + HOLD_MINUTES * 60_000).toISOString();

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
      holdExpiresAt,
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
    const code = String((blockErr as { code?: string }).code ?? "");
    const status = ["P4001", "40001", "40P01"].includes(code) ? 409 : 500;
    return {
      ok: false,
      status,
      error: status === 409 ? "Those dates are no longer available." : "Could not reserve those dates.",
    };
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

export async function releaseShortStayHold(
  db: SupabaseClient,
  bookingId: string,
): Promise<void> {
  const { data } = await db
    .from("portal_schedule_records")
    .select("row_data, manager_user_id")
    .eq("id", bookingId)
    .maybeSingle();
  const row = data?.row_data as { bookingStatus?: string; stayDetails?: { holdExpiresAt?: string } } | null;
  if (!row || row.bookingStatus === "confirmed" || row.bookingStatus === "cancelled") return;
  const holdExpiresAt = row.stayDetails?.holdExpiresAt;
  if (holdExpiresAt && Date.now() < Date.parse(holdExpiresAt)) return;
  const now = new Date().toISOString();
  await db.from("portal_schedule_records").upsert(
    {
      id: bookingId,
      manager_user_id: data?.manager_user_id,
      record_type: CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
      row_data: { ...row, bookingStatus: "cancelled", reason: "Payment not completed" },
      updated_at: now,
    },
    { onConflict: "id" },
  );
}

export async function finalizeShortStayAfterPayment(
  db: SupabaseClient,
  charge: HouseholdCharge & { shortStayBookingId?: string; agreementSha256?: string },
): Promise<void> {
  const bookingId = charge.shortStayBookingId?.trim();
  if (!bookingId) return;

  const { data: blockRow } = await db
    .from("portal_schedule_records")
    .select("row_data, manager_user_id, property_id")
    .eq("id", bookingId)
    .maybeSingle();
  if (!blockRow) return;
  const block = blockRow.row_data as Record<string, unknown> | null;
  if (!block) return;

  const now = new Date().toISOString();
  const nextBlock = {
    ...block,
    bookingStatus: "confirmed",
    reason: "Short-stay confirmed",
    stayDetails: {
      ...(typeof block.stayDetails === "object" && block.stayDetails ? block.stayDetails : {}),
      paidAt: now,
      householdChargeId: charge.id,
    },
  };

  await db.from("portal_schedule_records").upsert(
    {
      id: bookingId,
      manager_user_id: blockRow.manager_user_id,
      property_id: blockRow.property_id,
      record_type: ROOM_DATE_BLOCK_RECORD_TYPE,
      row_data: nextBlock,
      updated_at: now,
    },
    { onConflict: "id" },
  );

  const managerUserId = String(blockRow.manager_user_id ?? charge.managerUserId ?? "").trim();
  const propertyId = String(blockRow.property_id ?? charge.propertyId ?? "").trim();
  const guestEmail = charge.residentEmail.trim().toLowerCase();
  const guestName = charge.residentName?.trim() || "Guest";
  if (!managerUserId || !propertyId || !guestEmail.includes("@")) return;

  const agreementSha256 =
    (typeof (block.stayDetails as { agreementSha256?: string } | undefined)?.agreementSha256 === "string"
      ? (block.stayDetails as { agreementSha256: string }).agreementSha256
      : charge.agreementSha256) ?? "";

  const checkIn = String(block.checkIn ?? "").trim();
  const checkOut = String(block.checkOut ?? "").trim();
  const roomId = String(block.roomId ?? "").trim();
  const leaseId = `stay-lease-${bookingId.replace(/[^a-z0-9]/gi, "").slice(0, 24)}`;

  const pipelineRow = {
    id: leaseId,
    axisId: leaseId,
    status: "Fully Signed",
    bucket: "signed",
    residentEmail: guestEmail,
    residentName: guestName,
    propertyId,
    managerUserId,
    rentalType: "short_term",
    leaseStart: checkIn,
    leaseEnd: checkOut,
    signedRentLabel: charge.amountLabel,
    fullySignedAt: now,
    residentSignature: { name: guestName, signedAtIso: now, documentSha256: agreementSha256 },
    managerSignature: { name: "PropLane", signedAtIso: now, documentSha256: agreementSha256 },
    documentSha256: agreementSha256,
    roomId,
    shortStayBookingId: bookingId,
  };

  await db.from("portal_lease_pipeline_records").upsert(
    {
      id: leaseId,
      manager_user_id: managerUserId,
      resident_email: guestEmail,
      property_id: propertyId,
      row_data: pipelineRow,
      updated_at: now,
    },
    { onConflict: "id" },
  );

  const applicationId = normalizeApplicationAxisId(`stay-${bookingId.replace(/[^a-z0-9]/gi, "").slice(0, 20)}`);
  const guestApplication: DemoApplicantRow = {
    id: applicationId,
    axisId: applicationId,
    name: guestName,
    email: guestEmail,
    propertyId,
    assignedPropertyId: propertyId,
    property: charge.propertyLabel?.trim() || propertyId,
    bucket: "approved",
    stage: "Approved",
    detail: `Short stay · ${checkIn} – ${checkOut}`,
    managerUserId,
    application: {
      propertyId,
      roomChoice1: `${propertyId}${LISTING_ROOM_CHOICE_SEP}${roomId}`,
      rentalType: "short_term",
      leaseStart: checkIn,
      leaseEnd: checkOut,
      fullLegalName: guestName,
      leaseTerm: "Short-Term Stay",
    } as RentalWizardFormState,
  };
  const sealed = sealApplicantRow(guestApplication, applicationId, managerUserId);
  await db.from("manager_application_records").upsert(
    {
      id: applicationId,
      manager_user_id: managerUserId,
      resident_email: guestEmail,
      property_id: propertyId,
      assigned_property_id: propertyId,
      row_data: sealed,
      updated_at: now,
    },
    { onConflict: "id" },
  );
}
