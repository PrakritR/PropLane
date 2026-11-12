/**
 * When a room-rental guest or resident may see the codes that open the door.
 *
 * ONE decision, `checkInReveal(stay, now)`, shared by the resident Check-in tab, the guest's stay
 * page, the arrival message, the resident assistant and the SMS fast path, so no surface invents its
 * own idea of "unlocked". The rule (captain, Nov 12, design-1112 §5 item 4, replacing the Oct 28
 * "24 hours before" rule): codes appear at 10:00 local on the DAY BEFORE check-in / move-in, the
 * same moment the automated check-in message goes out. A long-term resident additionally needs a signed lease; a short-stay guest a
 * confirmed stay (a hold or a cancelled stay never sees a code), and a stay's codes close again once
 * the guest has checked out. Before the moment, the steps still show, with the codes masked and the
 * unlock time ("Codes unlock Thu 3:00 PM").
 *
 * Pure and fail-closed: an unreadable time never reveals.
 */

import { wallInstantIso } from "@/lib/bookings/stay-times";

export const CHECK_IN_REVEAL_HOUR_LOCAL = "10:00";
export const CHECK_IN_REVEAL_ZONE = "America/Los_Angeles";

function localDateKey(ms: number, timeZone: string): string | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
    const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    const key = `${pick("year")}-${pick("month")}-${pick("day")}`;
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : null;
  } catch {
    return null;
  }
}

function dayBefore(dateKey: string): string {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

/**
 * The moment the codes unlock for a check-in / move-in instant: 10:00 in `timeZone` on the day before the check-in's own
 * local date. DST-safe (built from the wall time, never "minus 24 h"). Null when the instant is unreadable.
 */
export function checkInRevealAtMs(checkInMs: number, timeZone: string = CHECK_IN_REVEAL_ZONE): number | null {
  const key = localDateKey(checkInMs, timeZone);
  if (!key) return null;
  const at = Date.parse(wallInstantIso(dayBefore(key), CHECK_IN_REVEAL_HOUR_LOCAL, timeZone));
  return Number.isFinite(at) ? at : null;
}

export type CheckInRevealInput =
  | {
      kind: "tenancy";
      /** The move-in instant (ISO) - the move-in date at the property's check-in time; null when no date is on file. */
      moveInAtIso: string | null;
      /** Both parties have signed (or the tenancy is attested). */
      leaseSigned: boolean;
      /** The property's IANA zone; Pacific when absent. */
      timeZone?: string;
    }
  | {
      kind: "stay";
      checkInAtIso: string;
      checkOutAtIso?: string | null;
      /** The stay's `bookingStatus`; only `confirmed` ever reveals. */
      status: string;
      /** The property's IANA zone; Pacific when absent. */
      timeZone?: string;
    };

export type CheckInRevealReason =
  | "open"
  | "too_early"
  | "lease_unsigned"
  | "stay_not_confirmed"
  | "stay_ended"
  | "no_time";

export type CheckInReveal = {
  revealed: boolean;
  reason: CheckInRevealReason;
  /** When the codes unlock (ISO), or null when there is no such moment to name. */
  revealAtIso: string | null;
};

function parseMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

export function checkInReveal(input: CheckInRevealInput, now: Date = new Date()): CheckInReveal {
  const nowMs = now.getTime();

  if (input.kind === "tenancy") {
    const hasDate = Boolean(input.moveInAtIso && input.moveInAtIso.trim());
    const moveInMs = parseMs(input.moveInAtIso);
    const revealMs = moveInMs === null ? null : checkInRevealAtMs(moveInMs, input.timeZone);
    const revealAtIso = revealMs === null ? null : new Date(revealMs).toISOString();
    if (!input.leaseSigned) return { revealed: false, reason: "lease_unsigned", revealAtIso };
    // A date that is on file but unreadable never reveals.
    if (hasDate && revealMs === null) return { revealed: false, reason: "no_time", revealAtIso: null };
    // A signed lease with no move-in date on file is a tenancy already under way: nothing to wait for.
    if (revealMs === null) return { revealed: true, reason: "open", revealAtIso: null };
    if (nowMs < revealMs) return { revealed: false, reason: "too_early", revealAtIso };
    return { revealed: true, reason: "open", revealAtIso };
  }

  if (input.status !== "confirmed") return { revealed: false, reason: "stay_not_confirmed", revealAtIso: null };
  const checkInMs = parseMs(input.checkInAtIso);
  if (checkInMs === null) return { revealed: false, reason: "no_time", revealAtIso: null };
  const revealMs = checkInRevealAtMs(checkInMs, input.timeZone);
  if (revealMs === null) return { revealed: false, reason: "no_time", revealAtIso: null };
  const revealAtIso = new Date(revealMs).toISOString();
  const checkOutMs = parseMs(input.checkOutAtIso);
  if (checkOutMs !== null && nowMs >= checkOutMs) return { revealed: false, reason: "stay_ended", revealAtIso };
  if (nowMs < revealMs) return { revealed: false, reason: "too_early", revealAtIso };
  return { revealed: true, reason: "open", revealAtIso };
}

/** "Thu 3:00 PM" in the property's zone (Pacific unless told otherwise). */
export function formatRevealLabel(iso: string | null | undefined, timeZone = "America/Los_Angeles"): string | null {
  const ms = parseMs(iso ?? null);
  if (ms === null) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).formatToParts(new Date(ms));
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("weekday")} ${pick("hour")}:${pick("minute")} ${pick("dayPeriod")}`.trim();
}
