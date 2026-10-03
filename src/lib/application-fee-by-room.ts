/**
 * The application fee an applicant owes, from the room they chose and the lease
 * type they chose (captain decision, 2026-10-03).
 *
 * Pure - no I/O - so the server resolver, the wizard's display and the manager's
 * application record all read ONE answer. It reads the listing's stored
 * Pricing data only; nothing here accepts an amount.
 *
 * This file only SELECTS the placement (which room, which lease type). The amount comes from
 * the one fee resolver, `listing-placement-standard-fees.ts` (`placementApplicationFeeCents`),
 * the same one the listing quote, the lease and the signing charges read: a stay type's own
 * application fee replaces the house fee, and empty inherits.
 *
 *  - Whole-home listing -> the whole-house arrangement row.
 *  - Otherwise          -> the room named by `roomChoice1` (first choice).
 *  - The term           -> long-term fee, or the short-term fee for a stay
 *                          (`room-term-fees.ts`); a stay with no short-term
 *                          value of its own follows the shared one.
 *
 * `roomTermCents` is `null` when the room/term sets nothing (a typed `0` is a
 * real answer: free). `listingCents` is the listing-level fee, the next level
 * down. Callers hand both to `effectiveApplicationFeeCents`.
 */

import { listingApplicationFeeRaw } from "@/lib/listing-application-fee";
import { resolveSubmissionRoom } from "@/lib/listing-room-resolution";
import {
  isEntireHomeListing,
  type ManagerListingSubmissionV1,
  type ManagerRoomSubmission,
} from "@/lib/manager-listing-submission";
import { parseMoneyAmount } from "@/lib/parse-money";
import { placementApplicationFeeCents, placementFeeOptionsFor } from "@/lib/listing-placement-standard-fees";
import { roomFeeTermScope, type RoomFeeTermScope } from "@/lib/room-term-fees";

export type ApplicationFeeSelection = {
  /** The applicant's first room choice (`roomChoice1`). Empty on a whole-home listing. */
  roomChoice1?: string | null;
  /** The applicant's lease type. */
  leaseTerm?: string | null;
  rentalType?: "standard" | "short_term" | null;
};

export type ApplicationFeeBasis = {
  /** Cents the chosen room sets for the chosen lease type; null = it sets none. */
  roomTermCents: number | null;
  /** Cents the listing-level Application fee sets; null = it sets none. */
  listingCents: number | null;
  /** The room (or "whole") the room-level fee was read from; null when no room resolved. */
  roomId: string | null;
  scope: RoomFeeTermScope;
};

/** A typed amount in cents, or null for blank / non-numeric text (an unset fee, never free). */
function centsFromRaw(raw: string): number | null {
  const text = raw.trim();
  if (!/\d/.test(text)) return null;
  return Math.round(parseMoneyAmount(text) * 100);
}

export function resolveApplicationFeeBasis(
  sub: ManagerListingSubmissionV1 | null | undefined,
  selection: ApplicationFeeSelection,
): ApplicationFeeBasis {
  const rentalType = selection.rentalType === "short_term" ? "short_term" : "standard";
  const scope = roomFeeTermScope(selection.leaseTerm, rentalType);
  if (!sub) return { roomTermCents: null, listingCents: null, roomId: null, scope };

  let roomId: string | null = null;
  let room: ManagerRoomSubmission | null = null;
  const wholeHouse = isEntireHomeListing(sub);
  if (wholeHouse) {
    roomId = "whole";
  } else {
    room =
      (selection.roomChoice1?.trim()
        ? resolveSubmissionRoom(sub, { roomChoices: [selection.roomChoice1] })
        : sub.rooms?.length === 1
          ? sub.rooms[0]
          : undefined) ?? null;
    roomId = room?.id ?? null;
  }

  // A listing with no resolvable room has no placement to read a fee from.
  const roomTermCents =
    wholeHouse || room
      ? placementApplicationFeeCents(
          sub,
          placementFeeOptionsFor(sub, {
            room,
            wholeHouse,
            leaseTerm: selection.leaseTerm,
            rentalType,
          }),
        )
      : null;
  const listingCents = centsFromRaw(
    listingApplicationFeeRaw(sub, rentalType, selection.leaseTerm),
  );
  return { roomTermCents, listingCents, roomId, scope };
}

function dollarsLabel(cents: number): string {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

/**
 * The Application fee row a manager sees on an application: the fee for the
 * applicant's room and lease type, else the listing-level fee as typed. Display
 * only (the account-level setting lives on the server); the amount actually
 * charged is the server resolver's.
 */
export function applicationFeeLabelForSelection(
  sub: ManagerListingSubmissionV1 | null | undefined,
  selection: ApplicationFeeSelection,
): string {
  if (!sub) return "";
  const basis = resolveApplicationFeeBasis(sub, selection);
  if (basis.roomTermCents !== null) return dollarsLabel(basis.roomTermCents);
  if (basis.listingCents !== null) return dollarsLabel(basis.listingCents);
  return String(sub.applicationFee ?? "").trim();
}

/**
 * What the public listing shows for "Application fee" before an applicant has
 * picked a room: the lowest and highest fee any room (or the whole house) sets
 * for this lease scope, a room that sets none counting at the listing-level fee.
 * `null` when it cannot be known from the listing alone - some room would fall
 * through to the account-level setting - so the caller keeps today's listing
 * default.
 */
export function applicationFeeRangeAcrossRooms(
  sub: ManagerListingSubmissionV1 | null | undefined,
  scope: RoomFeeTermScope = "long",
): { minCents: number; maxCents: number } | null {
  if (!sub) return null;
  const wholeHouse = isEntireHomeListing(sub);
  const rooms: Array<ManagerRoomSubmission | null> = wholeHouse ? [null] : (sub.rooms ?? []);
  if (rooms.length === 0) return null;
  const listingCents = centsFromRaw(
    listingApplicationFeeRaw(sub, scope === "short" ? "short_term" : "standard", null),
  );
  const values: number[] = [];
  let anyRoomLevel = false;
  for (const room of rooms) {
    const own = placementApplicationFeeCents(
      sub,
      placementFeeOptionsFor(sub, {
        room,
        wholeHouse,
        rentalType: scope === "short" ? "short_term" : "standard",
      }),
    );
    if (own !== null) anyRoomLevel = true;
    const cents = own ?? listingCents;
    if (cents === null) return null;
    values.push(cents);
  }
  if (!anyRoomLevel) return null;
  return { minCents: Math.min(...values), maxCents: Math.max(...values) };
}

/** `$75`, or `From $50` when rooms differ. Empty when every room is free. */
export function applicationFeeRangeLabel(range: { minCents: number; maxCents: number }): string {
  if (range.maxCents <= 0) return "";
  if (range.minCents === range.maxCents) return dollarsLabel(range.maxCents);
  return `From ${dollarsLabel(range.minCents)}`;
}
