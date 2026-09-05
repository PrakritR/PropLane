import { bookedDayKeyCountInMonth, type PropertyBookingEntry } from "@/lib/channel-calendar/property-bookings";
import { addDays, dateKey, startOfLocalDay, startOfWeekSunday } from "@/lib/room-availability-calendar";

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

export function bookingSourceLabel(source: PropertyBookingEntry["source"]): string {
  return source === "airbnb" ? "Airbnb" : "PropLane";
}

export function bookingStatusTone(
  entry: PropertyBookingEntry,
): "confirmed" | "pending" | "info" {
  if (entry.source === "airbnb") return "pending";
  const status = entry.statusLabel?.toLowerCase() ?? "";
  if (status.includes("sign") || status.includes("pending") || status.includes("draft")) {
    return "pending";
  }
  return "confirmed";
}
