/**
 * The only operating facts the captain has stated for the "we run homes
 * ourselves" story (2026-10-18). Nothing else may be shown as a figure.
 *
 *   - 3 homes: 5257 Brooklyn, 5259 Brooklyn, 4709A 8th Ave (Seattle)
 *   - 28 rooms, 26 of them occupied on 2026-10-18. Since 2026-11-10 (captain's decision, Nov 9
 *     review) the figure is computed live from the occupancy snapshot, cached hourly, so it agrees
 *     with the Dashboard (`track-record-live.server.ts`). The 26 / 28 below is only the last
 *     stated value: the fallback when the live read fails or does not match the three homes.
 *   - six-figure profit (his words; no dollar amount, never invent one)
 *
 * Any other metric (response time, rent collected, vacancy days, ...) needs a
 * number from the captain. The constants below are deliberately empty: a metric
 * with an empty value is not rendered anywhere (`trackRecordMetrics`).
 */

export const TRACK_RECORD = {
  homes: 3,
  roomsOccupied: 26,
  roomsTotal: 28,
  profit: "Six-figure profit",
} as const;

export type RoomOccupancy = { roomsOccupied: number; roomsTotal: number };

/** The last stated figure: what the page shows when the live read is unavailable. */
export const STATED_ROOM_OCCUPANCY: RoomOccupancy = {
  roomsOccupied: TRACK_RECORD.roomsOccupied,
  roomsTotal: TRACK_RECORD.roomsTotal,
};

function validOccupancy(o: RoomOccupancy | null | undefined): o is RoomOccupancy {
  return (
    !!o &&
    Number.isInteger(o.roomsOccupied) &&
    Number.isInteger(o.roomsTotal) &&
    o.roomsTotal > 0 &&
    o.roomsOccupied >= 0 &&
    o.roomsOccupied <= o.roomsTotal
  );
}

/** The live figure when it is sane, else the last stated one. */
export function resolveRoomOccupancy(live: RoomOccupancy | null | undefined): RoomOccupancy {
  return validOccupancy(live) ? { roomsOccupied: live.roomsOccupied, roomsTotal: live.roomsTotal } : STATED_ROOM_OCCUPANCY;
}

export const TRACK_RECORD_HOMES = ["5257 Brooklyn Ave NE", "5259 Brooklyn Ave NE", "4709A 8th Ave"] as const;

/** NEEDS CAPTAIN NUMBER. Leave "" until he supplies it; empty means not shown. */
export const OWNER_RESPONSE_TIME = "";
export const RENT_COLLECTED_ON_TIME = "";
export const AVERAGE_VACANCY_DAYS = "";
export const OWNER_PAYOUT_TIMING = "";

export type TrackRecordMetric = { id: string; value: string; label: string };

export const PENDING_METRICS: readonly TrackRecordMetric[] = [
  { id: "response", value: OWNER_RESPONSE_TIME, label: "typical response time to a resident" },
  { id: "rent", value: RENT_COLLECTED_ON_TIME, label: "of rent collected on time" },
  { id: "vacancy", value: AVERAGE_VACANCY_DAYS, label: "average days a room sits empty" },
  { id: "payout", value: OWNER_PAYOUT_TIMING, label: "owner payout timing" },
];

/** The metrics to draw: the captain's stated numbers, then any pending one he has since filled in. */
export function trackRecordMetrics(
  pending: readonly TrackRecordMetric[] = PENDING_METRICS,
  occupancy: RoomOccupancy = STATED_ROOM_OCCUPANCY,
): TrackRecordMetric[] {
  const stated: TrackRecordMetric[] = [
    { id: "homes", value: String(TRACK_RECORD.homes), label: "homes we run ourselves in Seattle" },
    { id: "occupied", value: `${occupancy.roomsOccupied} of ${occupancy.roomsTotal}`, label: "rooms occupied" },
    { id: "profit", value: TRACK_RECORD.profit, label: "from running these homes" },
  ];
  return [...stated, ...pending.filter((m) => m.value.trim() !== "")];
}
