import type { PropertyBookingEntry } from "./property-bookings";
import { addDaysToDateKey } from "./bookings-ui";
import { PADSPLIT_SOURCE } from "@/lib/channel-calendar/channel-link";
import { occupancyForDay, occupancyStayKind, type OccupancyCapacities } from "@/lib/occupancy/snapshot";

export type BookingCalendarView = "day" | "week" | "month" | "year";
export const BOOKING_CALENDAR_VIEWS: BookingCalendarView[] = ["day", "week", "month", "year"];
export const bookingCheckout = (entry: PropertyBookingEntry) => entry.openEnded ? null : addDaysToDateKey(entry.end, 1);
export const bookingActiveOn = (entry: PropertyBookingEntry, day: string) => entry.start <= day && (entry.openEnded || entry.end >= day);
export const PADSPLIT_STATUS = "PadSplit";
export const isPadSplitStay = (entry: Pick<PropertyBookingEntry, "source" | "stayDetails">) =>
  entry.source === "block" && entry.stayDetails?.source?.trim().toLowerCase() === PADSPLIT_SOURCE.toLowerCase();
/**
 * A resident, as opposed to a pending hold: the entry an approved application draws (`source: "hold"`,
 * from `applicationHoldEntries`). A manager's or guest's unconfirmed hold is a `block` entry
 * (`bookingStatus: "hold"`) and stays "Hold" until confirmed; it is never `source: "hold"`.
 */
export const isResidentStay = (entry: Pick<PropertyBookingEntry, "source">) => entry.source === "hold";
export function calendarStatus(entry: PropertyBookingEntry, today: string): string {
  if (entry.bookingStatus === "cancelled" || entry.statusLabel?.toLowerCase() === "cancelled") return "Cancelled";
  // A PropLane stay linked to its channel reservation, or entered with Source PadSplit, is that site's booking.
  if (entry.channelLink?.provider === "airbnb") return "Airbnb";
  if (entry.channelLink?.provider === "booking_com") return "Booking.com";
  if (isPadSplitStay(entry)) return PADSPLIT_STATUS;
  if (entry.source === "airbnb") return "Airbnb";
  if (entry.source === "booking_com") return "Booking.com";
  if (entry.source === "vrbo") return "Vrbo";
  if (entry.source === "ical") return entry.channelLabel?.trim() || "Other calendar";
  if (!entry.openEnded && entry.end < today) return "Checked out";
  if ((entry.bookingStatus === "confirmed" || entry.statusLabel?.toLowerCase() === "confirmed")) return entry.start <= today ? "In-house" : "Confirmed";
  // A resident (an approved application's `hold` entry) is never a pending hold: their dates decide it.
  if (isResidentStay(entry)) return entry.start <= today ? "In-house" : "Confirmed";
  const kind = occupancyStayKind(entry);
  if (kind === "hold") return "Hold";
  if (kind === "block") return "Blocked";
  return entry.start <= today ? "In-house" : "Confirmed";
}
/** Statuses with a colour of their own; any other status is a channel's typed name (Houfy). */
const KNOWN_CALENDAR_STATUSES = new Set(["Hold", "Confirmed", "In-house", "Checked out", "Cancelled", "Blocked"]);
export function calendarStatusClass(status: string): string {
  // One colour per site a manager books on, so the legend and the bars agree: Airbnb rust, Booking.com navy, PadSplit violet.
  if (status === "Booking.com") return "bg-[#003b95] text-white";
  if (status === PADSPLIT_STATUS) return "bg-[#6b3fa0] text-white";
  if (status === "Airbnb" || status === "Vrbo" || !KNOWN_CALENDAR_STATUSES.has(status)) return "bg-[#9a4b1a] text-white";
  if (status === "Hold") return "border border-dashed border-amber-600 bg-amber-100 text-amber-900";
  if (status === "Confirmed") return "bg-[#3d7d46] text-white";
  if (status === "In-house") return "bg-primary text-white";
  // slate-500 (4.76:1 against white); slate-400 was 2.5:1 and failed WCAG AA for the bar's text.
  return "bg-slate-500 text-white";
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
/** The entries that fill a bed: residents, anything but a pending hold, and a confirmed hold. */
const occupyingEntries = (entries: readonly PropertyBookingEntry[]) =>
  entries.filter(entry => isResidentStay(entry) || occupancyStayKind(entry) !== "hold" || (entry.bookingStatus === "confirmed" || entry.statusLabel?.toLowerCase() === "confirmed"));
/**
 * Beds occupied across `propertyIds` over `days`, read through `occupancyForDay`
 * (never a `rooms.length` count). Occupancy visualization counts residents (in-house or booked) and excludes pending holds without
 * changing availability/capacity arbitration. `peak` is the most beds occupied
 * on any one day ("n of N occupied"); `percent` is bed-nights used over bed-nights offered.
 */
export function calendarOccupancySummary(entries: readonly PropertyBookingEntry[], days: string[], propertyIds: readonly string[], capacities: OccupancyCapacities) {
  const occupied = occupyingEntries(entries);
  let used = 0, total = 0, peak = 0, beds = 0;
  for (const day of days) {
    const cell = occupancyForDay(occupied, day, propertyIds, capacities);
    used += cell.occupied; total += cell.total; peak = Math.max(peak, cell.occupied); beds = Math.max(beds, cell.total);
  }
  return { peak, beds, percent: total ? Math.round(used / total * 100) : 0 };
}
/**
 * Beds occupied on ONE day across `propertyIds` (`occupied` of `beds`), through the same filter and the same
 * `occupancyForDay` as {@link calendarOccupancySummary}. This is the figure to print next to "tonight": a peak
 * over a range printed beside an average percent reads as a contradiction ("10 of 10 occupied · 69%").
 */
export function calendarOccupancyOnDay(entries: readonly PropertyBookingEntry[], day: string, propertyIds: readonly string[], capacities: OccupancyCapacities) {
  const cell = occupancyForDay(occupyingEntries(entries), day, propertyIds, capacities);
  return { occupied: cell.occupied, beds: cell.total };
}
/**
 * One house's occupancy over `days` in ONE pass: the beds filled and offered on each day, plus the
 * range average (bed-nights used over offered). The row strip and the "avg" figure both read this.
 */
export function calendarOccupancyDays(entries: readonly PropertyBookingEntry[], days: readonly string[], propertyId: string, capacities: OccupancyCapacities) {
  const occupied = occupyingEntries(entries);
  let used = 0, total = 0;
  const perDay = days.map(day => {
    const cell = occupancyForDay(occupied, day, [propertyId], capacities);
    used += cell.occupied; total += cell.total;
    return { occupied: cell.occupied, beds: cell.total };
  });
  return { perDay, percent: total ? Math.round(used / total * 100) : 0 };
}
export function calendarOccupancy(entries: readonly PropertyBookingEntry[], days: string[], propertyId: string, capacities: OccupancyCapacities) {
  return calendarOccupancySummary(entries, days, [propertyId], capacities).percent;
}
