/**
 * The ONE way an application is matched to a room of its listing submission.
 *
 * The charge ledger and the lease document both feed the resolved room to
 * `resolveStayPricing`, so resolving it two different ways puts the same
 * resident on two different rates again — which is the bug the resolver exists
 * to remove. Callers pass primitives (their own room-choice values, an optional
 * unit label, an optional signed rent) and share this fallback chain.
 *
 * Order: room-choice ids → unique signed-rent match → unit-label name match → the only
 * room → the only `daily_rate` room. The signed-rent match is an exact figure and the
 * unit-label match is a fuzzy substring heuristic, so the exact one outranks it.
 *
 * BOTH consumers must pass every field they can resolve, `unitLabel` included. One shared
 * implementation fed two different argument sets still returns two answers.
 */

import {
  isEntireHomeListing,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { parseRoomChoiceValue } from "@/lib/rental-application/data";
import { roomDailyRentPrice } from "@/lib/room-pricing";

export type SubmissionRoomLookup = {
  /** Room-choice values in priority order (e.g. assignedRoomChoice, then roomChoice1). */
  roomChoices?: readonly (string | null | undefined)[];
  /** Property unit label, matched against room names when no room-choice id resolves. */
  unitLabel?: string | null;
  /** This resident's signed monthly rent, used only for a UNIQUE monthly-rent match. */
  signedMonthlyRent?: number | null;
};

/**
 * Trailing room number, when a name ends in one — `"room 10"` → `"10"`, `"attic"` → `null`.
 * Used to keep "Room 1" from substring-matching "Room 10".
 */
function roomNumberSuffix(name: string): string | null {
  const match = /(\d+)\s*$/.exec(name);
  return match ? String(Number(match[1])) : null;
}

/** Callers pass an ALREADY-NORMALIZED submission (`normalizeManagerListingSubmissionV1`). */
export function resolveSubmissionRoom(
  sub: ManagerListingSubmissionV1 | null | undefined,
  lookup: SubmissionRoomLookup,
): ManagerRoomSubmission | undefined {
  const rooms = sub?.rooms;
  if (!rooms?.length) return undefined;

  // An entire-home listing is let as one unit, so its named room IS the premises. This has to
  // live here rather than only on the ledger side: when the two disagreed, an entire-home
  // approval billed the whole-unit rent while its lease quoted whichever room matched first.
  if (sub && isEntireHomeListing(sub)) {
    const named = rooms.find((r) => r.name.trim());
    if (named) return named;
  }

  // Tracks that the application NAMED a room this catalog does not contain. That is a
  // disagreement between the application and the listing, not a missing hint, so the guessy
  // fallbacks below must not paper over it with somebody else's room.
  let namedAnUnknownRoom = false;
  for (const choice of lookup.roomChoices ?? []) {
    const trimmed = choice?.trim();
    if (!trimmed) continue;
    const { listingRoomId } = parseRoomChoiceValue(trimmed);
    if (!listingRoomId) continue;
    const byId = rooms.find((r) => r.id === listingRoomId);
    if (byId) return byId;
    namedAnUnknownRoom = true;
  }

  const signedRent = Number(lookup.signedMonthlyRent ?? 0);
  if (Number.isFinite(signedRent) && signedRent > 0) {
    const byRent = rooms.filter((r) => r.monthlyRent === signedRent);
    if (byRent.length === 1) return byRent[0];
  }

  const label = lookup.unitLabel?.trim().toLowerCase();
  if (label) {
    const named = rooms.filter((r) => r.name.trim());
    const exact = named.find((r) => r.name.trim().toLowerCase() === label);
    if (exact) return exact;
    const partial = named.filter((r) => {
      const name = r.name.trim().toLowerCase();
      if (!(name.includes(label) || label.includes(name))) return false;
      // "room 10".includes("room 1") is true, so a plain substring test puts the Room 1
      // resident on Room 10's rent and deposit. When both names end in a number, that number
      // IS the room identity and has to match.
      return roomNumberSuffix(name) === roomNumberSuffix(label);
    });
    // Several partial matches means the answer would be decided by array order, which says
    // nothing about where this resident actually lives.
    if (partial.length === 1) return partial[0];
  }

  // Past this point every remaining rule is a guess from shape rather than a match on this
  // resident's placement, so an application that named a room we could not find stops here.
  // "—" in the document reads as not-set and gets corrected; a confident figure belonging to
  // another room gets signed.
  if (namedAnUnknownRoom) return undefined;

  if (rooms.length === 1) return rooms[0];
  // Last resort: only one room is configured with daily_rate → it must be the right room.
  const dailyRateRooms = rooms.filter(
    (r) => r.prorateMethod === "daily_rate" && r.dailyRentRate && r.dailyRentRate > 0,
  );
  if (dailyRateRooms.length === 1) return dailyRateRooms[0];
  return undefined;
}

/**
 * Period-aware rent line for one room: `"$55.00 / day"` for a daily-priced room,
 * `"$1200.00 / month"` otherwise, `undefined` when nothing is priced.
 */
export function submissionRoomRentLabel(room: ManagerRoomSubmission | null | undefined): string | undefined {
  if (!room) return undefined;
  const daily = roomDailyRentPrice(room);
  if (daily !== undefined) return `$${daily.toFixed(2)} / day`;
  if (room.monthlyRent > 0) return `$${room.monthlyRent.toFixed(2)} / month`;
  return undefined;
}
