import { matchChannelListing, type ChannelRoomCandidate } from "@/lib/channel-calendar/channel-listing-match";
import type { ChannelFinanceFacts } from "./types";

export type FinanceRoomCandidate = ChannelRoomCandidate & {
  connectionId: string;
  /** The room's synced stays on this channel. `end` is the LAST NIGHT (check-out minus a day), as the calendar stores it. */
  ranges: readonly { code: string | null; start: string; end: string; sourceUid: string }[];
};

export type FinanceMatch = {
  propertyId: string;
  propertyLabel: string;
  roomId: string | null;
  roomLabel: string | null;
  connectionId: string | null;
  sourceUid: string | null;
  via: "reservation_code" | "dates" | "listing_title";
};

function dayBefore(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
}

/**
 * The room a booking (or its payout) belongs to. In order: the confirmation code on a synced stay; the SAME dates on exactly
 * one synced stay (and the listing text, when there is one, does not point at a different house); the listing text alone.
 * Two stays with the same dates, or no answer, is no match: the row is filed "Needs a room", never guessed. Pure.
 */
export function matchFinanceFacts(facts: ChannelFinanceFacts, candidates: readonly FinanceRoomCandidate[]): FinanceMatch | null {
  const code = facts.confirmationCode.trim();
  const byCode = candidates.flatMap((c) => c.ranges.filter((r) => r.code === code).map((r) => ({ c, r })));
  if (byCode.length === 1) {
    const { c, r } = byCode[0]!;
    return { propertyId: c.propertyId, propertyLabel: c.propertyLabel, roomId: c.roomId, roomLabel: c.roomLabel, connectionId: c.connectionId, sourceUid: r.sourceUid, via: "reservation_code" };
  }
  const listing = facts.listingHint
    ? matchChannelListing({ site: facts.platform, listingTitle: facts.listingHint, reservationCode: null }, candidates)
    : null;
  if (facts.checkIn && facts.checkOut) {
    const lastNight = dayBefore(facts.checkOut);
    const byDates = candidates.flatMap((c) => c.ranges.filter((r) => r.start === facts.checkIn && r.end === lastNight).map((r) => ({ c, r })));
    if (byDates.length === 1) {
      const { c, r } = byDates[0]!;
      const contradicted = listing !== null && (listing.propertyId !== c.propertyId || (listing.roomId !== null && listing.roomId !== c.roomId));
      if (!contradicted) {
        return { propertyId: c.propertyId, propertyLabel: c.propertyLabel, roomId: c.roomId, roomLabel: c.roomLabel, connectionId: c.connectionId, sourceUid: r.sourceUid, via: "dates" };
      }
    }
  }
  if (listing) {
    return { propertyId: listing.propertyId, propertyLabel: listing.propertyLabel, roomId: listing.roomId, roomLabel: listing.roomLabel, connectionId: null, sourceUid: null, via: "listing_title" };
  }
  return null;
}
