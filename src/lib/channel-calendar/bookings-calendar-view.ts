import type { PropertyBookingEntry } from "./property-bookings";
import { addDaysToDateKey } from "./bookings-ui";
import { occupancyForDay, occupancyStayKind, type OccupancyCapacities } from "@/lib/occupancy/snapshot";

export type BookingCalendarView = "day" | "week" | "month" | "year";
export const BOOKING_CALENDAR_VIEWS: BookingCalendarView[] = ["day", "week", "month", "year"];
export const bookingCheckout = (entry: PropertyBookingEntry) => entry.openEnded ? null : addDaysToDateKey(entry.end, 1);
export const bookingActiveOn = (entry: PropertyBookingEntry, day: string) => entry.start <= day && (entry.openEnded || entry.end >= day);
export function calendarStatus(entry: PropertyBookingEntry, today: string): string {
  if (entry.bookingStatus === "cancelled" || entry.statusLabel?.toLowerCase() === "cancelled") return "Cancelled";
  if (entry.source === "airbnb") return "Airbnb";
  if (entry.source === "booking_com") return "Booking.com";
  if (entry.source === "vrbo") return "Vrbo";
  if (!entry.openEnded && entry.end < today) return "Checked out";
  if ((entry.bookingStatus === "confirmed" || entry.statusLabel?.toLowerCase() === "confirmed")) return entry.start <= today ? "In-house" : "Confirmed";
  const kind = occupancyStayKind(entry);
  if (kind === "hold") return "Hold";
  if (kind === "block") return "Blocked";
  return entry.start <= today ? "In-house" : "Confirmed";
}
export function calendarStatusClass(status: string): string {
  if (status === "Airbnb" || status === "Booking.com" || status === "Vrbo") return "bg-[#9a4b1a] text-white";
  if (status === "Hold") return "border border-dashed border-amber-600 bg-amber-100 text-amber-900";
  if (status === "Confirmed") return "bg-[#3d7d46] text-white";
  if (status === "In-house") return "bg-primary text-white";
  return "bg-slate-400 text-white";
}
/** Entries store the last occupied night. All displayed intervals use exclusive checkout. */
export function calendarRange(view: BookingCalendarView, anchor: string): string[] {
  const [year, month] = anchor.split("-").map(Number);
  if (view === "day") return [anchor];
  if (view === "year") return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}-01`);
  const start = view === "month" ? `${year}-${String(month).padStart(2, "0")}-01` : addDaysToDateKey(anchor, -((new Date(`${anchor}T12:00:00`).getDay() + 6) % 7));
  return Array.from({ length: view === "month" ? new Date(year!, month!, 0).getDate() : 7 }, (_, i) => addDaysToDateKey(start, i));
}
export function bookingLanes(entries: readonly PropertyBookingEntry[]) {
  const ends: string[] = [];
  return [...entries].sort((a,b) => a.start.localeCompare(b.start)).map(entry => {
    let lane = ends.findIndex(end => end < entry.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = entry.openEnded ? "9999-12-31" : entry.end;
    return { entry, lane };
  });
}
export function occupancyCell(entries: readonly PropertyBookingEntry[], day: string, capacity = 1) {
  const active = entries.filter(entry => bookingActiveOn(entry, day));
  const outgoing = entries.filter(entry => bookingCheckout(entry) === day);
  const incoming = active.filter(entry => entry.start === day);
  const conflicts = active.length > capacity;
  const names = (rows: PropertyBookingEntry[]) => rows.map(row => row.residentName || row.summary).join(", ");
  const reserved = active.length > 0 && active.every(entry => ["hold", "block"].includes(occupancyStayKind(entry)) && entry.bookingStatus !== "confirmed" && entry.statusLabel?.toLowerCase() !== "confirmed");
  return { active, outgoing, incoming, conflicts, label: conflicts ? "Overlapping stays" : outgoing.length || incoming.length ? `${names(outgoing) || "Vacant"} → ${names(active) || "Vacant"}` : active.length ? `${reserved ? "Reserved · " : ""}${names(active)}` : "Vacant" };
}
/**
 * Beds occupied across `propertyIds` over `days`, read through `occupancyForDay`
 * (never a `rooms.length` count). Occupancy visualization excludes holds without
 * changing availability/capacity arbitration. `peak` is the most beds occupied
 * on any one day ("n of N occupied"); `percent` is bed-nights used over bed-nights offered.
 */
export function calendarOccupancySummary(entries: readonly PropertyBookingEntry[], days: string[], propertyIds: readonly string[], capacities: OccupancyCapacities) {
  const occupied = entries.filter(entry => occupancyStayKind(entry) !== "hold" || (entry.bookingStatus === "confirmed" || entry.statusLabel?.toLowerCase() === "confirmed"));
  let used = 0, total = 0, peak = 0, beds = 0;
  for (const day of days) {
    const cell = occupancyForDay(occupied, day, propertyIds, capacities);
    used += cell.occupied; total += cell.total; peak = Math.max(peak, cell.occupied); beds = cell.total;
  }
  return { peak, beds, percent: total ? Math.round(used / total * 100) : 0 };
}
export function calendarOccupancy(entries: readonly PropertyBookingEntry[], days: string[], propertyId: string, capacities: OccupancyCapacities) {
  return calendarOccupancySummary(entries, days, [propertyId], capacities).percent;
}
