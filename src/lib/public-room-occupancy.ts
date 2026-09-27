/** Anonymous aggregate capacity spans, never application/resident identities. */
import { evaluateRoomOccupancy, normalizeRoomOccupancyCapacity } from "@/lib/rental-application/room-occupancy";

export type PublicRoomOccupancy = { roomChoice: string; spans: { start: string; end: string | null; count: number }[] };

/** Listing dates use Pacific wall days, including during the UTC evening rollover. */
export function pacificListingDay(now = new Date()): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "numeric", day: "numeric",
  }).formatToParts(now);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return new Date(value("year"), value("month") - 1, value("day"));
}

/** Match the public listing's capacity-based availability label from its anonymous spans. */
export function availabilityLabelFromPublicSpans(
  spans: PublicRoomOccupancy["spans"],
  rawCapacity: unknown,
  now = new Date(),
): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const placements = spans.flatMap((span, index) => Array.from({ length: span.count }, (_, bed) => ({
    id: `${index}:${bed}`,
    start: new Date(`${span.start}T12:00:00`),
    end: span.end ? new Date(`${span.end}T12:00:00`) : null,
  })));
  const start = placements.reduce((earliest, placement) => placement.start < earliest ? placement.start : earliest, today);
  const { fullyBookedIntervals } = evaluateRoomOccupancy({
    capacity: normalizeRoomOccupancyCapacity(rawCapacity), placements, windowStart: start, windowEnd: null,
  });
  const format = (date: Date) => date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const current = fullyBookedIntervals.find((window) => window.start <= today && (!window.end || today <= window.end));
  if (current) return current.end ? `Unavailable until ${format(current.end)}` : "Unavailable (occupied)";
  const next = fullyBookedIntervals.find((window) => window.start > today);
  if (next) {
    const lastOpenDay = new Date(next.start.getFullYear(), next.start.getMonth(), next.start.getDate() - 1);
    if (lastOpenDay >= today) return `Available now until ${format(lastOpenDay)}`;
  }
  return "Available now";
}
export function aggregateRoomOccupancy(placements: { start: string; end: string | null; count?: number }[]): PublicRoomOccupancy["spans"] {
  const changes = new Map<string, number>();
  const bump = (day: string, count: number) => changes.set(day, (changes.get(day) ?? 0) + count);
  for (const row of placements) {
    bump(row.start, row.count ?? 1);
    if (row.end && row.end < "9999-12-31") { const day = new Date(`${row.end}T12:00:00Z`); day.setUTCDate(day.getUTCDate() + 1); bump(day.toISOString().slice(0, 10), -(row.count ?? 1)); }
  }
  const dates = [...changes.keys()].sort(); let count = 0;
  const spans: PublicRoomOccupancy["spans"] = [];
  dates.forEach((day, index) => {
    count += changes.get(day) ?? 0;
    if (!count) return;
    const next = dates[index + 1]; const end = next ? new Date(`${next}T12:00:00Z`) : null;
    if (end) end.setUTCDate(end.getUTCDate() - 1);
    spans.push({ start: day, end: end?.toISOString().slice(0, 10) ?? null, count });
  });
  return spans;
}
