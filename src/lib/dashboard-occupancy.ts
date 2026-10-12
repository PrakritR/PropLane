/**
 * What the manager dashboard says is occupied, read from the same occupancy snapshot Bookings,
 * the room rows, the public picker and the bots read (`/api/portal/occupancy`).
 *
 * Occupied is NOT "fully signed leases": a hand-added resident whose lease is manager-attested,
 * an approved applicant waiting on a signature, an Airbnb stay and a room block all take a room
 * today. Pure, so the shaping is unit-tested without a store.
 *
 * The card reads exactly nine days — today and each period's cut — so that is all the snapshot is
 * asked for (`days=`). Asking for eight months of day cells per house made the landing page the
 * heaviest read in the app for numbers it never looked at, and Supabase egress is a constraint.
 */
import type { OccupancySnapshotResponse } from "@/lib/channel-calendar/client";
import type { DashboardPeriod } from "@/lib/dashboard-kpis";

/** The day a period's figure is read from: its last day, never past today. */
export function dashboardOccupancyPeriodDayKey(period: DashboardPeriod, today: string): string {
  // Period `end` is exclusive; the current period has not ended, so its cut is today.
  const last = new Date(period.end - 1);
  const lastKey = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}-${String(last.getDate()).padStart(2, "0")}`;
  return lastKey > today ? today : lastKey;
}

/** Every day the card reads, ascending: today plus each period's cut. One source, so the ask and the read cannot drift. */
export function dashboardOccupancyDayKeys(today: string, periods: readonly DashboardPeriod[]): string[] {
  return [...new Set([today, ...periods.map((period) => dashboardOccupancyPeriodDayKey(period, today))])].sort();
}

export function dashboardOccupancyUrl(
  propertyIds: readonly string[],
  today: string,
  periods: readonly DashboardPeriod[] = [],
): string {
  const days = dashboardOccupancyDayKeys(today, periods);
  const params = new URLSearchParams({
    propertyIds: [...new Set(propertyIds)].sort().join(","),
    from: days[0]!,
    to: days[days.length - 1]!,
    days: days.join(","),
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

/**
 * Null when the response is not a snapshot, or does not carry every day the card reads: a day the
 * server did not answer for is unknown, never a zero that would draw a dip that did not happen.
 */
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
  const occupiedByPeriod: number[] = [];
  for (const period of periods) {
    const cell = byDay.get(dashboardOccupancyPeriodDayKey(period, today));
    if (!cell) return null;
    occupiedByPeriod.push(cell.occupied);
  }
  return { byProperty, occupiedToday: todayCell.occupied, occupiedByPeriod };
}

/**
 * An answered portfolio with nothing in it: every day the card reads, zero occupied, no houses.
 * A manager whose first house is not added yet gets "0%", not a read that never comes back.
 */
export function emptyDashboardOccupancySnapshot(days: readonly string[]): OccupancySnapshotResponse {
  return {
    days: days.map((dayKey) => ({ dayKey, occupied: 0, total: 0, checkIns: 0, checkOuts: 0, houses: [] })),
    stays: [],
    version: "empty",
  };
}
