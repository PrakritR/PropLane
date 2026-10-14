import "server-only";

/**
 * The instant-book rule for a signed-in guest's short stay.
 *
 * A stay is written `confirmed` at once only when ALL of these hold: the listing's
 * "Returning guests book instantly" switch is on (`shortStayInstantBookReturning`, default on, saved on
 * the submission and read here - never resolved from a default downstream), the guest has at least one
 * COMPLETED stay on this listing, and the host has not declined one of their requests here. Every other
 * request is a 24-hour hold the host approves. "All nights are free" is the caller's check
 * (`roomAvailabilityForRange` per range); the capacity trigger on `portal_schedule_records` stays the
 * final arbiter, so a night taken between the check and the write is a 409 on that range alone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import {
  CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
  ROOM_DATE_BLOCK_RECORD_TYPE,
} from "@/lib/portal-schedule-record-scope";

/** Default on: a listing that never saved the switch lets returning guests book instantly. */
export function listingBooksReturningGuestsInstantly(submission: { shortStayInstantBookReturning?: boolean } | null | undefined): boolean {
  return submission?.shortStayInstantBookReturning !== false;
}

export type GuestIdentity = { userId?: string | null; email?: string | null; phone?: string | null };

type StayRow = { record_type?: string | null; row_data?: Record<string, unknown> | null };

function rowMatchesGuest(row: Record<string, unknown>, who: GuestIdentity): boolean {
  if (who.userId && row.residentUserId === who.userId) return true;
  const email = who.email?.trim().toLowerCase();
  if (email && typeof row.residentEmail === "string" && row.residentEmail.trim().toLowerCase() === email) return true;
  const phone = normalizeE164(who.phone ?? "");
  return Boolean(phone && normalizeE164(String(row.residentPhone ?? "")) === phone);
}

/**
 * Pure: is this guest "returning" on the listing, from the listing's stay rows?
 * Returning = a confirmed stay whose check-out has passed, and no request the host declined.
 */
export function evaluateReturningGuest(rows: readonly StayRow[], who: GuestIdentity, today: string): boolean {
  let completed = false;
  for (const row of rows) {
    const data = row.row_data;
    if (!data || !rowMatchesGuest(data, who)) continue;
    const decision = (data.stayDetails as { decision?: string } | undefined)?.decision;
    if (decision === "declined") return false;
    if (
      row.record_type !== CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE &&
      data.bookingStatus === "confirmed" &&
      String(data.checkOut ?? "") <= today
    ) {
      completed = true;
    }
  }
  return completed;
}

/** Reads the listing's stay rows and answers `evaluateReturningGuest`. A failed read is "not returning" (a hold, never a surprise confirm). */
export async function guestIsReturning(
  db: SupabaseClient,
  input: { propertyId: string; who: GuestIdentity; today: string },
): Promise<boolean> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("record_type, row_data")
    .eq("property_id", input.propertyId)
    .in("record_type", [ROOM_DATE_BLOCK_RECORD_TYPE, CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE])
    .limit(2000);
  if (error) return false;
  return evaluateReturningGuest((data ?? []) as StayRow[], input.who, input.today);
}

/** The status every range of a request is written with. */
export function instantBookStatus(input: { flagOn: boolean; returning: boolean }): "confirmed" | "hold" {
  return input.flagOn && input.returning ? "confirmed" : "hold";
}
