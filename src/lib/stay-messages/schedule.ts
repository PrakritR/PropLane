/**
 * When the automated check-in and check-out messages are due (design-1112 §7). Pure: no IO, no clock of its own.
 *
 *   check-in   10:00 local on the DAY BEFORE the check-in date (the same moment the door codes unlock, `checkInReveal`)
 *   check-out  09:00 local on the check-out date
 *
 * Everything is built from the wall time through `Intl` (`wallInstantIso`), so a DST change never shifts a message by an
 * hour. A booking created inside the window (after the check-in anchor) is due NOW and is sent promptly, once.
 */
import { wallInstantIso } from "@/lib/bookings/stay-times";
import { checkInRevealAtMs, CHECK_IN_REVEAL_ZONE } from "@/lib/check-in-reveal";

export const STAY_MESSAGE_ZONE = CHECK_IN_REVEAL_ZONE;
export const CHECK_OUT_MESSAGE_TIME = "09:00";
/** A check-in message is still worth sending this long after the check-in instant (a late booking); after it, never. */
export const CHECK_IN_MESSAGE_GRACE_MS = 6 * 3_600_000;

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isDateKey(value: unknown): value is string {
  return typeof value === "string" && DATE_KEY.test(value);
}

/** The instant the check-in message becomes due: 10:00 local the day before `checkInDate`. Null for a bad date. */
export function checkInDueAt(checkInDate: string, timeZone: string = STAY_MESSAGE_ZONE): Date | null {
  if (!isDateKey(checkInDate)) return null;
  // Any instant on the check-in date gives the same local day; noon avoids every DST edge.
  const noon = Date.parse(wallInstantIso(checkInDate, "12:00", timeZone));
  const at = Number.isFinite(noon) ? checkInRevealAtMs(noon, timeZone) : null;
  return at === null ? null : new Date(at);
}

/** The instant the check-out message becomes due: 09:00 local on `checkOutDate`. */
export function checkOutDueAt(checkOutDate: string, timeZone: string = STAY_MESSAGE_ZONE): Date | null {
  if (!isDateKey(checkOutDate)) return null;
  const at = Date.parse(wallInstantIso(checkOutDate, CHECK_OUT_MESSAGE_TIME, timeZone));
  return Number.isFinite(at) ? new Date(at) : null;
}

/** True when the booking was created after its own check-in anchor: it is due immediately, not at the anchor. */
export function createdInsideWindow(createdAtIso: string | null | undefined, checkInDate: string, timeZone: string = STAY_MESSAGE_ZONE): boolean {
  const due = checkInDueAt(checkInDate, timeZone);
  const created = Date.parse(createdAtIso ?? "");
  return due !== null && Number.isFinite(created) && created >= due.getTime();
}

export type StayMessageWindow =
  | { state: "not_yet"; dueAt: Date }
  | { state: "due"; dueAt: Date }
  | { state: "expired"; dueAt: Date };

/**
 * Where `now` sits against a check-in message: before its anchor (not yet), between the anchor and a few hours past the
 * check-in instant (due), or later (expired: a stay already under way is never texted a check-in).
 */
export function checkInWindow(input: { checkInDate: string; checkInTime: string; now: Date; timeZone?: string }): StayMessageWindow | null {
  const zone = input.timeZone ?? STAY_MESSAGE_ZONE;
  const dueAt = checkInDueAt(input.checkInDate, zone);
  if (!dueAt) return null;
  const checkInMs = Date.parse(wallInstantIso(input.checkInDate, input.checkInTime, zone));
  if (!Number.isFinite(checkInMs)) return null;
  const nowMs = input.now.getTime();
  if (nowMs < dueAt.getTime()) return { state: "not_yet", dueAt };
  if (nowMs > checkInMs + CHECK_IN_MESSAGE_GRACE_MS) return { state: "expired", dueAt };
  return { state: "due", dueAt };
}

/** The check-out message is due from 09:00 on the check-out date until the check-out instant itself. */
export function checkOutWindow(input: { checkOutDate: string; checkOutTime: string; now: Date; timeZone?: string }): StayMessageWindow | null {
  const zone = input.timeZone ?? STAY_MESSAGE_ZONE;
  const dueAt = checkOutDueAt(input.checkOutDate, zone);
  if (!dueAt) return null;
  const checkOutMs = Date.parse(wallInstantIso(input.checkOutDate, input.checkOutTime, zone));
  if (!Number.isFinite(checkOutMs)) return null;
  const nowMs = input.now.getTime();
  if (nowMs < dueAt.getTime()) return { state: "not_yet", dueAt };
  // A checkout set before 09:00 (an early paid time) still gets its message, at the anchor, until the day ends.
  const until = Math.max(checkOutMs, dueAt.getTime() + 3 * 3_600_000);
  if (nowMs > until) return { state: "expired", dueAt };
  return { state: "due", dueAt };
}

/** The stay has ended: its check-out instant has passed. */
export function stayEnded(input: { checkOutDate: string; checkOutTime: string; now: Date; timeZone?: string }): boolean {
  const ms = Date.parse(wallInstantIso(input.checkOutDate, input.checkOutTime, input.timeZone ?? STAY_MESSAGE_ZONE));
  return Number.isFinite(ms) && input.now.getTime() >= ms;
}
