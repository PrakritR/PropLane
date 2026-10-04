/**
 * Facts for the booking record page (studio plan claude-2/services-vendors-1004, Bookings):
 * the stay's nights, what the rate adds up to, and the guest's earlier stays with this workspace.
 * Pure - the page hands in the entries and the charges it already holds.
 */
import type { PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";

const DAY_MS = 86_400_000;

/** Inclusive dates -> nights (a stay Oct 10 to Oct 13 inclusive is four nights; at least one). */
export function bookingNights(entry: Pick<PropertyBookingEntry, "start" | "end">): number {
  return Math.max(1, Math.round((Date.parse(entry.end) - Date.parse(entry.start)) / DAY_MS) + 1);
}

const money = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(amount);

/**
 * "4 nights x $153" and "$612" for a nightly rate. A weekly or monthly rate is not multiplied by
 * nights (proration is the lease's decision, not a guess here): the summary says the rate and the
 * nights and leaves the total out.
 */
export function bookingRateSummary(
  entry: Pick<PropertyBookingEntry, "rate" | "rateBasis" | "start" | "end" | "openEnded">,
): { calc: string; total: string | null } | null {
  if (entry.rate == null || entry.openEnded) return null;
  const nights = bookingNights(entry);
  const noun = nights === 1 ? "night" : "nights";
  if ((entry.rateBasis ?? "daily") === "daily") {
    return { calc: `${nights} ${noun} × ${money(entry.rate)}`, total: money(entry.rate * nights) };
  }
  const per = entry.rateBasis === "weekly" ? "week" : "month";
  return { calc: `${nights} ${noun} at ${money(entry.rate)} per ${per}`, total: null };
}

function sameGuest(a: PropertyBookingEntry, b: PropertyBookingEntry): boolean {
  const emailA = a.residentEmail?.trim().toLowerCase();
  const emailB = b.residentEmail?.trim().toLowerCase();
  if (emailA && emailB) return emailA === emailB;
  const nameA = a.summary.trim().toLowerCase();
  const nameB = b.summary.trim().toLowerCase();
  return Boolean(nameA) && nameA === nameB && a.source === b.source;
}

/** The guest's finished stays, other than this one: how many, and the latest. */
export function guestPastStays(
  entry: PropertyBookingEntry,
  entries: readonly PropertyBookingEntry[],
  today: string,
): { count: number; latest: PropertyBookingEntry | null } {
  const past = entries
    .filter((candidate) => candidate !== entry && candidate.bookingStatus !== "cancelled" && !candidate.openEnded && candidate.end < today && sameGuest(entry, candidate))
    .sort((a, b) => b.end.localeCompare(a.end));
  return { count: past.length, latest: past[0] ?? null };
}
