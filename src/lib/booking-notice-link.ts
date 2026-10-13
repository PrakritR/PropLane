/**
 * A booking notice (new / cancelled Airbnb booking, check-in and check-out reminders) carries the
 * booking RECORD page as its last line. The Assistant thread turns that into an "Open booking"
 * action. Bucket pages (/bookings/calendar, upcoming, ...) are not records and never match.
 */
const BUCKETS = new Set(["calendar", "upcoming", "inhouse", "past"]);

export function bookingRecordPathFromNotice(body: string | null | undefined): string | null {
  const match = /\/portal\/bookings\/([^\s/)]+)\/[a-z-]+/i.exec(body ?? "");
  if (!match) return null;
  if (BUCKETS.has(match[1]!.toLowerCase())) return null;
  return match[0];
}
