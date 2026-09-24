import { bookedDayKeyCountInMonth, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDays, dateKey, startOfLocalDay, startOfWeekSunday } from "@/lib/room-availability-calendar";
import { leaseDetailHref, propertyDetailHref } from "@/lib/portal-detail-routes";

export type BookingsListTabId = "all" | "check_ins" | "check_outs";

/** Portfolio list buckets (Calendar is routed separately). */
export type ManagerBookingListBucketId = "upcoming" | "inhouse" | "past";

export type BookingsHubMode = "calendar" | "list";

export type BookingsOccupancyStats = {
  bookedNights: number;
  checkInsThisWeek: number;
  occupancyPercent: number;
};

export function bookingEntryKey(entry: PropertyBookingEntry): string {
  return `${entry.source}:${entry.propertyId}:${entry.roomId}:${entry.start}:${entry.end}:${entry.summary}`;
}

export function addDaysToDateKey(dayKey: string, days: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  if (!y || !m || !d) return dayKey;
  return dateKey(addDays(new Date(y, m - 1, d), days));
}

export function bookingEntryMatchesSearch(
  entry: PropertyBookingEntry,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    entry.summary,
    entry.propertyLabel,
    entry.roomLabel,
    entry.residentName,
    entry.reason,
    formatBookingStayRange(entry.start, entry.end, entry.openEnded),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

export function filterBookingsBySearch(
  entries: readonly PropertyBookingEntry[],
  query: string,
): PropertyBookingEntry[] {
  const needle = query.trim();
  if (!needle) return [...entries];
  return entries.filter((entry) => bookingEntryMatchesSearch(entry, needle));
}

export function formatBookingStayRange(
  start: string,
  end: string,
  openEnded?: boolean,
): string {
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    if (!y || !m || !d) return iso;
    return new Date(y, m - 1, d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };
  if (openEnded || start === end) return `${fmt(start)} onward`;
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * The overlap refusal, named — "Room 9 is booked Sep 1 – Aug 31 by Prakrit"
 * (PLAN-0920-1058, area 1e), never a generic "these dates are taken". Shared
 * by the Edit dates and Move room sheets so the wording never drifts between
 * the two.
 */
export function describeBookingConflict(
  conflict: Pick<PropertyBookingEntry, "roomLabel" | "start" | "end" | "openEnded" | "summary">,
  fallbackRoomLabel: string,
): string {
  const room = conflict.roomLabel?.trim() || fallbackRoomLabel;
  const range = formatBookingStayRange(conflict.start, conflict.end, conflict.openEnded);
  const who = conflict.summary?.trim();
  return who ? `${room} is booked ${range} by ${who}` : `${room} is booked ${range}`;
}

export function classifyBookingListBucket(
  entry: PropertyBookingEntry,
  todayKey: string,
): ManagerBookingListBucketId {
  if (entry.openEnded) {
    return entry.start > todayKey ? "upcoming" : "inhouse";
  }
  if (entry.start > todayKey) return "upcoming";
  if (entry.end < todayKey) return "past";
  if (entry.start <= todayKey && entry.end >= todayKey) return "inhouse";
  return entry.end < todayKey ? "past" : "upcoming";
}

export function bookingsForListBucket(
  entries: readonly PropertyBookingEntry[],
  bucket: ManagerBookingListBucketId,
  todayKey: string,
): PropertyBookingEntry[] {
  return [...entries]
    .filter((entry) => classifyBookingListBucket(entry, todayKey) === bucket)
    .sort(
      (a, b) => a.start.localeCompare(b.start) || a.summary.localeCompare(b.summary),
    );
}

export function countBookingsByListBucket(
  entries: readonly PropertyBookingEntry[],
  todayKey: string,
): Record<ManagerBookingListBucketId, number> {
  const counts: Record<ManagerBookingListBucketId, number> = {
    upcoming: 0,
    inhouse: 0,
    past: 0,
  };
  for (const entry of entries) {
    counts[classifyBookingListBucket(entry, todayKey)] += 1;
  }
  return counts;
}

export function bookingsForListTab(
  entries: readonly PropertyBookingEntry[],
  tab: BookingsListTabId,
  todayKey: string,
  horizonDays = 14,
): PropertyBookingEntry[] {
  const horizonEnd = addDaysToDateKey(todayKey, horizonDays);
  const sorted = [...entries].sort((a, b) => a.start.localeCompare(b.start) || a.summary.localeCompare(b.summary));
  if (tab === "all") return sorted;
  if (tab === "check_ins") {
    return sorted.filter((entry) => entry.start >= todayKey && entry.start <= horizonEnd);
  }
  return sorted.filter(
    (entry) => !entry.openEnded && entry.end >= todayKey && entry.end <= horizonEnd,
  );
}

function checkInsInRange(
  entries: readonly PropertyBookingEntry[],
  rangeStartKey: string,
  rangeEndKey: string,
): number {
  return entries.filter(
    (entry) => entry.start >= rangeStartKey && entry.start <= rangeEndKey,
  ).length;
}

export function bookingOccupancyStats(
  entries: readonly PropertyBookingEntry[],
  anchor: Date,
  view: "day" | "week" | "month" | "year",
): BookingsOccupancyStats {
  const today = startOfLocalDay(anchor);
  const year = today.getFullYear();
  const month = today.getMonth();
  const weekStart = startOfWeekSunday(today);
  const weekEnd = addDays(weekStart, 6);

  let bookedNights = 0;
  let daysInPeriod = 1;

  if (view === "day") {
    bookedNights = entries.some((e) => dateKey(today) >= e.start && dateKey(today) <= e.end) ? 1 : 0;
    daysInPeriod = 1;
  } else if (view === "week") {
    bookedNights = 0;
    for (let i = 0; i < 7; i++) {
      const key = dateKey(addDays(weekStart, i));
      if (entries.some((e) => key >= e.start && key <= e.end)) bookedNights += 1;
    }
    daysInPeriod = 7;
  } else if (view === "month") {
    bookedNights = bookedDayKeyCountInMonth(entries, year, month);
    daysInPeriod = new Date(year, month + 1, 0).getDate();
  } else {
    bookedNights = 0;
    for (let m = 0; m < 12; m++) {
      bookedNights += bookedDayKeyCountInMonth(entries, year, m);
    }
    daysInPeriod = 365 + (new Date(year, 2, 0).getDate() === 29 ? 1 : 0);
  }

  const checkInsThisWeek = checkInsInRange(entries, dateKey(weekStart), dateKey(weekEnd));
  const occupancyPercent =
    daysInPeriod > 0 ? Math.min(100, Math.round((bookedNights / daysInPeriod) * 100)) : 0;

  return { bookedNights, checkInsThisWeek, occupancyPercent };
}

/** Calendar dot / heat colour per source; the legend under the grid uses the same map. */
export function bookingSourceDotClass(source: PropertyBookingEntry["source"]): string {
  switch (source) {
    case "proplane":
      return "bg-primary";
    case "airbnb":
    case "booking_com":
      return "bg-[var(--status-pending-fg)]";
    case "hold":
      return "bg-[var(--status-confirmed-fg)]";
    default:
      return "bg-muted";
  }
}

export function bookingSourceBadgeTone(
  source: PropertyBookingEntry["source"],
): "pending" | "info" | "confirmed" | "neutral" {
  switch (source) {
    case "airbnb":
    case "booking_com":
      return "pending";
    case "hold":
      return "confirmed";
    case "block":
      return "neutral";
    default:
      return "info";
  }
}

/**
 * Where "Edit dates" / "Move room" should actually go for a booking this
 * screen cannot edit directly (PLAN-0920-1058, area 1c): a signed lease's
 * dates belong to the Lease record, and a channel import is owned by Airbnb.
 * `null` for a block (editable here) or any other source (still "Coming soon").
 */
export function bookingOpenTarget(
  entry: PropertyBookingEntry,
  basePath: string,
): { href: string; label: string } | null {
  if (entry.source === "proplane" && entry.leaseId) {
    return { href: leaseDetailHref(basePath, "manager", entry.leaseId), label: "Open lease" };
  }
  if (entry.source === "airbnb" || entry.source === "booking_com") {
    return { href: propertyDetailHref(basePath, "all", entry.propertyId, "preview"), label: "Open listing" };
  }
  return null;
}

/**
 * Why a booking cannot be deleted right now, or `null` when it can. No
 * existing rule covers this yet, so the fallback is the plain one the
 * captain asked for: a hold with a resident attached that is in-house TODAY
 * is an active tenancy, not a reservation to cancel — the manager moves the
 * resident out first.
 */
export function bookingDeleteRefusalReason(
  entry: Pick<PropertyBookingEntry, "residentName" | "start" | "end" | "openEnded">,
  todayKey: string,
): string | null {
  if (!entry.residentName?.trim()) return null;
  const inHouseToday = entry.openEnded ? entry.start <= todayKey : entry.start <= todayKey && entry.end >= todayKey;
  if (!inHouseToday) return null;
  return `${entry.residentName.trim()} is in-house today — move them out before removing this booking.`;
}

export function bookingSourceLabel(source: PropertyBookingEntry["source"]): string {
  switch (source) {
    case "airbnb":
      return "Airbnb";
    case "booking_com":
      return "Booking.com";
    case "hold":
      return "Hold";
    case "block":
      return "Blocked";
    default:
      return "PropLane";
  }
}

export function bookingStatusTone(
  entry: PropertyBookingEntry,
): "confirmed" | "pending" | "info" {
  if (entry.source === "airbnb" || entry.source === "booking_com") return "pending";
  const status = entry.statusLabel?.toLowerCase() ?? "";
  if (status.includes("sign") || status.includes("pending") || status.includes("draft")) {
    return "pending";
  }
  return "confirmed";
}
