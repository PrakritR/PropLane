/**
 * What the manager dashboard says is occupied, read from the same occupancy snapshot Bookings,
 * the room rows, the public picker and the bots read (`/api/portal/occupancy`).
 *
 * Occupied is NOT "fully signed leases": a hand-added resident whose lease is manager-attested,
 * an approved applicant waiting on a signature, an Airbnb stay and a room block all take a room
 * today. Pure, so the shaping is unit-tested without a store.
 */
import { shiftDateKey } from "@/lib/room-availability-timeline";
import type { OccupancySnapshotResponse } from "@/lib/channel-calendar/client";
import type { DashboardPeriod } from "@/lib/dashboard-kpis";

/** The longest period history the KPI card draws: eight months or eight 30-day windows. */
export const DASHBOARD_OCCUPANCY_HISTORY_DAYS = 250;

export function dashboardOccupancyWindow(today: string): { from: string; to: string } {
  return { from: shiftDateKey(today, -DASHBOARD_OCCUPANCY_HISTORY_DAYS), to: today };
}

export function dashboardOccupancyUrl(propertyIds: readonly string[], today: string): string {
  const { from, to } = dashboardOccupancyWindow(today);
  const params = new URLSearchParams({
    propertyIds: [...new Set(propertyIds)].sort().join(","),
    from,
    to,
  });
  return `/api/portal/occupancy?${params}`;
}

export type DashboardOccupancy = {
  /** Rooms (beds) occupied today, per house. A house the snapshot did not answer for is absent. */
  byProperty: ReadonlyMap<string, number>;
  /** Occupied today across every house asked about. */
  occupiedToday: number;
  /** Occupied at the end of each period (today for the current one), same order as `periods`. */
  occupiedByPeriod: number[];
};

/** Null when the response is not a snapshot (a malformed answer is unknown, never zero). */
export function dashboardOccupancyFromSnapshot(
  snapshot: unknown,
  today: string,
  periods: readonly DashboardPeriod[],
): DashboardOccupancy | null {
  const days = (snapshot as OccupancySnapshotResponse | null)?.days;
  if (!Array.isArray(days)) return null;
  const byDay = new Map(days.map((day) => [day.dayKey, day] as const));
  const todayCell = byDay.get(today);
  if (!todayCell) return null;
  const byProperty = new Map<string, number>();
  for (const house of todayCell.houses ?? []) byProperty.set(house.propertyId, house.occupied);
  const occupiedByPeriod = periods.map((period) => {
    // Period `end` is exclusive; the current period has not ended, so its cut is today.
    const last = new Date(period.end - 1);
    const lastKey = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
    const key = lastKey > today ? today : lastKey;
    return byDay.get(key)?.occupied ?? 0;
  });
  return { byProperty, occupiedToday: todayCell.occupied, occupiedByPeriod };
}
