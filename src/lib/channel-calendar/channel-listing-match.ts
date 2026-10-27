/**
 * Which house and room a site's guest message is about, decided from the workspace's own channel calendar connections.
 *
 * A connection links ONE room to ONE site's calendar (`external_calendar_connections`), so the connections of a site are
 * exactly the rooms the manager lists there. A guest message names its listing only by the site's own title ("Private
 * room near UW - 5257 Brooklyn Ave Room 6"), so the match is: (1) the reservation code the mail quotes, when one of the
 * room's imported reservations carries it; else (2) the title read against each candidate room's house label, room name
 * and the "also listed as" ad title. A tie between rooms of the SAME house answers the house alone; a tie across houses
 * answers nothing - never a guess. Pure: no IO.
 */
import { normalizeListingIdentity, normalizeListingWords } from "@/lib/listing-identity";
import type { ChannelSite } from "@/lib/inbound-email/channel-senders";

export type ChannelRoomCandidate = {
  propertyId: string;
  /** House label as the manager sees it ("5257 Brooklyn Ave"). */
  propertyLabel: string;
  roomId: string;
  roomLabel: string;
  /** The ad title the manager recorded for the house (`alsoListedAs`), when there is one. */
  adTitle?: string | null;
  /** Reservation codes of the room's imported reservations on this site. */
  reservationCodes: readonly string[];
};

export type ChannelListingMatch = {
  propertyId: string;
  propertyLabel: string;
  roomId: string | null;
  roomLabel: string | null;
  via: "reservation_code" | "listing_title";
};

const STOP = new Set(["the", "and", "near", "for", "with", "from", "private", "shared", "home", "house", "apt", "apartment", "unit", "bed", "bedroom", "in", "of", "at", "to", "a"]);

function significant(value: string): string[] {
  return normalizeListingWords(value).filter((word) => word.length > 1 && !STOP.has(word));
}

/** "Room 6" and "room six"-style digits: a room name is matched only on its full normalized identity. */
function roomNamed(title: string, roomLabel: string): boolean {
  const room = normalizeListingIdentity(roomLabel);
  if (!room) return false;
  const words = normalizeListingWords(title);
  const compactTitle = words.join("");
  // "room6" must not match inside "room66": require a non-digit (or end) after the room identity.
  const at = compactTitle.indexOf(room);
  if (at < 0) return false;
  const after = compactTitle[at + room.length];
  const roomEndsInDigit = /\d$/.test(room);
  return !roomEndsInDigit || !after || !/\d/.test(after);
}

function houseScore(title: string, candidate: ChannelRoomCandidate): number {
  const words = new Set(normalizeListingWords(title));
  const compact = normalizeListingWords(title).join("");
  let score = 0;
  const label = significant(candidate.propertyLabel);
  const hits = label.filter((word) => words.has(word) || (word.length > 3 && compact.includes(word)));
  // A street number ("5257", "4709a") is the strongest single identity a house has.
  const numeric = label.find((word) => /^\d{2,6}[a-z]?$/.test(word));
  if (numeric && words.has(numeric)) score += 6;
  score += hits.length * 2;
  const ad = candidate.adTitle ? normalizeListingIdentity(candidate.adTitle) : "";
  if (ad && normalizeListingIdentity(title).includes(ad)) score += 5;
  return score;
}

export function matchChannelListing(
  input: { site: ChannelSite; listingTitle: string | null; reservationCode: string | null },
  candidates: readonly ChannelRoomCandidate[],
): ChannelListingMatch | null {
  const code = input.reservationCode?.trim();
  if (code) {
    const byCode = candidates.filter((candidate) => candidate.reservationCodes.includes(code));
    if (byCode.length === 1) {
      const hit = byCode[0]!;
      return { propertyId: hit.propertyId, propertyLabel: hit.propertyLabel, roomId: hit.roomId, roomLabel: hit.roomLabel, via: "reservation_code" };
    }
  }
  const title = input.listingTitle?.trim();
  if (!title) return null;

  const scored = candidates
    .map((candidate) => ({ candidate, house: houseScore(title, candidate), room: roomNamed(title, candidate.roomLabel) }))
    .filter((entry) => entry.house >= 4);
  if (scored.length === 0) return null;

  const bestHouse = Math.max(...scored.map((entry) => entry.house));
  const houses = scored.filter((entry) => entry.house === bestHouse);
  const houseIds = new Set(houses.map((entry) => entry.candidate.propertyId));
  if (houseIds.size !== 1) return null;

  const named = houses.filter((entry) => entry.room);
  if (named.length === 1) {
    const hit = named[0]!.candidate;
    return { propertyId: hit.propertyId, propertyLabel: hit.propertyLabel, roomId: hit.roomId, roomLabel: hit.roomLabel, via: "listing_title" };
  }
  const first = houses[0]!.candidate;
  // The house is certain; the room is not (an unnamed or ambiguous room): answer the house alone, or the one room it lists.
  const rooms = new Set(houses.map((entry) => entry.candidate.roomId));
  if (rooms.size === 1) {
    return { propertyId: first.propertyId, propertyLabel: first.propertyLabel, roomId: first.roomId, roomLabel: first.roomLabel, via: "listing_title" };
  }
  return { propertyId: first.propertyId, propertyLabel: first.propertyLabel, roomId: null, roomLabel: null, via: "listing_title" };
}
