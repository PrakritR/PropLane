/**
 * When a room-rental guest or resident may see the codes that open the door.
 *
 * ONE decision, `checkInReveal(stay, now)`, shared by the resident Check-in tab, the guest's stay
 * page, the arrival message, the resident assistant and the SMS fast path, so no surface invents its
 * own idea of "unlocked". The rule (captain, Oct 28, like Airbnb): codes appear 24 hours before
 * check-in / move-in. A long-term resident additionally needs a signed lease; a short-stay guest a
 * confirmed stay (a hold or a cancelled stay never sees a code), and a stay's codes close again once
 * the guest has checked out. Before the moment, the steps still show, with the codes masked and the
 * unlock time ("Codes unlock Thu 3:00 PM").
 *
 * Pure and fail-closed: an unreadable time never reveals.
 */

export const CHECK_IN_REVEAL_LEAD_MS = 24 * 3_600_000;

export type CheckInRevealInput =
  | {
      kind: "tenancy";
      /** The move-in instant (ISO) - the move-in date at the property's check-in time; null when no date is on file. */
      moveInAtIso: string | null;
      /** Both parties have signed (or the tenancy is attested). */
      leaseSigned: boolean;
    }
  | {
      kind: "stay";
      checkInAtIso: string;
      checkOutAtIso?: string | null;
      /** The stay's `bookingStatus`; only `confirmed` ever reveals. */
      status: string;
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
    const revealMs = moveInMs === null ? null : moveInMs - CHECK_IN_REVEAL_LEAD_MS;
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
  const revealMs = checkInMs - CHECK_IN_REVEAL_LEAD_MS;
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
