import "server-only";

/**
 * The instant-book rule for a signed-in guest's short stay.
 *
 * A stay is written `confirmed` at once only when ALL of these hold: the listing's
 * "Returning guests book instantly" switch is on (`shortStayInstantBookReturning`, default OFF, saved on
 * the submission and read here - never resolved from a default downstream), the guest has at least one
 * COMPLETED stay on this listing, and the host has not declined one of their requests here. A past stay
 * is theirs by login, by login address, or by a VERIFIED phone - never by a number they just typed into
 * Settings. Every other request is a 24-hour hold the host approves. "All nights are free" is the caller's check
 * (`roomAvailabilityForRange` per range); the capacity trigger on `portal_schedule_records` stays the
 * final arbiter, so a night taken between the check and the write is a 409 on that range alone.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import {
  CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE,
  ROOM_DATE_BLOCK_RECORD_TYPE,
} from "@/lib/portal-schedule-record-scope";
import { isPlaceholderImportEmail } from "@/lib/portfolio-import/placeholder-email";
import { postgrestFilterValue } from "@/lib/supabase/or-filter";

/** Default OFF (captain, Oct 20): a web request is an application the host answers; only a listing whose host ticked the switch confirms a returning guest at once. */
export function listingBooksReturningGuestsInstantly(submission: { shortStayInstantBookReturning?: boolean } | null | undefined): boolean {
  return submission?.shortStayInstantBookReturning === true;
}

export type GuestIdentity = {
  userId?: string | null;
  email?: string | null;
  phone?: string | null;
  /**
   * Has this phone been proved to be theirs (`profiles.phone_verified_at`)? A resident edits
   * `profiles.phone` freely in Settings, so an unverified number is a claim, not an identity: without
   * this, typing the number of someone who has stayed here would buy their instant-book standing.
   */
  phoneVerified?: boolean;
};

type StayRow = { record_type?: string | null; row_data?: Record<string, unknown> | null };

function rowMatchesGuest(row: Record<string, unknown>, who: GuestIdentity): boolean {
  if (who.userId && row.residentUserId === who.userId) return true;
  const email = who.email?.trim().toLowerCase();
  // A phone-keyed placeholder login is not an address anyone typed: it never matches a stay's email.
  if (email && !isPlaceholderImportEmail(email) && typeof row.residentEmail === "string" && row.residentEmail.trim().toLowerCase() === email) return true;
  if (!who.phoneVerified) return false;
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

/**
 * The `or()` filter that fetches only the rows `rowMatchesGuest` can match - the same three arms, in
 * SQL. Null when the guest has no identity at all, which must read no rows rather than the house's.
 *
 * Without it the Book-again sheet pulled every stay row of the property, with its whole `row_data`,
 * on each debounced dry run (120 an hour per guest): a busy house is megabytes of JSONB for one
 * person picking dates, plus every other guest's contact details in memory. The in-memory matcher
 * stays the authority, so a widening `ilike` only ever costs a row that is then re-checked.
 */
export function returningGuestRowFilter(who: GuestIdentity): string | null {
  const clauses: string[] = [];
  const userId = who.userId?.trim();
  if (userId) clauses.push(`row_data->>residentUserId.eq.${postgrestFilterValue(userId)}`);
  const email = who.email?.trim().toLowerCase();
  // `ilike` with no wildcard is an exact, case-insensitive compare: a legacy row may store the
  // address as the manager typed it.
  if (email && !isPlaceholderImportEmail(email)) clauses.push(`row_data->>residentEmail.ilike.${postgrestFilterValue(email)}`);
  const phone = who.phoneVerified ? normalizeE164(who.phone ?? "") : "";
  if (phone) clauses.push(`row_data->>residentPhone.eq.${postgrestFilterValue(phone)}`);
  return clauses.length ? clauses.join(",") : null;
}

/** Reads this guest's stay rows on the listing and answers `evaluateReturningGuest`. A failed read is "not returning" (a hold, never a surprise confirm). */
export async function guestIsReturning(
  db: SupabaseClient,
  input: { propertyId: string; who: GuestIdentity; today: string },
): Promise<boolean> {
  const scope = returningGuestRowFilter(input.who);
  if (!scope) return false;
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("record_type, row_data")
    .eq("property_id", input.propertyId)
    .in("record_type", [ROOM_DATE_BLOCK_RECORD_TYPE, CANCELLED_ROOM_DATE_BLOCK_RECORD_TYPE])
    .or(scope)
    .limit(500);
  if (error) return false;
  return evaluateReturningGuest((data ?? []) as StayRow[], input.who, input.today);
}

/** The status every range of a request is written with. */
export function instantBookStatus(input: { flagOn: boolean; returning: boolean }): "confirmed" | "hold" {
  return input.flagOn && input.returning ? "confirmed" : "hold";
}
