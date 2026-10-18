/**
 * Stamping exact times onto a stay row (bookings-times-1018), shared by every
 * manager writer: the schedule-records route, the `block_room_dates` /
 * `update_room_block` tools and the client's `saveRoomDateBlock`.
 *
 * A saved stay always carries `checkInTime` / `checkOutTime` ("HH:MM" property
 * wall time) and the real instants in `startsAt` / `endsAt` (the columns
 * `starts_at` / `ends_at`). The dates stay authoritative. Pure and
 * framework-free; the caller supplies the property's clock.
 */

import {
  normalizeStayTime,
  wallInstantIso,
  type PropertyStayTimes,
  type StayAddOns,
} from "@/lib/bookings/stay-times";

export type StayClock = { times: PropertyStayTimes; timeZone: string };

type Obj = Record<string, unknown>;

function asObject(value: unknown): Obj | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : null;
}

function legacy(rowData: Obj | null, key: "earlyCheckIn" | "lateCheckOut"): string | null {
  return normalizeStayTime(asObject(rowData?.stayDetails)?.[key]);
}

/**
 * The stay's own times. The save's explicit time wins; else the stored row's
 * explicit time (a save that never mentions times keeps them); else the legacy
 * sheet field; else the property default.
 */
export function resolveRowStayTimes(
  rowData: Obj,
  existing: Obj | null,
  property: PropertyStayTimes,
): { checkInTime: string; checkOutTime: string } {
  return {
    checkInTime:
      normalizeStayTime(rowData.checkInTime) ??
      normalizeStayTime(existing?.checkInTime) ??
      legacy(rowData, "earlyCheckIn") ??
      legacy(existing, "earlyCheckIn") ??
      property.checkInTime,
    checkOutTime:
      normalizeStayTime(rowData.checkOutTime) ??
      normalizeStayTime(existing?.checkOutTime) ??
      legacy(rowData, "lateCheckOut") ??
      legacy(existing, "lateCheckOut") ??
      property.checkOutTime,
  };
}

/** The real instants of a stay's check-in and check-out; null when a date is not a real calendar date. */
export function stayInstants(
  checkIn: string,
  checkOut: string,
  times: { checkInTime: string; checkOutTime: string },
  timeZone: string,
): { startsAt: string; endsAt: string } | null {
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!datePattern.test(checkIn) || !datePattern.test(checkOut)) return null;
  try {
    return {
      startsAt: wallInstantIso(checkIn, times.checkInTime, timeZone),
      endsAt: wallInstantIso(checkOut, times.checkOutTime, timeZone),
    };
  } catch {
    return null;
  }
}

/**
 * `stayDetails` as it is stored after a save. The paid early / late add-ons are
 * server-owned (their payments write them), so they come from the STORED row,
 * never from the save; the estimated arrival is the save's when valid, else the
 * stored one. The legacy `earlyCheckIn` / `lateCheckOut` fields are dropped:
 * `resolveRowStayTimes` has already folded them into the stay's own times.
 */
export function carriedStayDetails(rowData: Obj, existing: Obj | null): Obj | undefined {
  const incoming = asObject(rowData.stayDetails);
  const stored = asObject(existing?.stayDetails);
  const next: Obj = { ...(incoming ?? {}) };
  delete next.earlyCheckIn;
  delete next.lateCheckOut;
  delete next.addOns;
  const storedAddOns = asObject(stored?.addOns) as StayAddOns | null;
  if (storedAddOns && Object.keys(storedAddOns).length > 0) next.addOns = storedAddOns;
  const arrival = normalizeStayTime(incoming?.estimatedArrival) ?? normalizeStayTime(stored?.estimatedArrival);
  if (arrival) next.estimatedArrival = arrival;
  else delete next.estimatedArrival;
  return Object.keys(next).length > 0 || incoming || stored ? next : undefined;
}

/**
 * The row a writer stores: times stamped, instants set, add-ons carried. Dates
 * are untouched. `existing` is the stored `row_data` when this is an update.
 */
export function stampStayRow(rowData: Obj, existing: Obj | null, clock: StayClock): { rowData: Obj; startsAt: string | null; endsAt: string | null } {
  const times = resolveRowStayTimes(rowData, existing, clock.times);
  const checkIn = typeof rowData.checkIn === "string" ? rowData.checkIn : "";
  const checkOut = typeof rowData.checkOut === "string" ? rowData.checkOut : "";
  const instants = stayInstants(checkIn, checkOut, times, clock.timeZone);
  const stayDetails = carriedStayDetails(rowData, existing);
  const next: Obj = {
    ...rowData,
    ...times,
    ...(instants ? { startsAt: instants.startsAt, endsAt: instants.endsAt } : {}),
  };
  if (stayDetails) next.stayDetails = stayDetails;
  return { rowData: next, startsAt: instants?.startsAt ?? null, endsAt: instants?.endsAt ?? null };
}

/** "HH:MM" on the property's wall clock for an instant (ISO); null for a bad instant. */
export function wallTimeOfInstant(iso: string | null | undefined, timeZone: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(ms));
    const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
    return `${hour === "24" ? "00" : hour}:${minute}`;
  } catch {
    return null;
  }
}
