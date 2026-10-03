import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { HouseholdCharge } from "@/lib/household-charges";
import {
  CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
  ROOM_DATE_BLOCK_RECORD_TYPE,
} from "@/lib/portal-schedule-record-scope";
import { LISTING_ROOM_CHOICE_SEP } from "@/lib/rental-application/data";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

/**
 * Short stays are booked through the resident-portal application -> lease ->
 * payments flow (listing "Apply short term"). The old public hold-and-pay
 * booking entry is gone; what remains settles holds that were already in
 * flight when it was retired (cron expiry and the Stripe webhook).
 */

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
