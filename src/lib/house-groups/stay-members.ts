/**
 * Who lives in a house, read off the Bookings occupancy snapshot. Pure: the SMS house group
 * (`residents.server.ts`) and the in-app house chat (`src/lib/house-chat`) both start from the same
 * three facts, so the rule lives once.
 *
 * A stay with a `resident` payload is an executed lease or an approved long-term hold. A guest-portal
 * short stay is a room block with no such payload, and any stay shorter than a month is a short stay.
 */

/** A stay at least this long is a long-term resident (the short-stay product caps at 28 nights). */
export const LONG_TERM_MIN_DAYS = 30;

export type OccupancyStayLike = {
  propertyId: string;
  roomLabel: string;
  start: string;
  end: string;
  openEnded?: boolean;
  resident?: { residentName?: string; residentEmail?: string; residentPhone?: string; source: string } | undefined;
};

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
}

export function firstNameOf(name: string | null | undefined): string {
  const first = String(name ?? "").trim().split(/\s+/)[0] ?? "";
  return first.replace(/[^\p{L}'-]/gu, "").slice(0, 40);
}

/** Does this stay cover `today` (inclusive)? An open-ended stay has no end. */
export function stayCoversDay(stay: Pick<OccupancyStayLike, "start" | "end" | "openEnded">, today: string): boolean {
  return !(stay.start > today || (!stay.openEnded && stay.end < today));
}

/** Open-ended, or at least `LONG_TERM_MIN_DAYS` long. */
export function stayIsLongTerm(stay: Pick<OccupancyStayLike, "start" | "end" | "openEnded">): boolean {
  return Boolean(stay.openEnded) || dayDiff(stay.start, stay.end) >= LONG_TERM_MIN_DAYS;
}
