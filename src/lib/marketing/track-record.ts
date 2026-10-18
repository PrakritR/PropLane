/**
 * The only operating facts the captain has stated for the "we run homes
 * ourselves" story (2026-10-18). Nothing else may be shown as a figure.
 *
 *   - 3 homes: 5257 Brooklyn, 5259 Brooklyn, 4709A 8th Ave (Seattle)
 *   - 28 rooms, 26 of them occupied (shown as "26 of 28 rooms occupied", never a recomputed percent)
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
export function trackRecordMetrics(): TrackRecordMetric[] {
  const stated: TrackRecordMetric[] = [
    { id: "homes", value: String(TRACK_RECORD.homes), label: "homes we run ourselves in Seattle" },
    { id: "occupied", value: `${TRACK_RECORD.roomsOccupied} of ${TRACK_RECORD.roomsTotal}`, label: "rooms occupied" },
    { id: "profit", value: TRACK_RECORD.profit, label: "from running these homes" },
  ];
  return [...stated, ...PENDING_METRICS.filter((m) => m.value.trim() !== "")];
}
