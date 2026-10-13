/**
 * The single price line at the top of the public listing card.
 *
 * "$1,050 / mo" when the listing states one monthly base rent, "from $1,050 / mo" when the base rent is zero
 * or missing and the price is the lowest room rent from the rooms list. When neither exists there is no line
 * at all: the card never prints "$0" or a dash for a price it does not have.
 */
import type { ListingRichContent } from "@/data/listing-rich-content";
import { formatRoomPriceAmount } from "@/lib/room-pricing";

export type ListingPriceLine = { label: string; amount: number; from: boolean };

function firstMoney(label: string | undefined): number {
  const match = (label ?? "").match(/\$\s*(\d[\d,]*(?:\.\d+)?)/);
  if (!match) return 0;
  const n = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** The lowest positive monthly rent across the listing's rooms (a daily room is read by its monthly equivalent). */
export function lowestRoomMonthlyRent(rich: Pick<ListingRichContent, "floorPlans">): number {
  const rents = rich.floorPlans
    .flatMap((floor) => floor.rooms)
    .map((room) => (room.pricePeriod === "month" || !room.pricePeriod ? room.priceHeadlineAmount : undefined) ?? room.priceMonthlyEquivalent ?? 0)
    .filter((n) => Number.isFinite(n) && n > 0);
  return rents.length > 0 ? Math.min(...rents) : 0;
}

export function listingMonthlyPriceLine(
  rich: Pick<ListingRichContent, "startingRentLabel" | "priceRangeLabel" | "floorPlans">,
): ListingPriceLine | null {
  const starting = rich.startingRentLabel?.trim();
  const range = (rich.priceRangeLabel ?? "").replace(/^\s*base rent\s*/i, "");
  const base = firstMoney(starting || range);
  if (base > 0) {
    // A stated starting rent is the price; a bare range label that opens with "from" is a lowest-of figure.
    const from = !starting && /^\s*from\b/i.test(range);
    return { label: `${from ? "from " : ""}${formatRoomPriceAmount(base)} / mo`, amount: base, from };
  }
  const lowest = lowestRoomMonthlyRent(rich);
  if (lowest > 0) return { label: `from ${formatRoomPriceAmount(lowest)} / mo`, amount: lowest, from: true };
  return null;
}
