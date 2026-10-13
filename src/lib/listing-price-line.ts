/**
 * The single price line at the top of the public listing card.
 *
 * "$1,050 / mo" when the listing rents at one monthly price, "from $1,050 / mo" whenever the figure is the
 * LOWEST of several — a room-by-room listing renting $1,050–$1,800 says "from $1,050 / mo", because the
 * cheapest room's rent is not the price of the home. When nothing prices the listing there is no line at
 * all: the card never prints "$0" or a dash for a price it does not have.
 */
import type { ListingRichContent } from "@/data/listing-rich-content";
import { parseMoneyAmount } from "@/lib/parse-money";
import { formatRoomPriceAmount } from "@/lib/room-pricing";

export type ListingPriceLine = { label: string; amount: number; from: boolean };

function firstMoney(label: string | undefined): number {
  const match = (label ?? "").match(/\$\s*(\d[\d,]*(?:\.\d+)?)/);
  if (!match) return 0;
  const n = Number(match[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Every positive monthly room rent on the listing (a daily room is read by its monthly equivalent). */
function roomMonthlyRents(rich: Pick<ListingRichContent, "floorPlans">): number[] {
  return rich.floorPlans
    .flatMap((floor) => floor.rooms)
    .map((room) => (room.pricePeriod === "month" || !room.pricePeriod ? room.priceHeadlineAmount : undefined) ?? room.priceMonthlyEquivalent ?? 0)
    .filter((n) => Number.isFinite(n) && n > 0);
}

/** The lowest positive monthly rent across the listing's rooms (a daily room is read by its monthly equivalent). */
export function lowestRoomMonthlyRent(rich: Pick<ListingRichContent, "floorPlans">): number {
  const rents = roomMonthlyRents(rich);
  return rents.length > 0 ? Math.min(...rents) : 0;
}

/**
 * True when the rooms are NOT all one price, so whatever single figure the card prints is a lowest-of.
 * `startingRentLabel` is already the cheapest room's rent for every submission-derived listing, which is
 * exactly why its presence cannot be read as "the listing states one rent".
 */
export function listingRoomRentsSpread(rich: Pick<ListingRichContent, "floorPlans">): boolean {
  const rents = roomMonthlyRents(rich);
  return rents.length > 1 && Math.max(...rents) > Math.min(...rents);
}

export function listingMonthlyPriceLine(
  rich: Pick<ListingRichContent, "startingRentLabel" | "priceRangeLabel" | "floorPlans">,
): ListingPriceLine | null {
  const starting = rich.startingRentLabel?.trim();
  const range = (rich.priceRangeLabel ?? "").replace(/^\s*base rent\s*/i, "");
  const base = firstMoney(starting || range);
  if (base > 0) {
    // "from" whenever the rooms disagree on price, or when a bare range label already says so itself.
    const from = listingRoomRentsSpread(rich) || (!starting && /^\s*from\b/i.test(range));
    return { label: `${from ? "from " : ""}${formatRoomPriceAmount(base)} / mo`, amount: base, from };
  }
  const lowest = lowestRoomMonthlyRent(rich);
  if (lowest > 0) return { label: `from ${formatRoomPriceAmount(lowest)} / mo`, amount: lowest, from: true };
  return null;
}

export type ListingPriceRow = { key: string; label: string; value: string };

type PriceRowsSubmission = {
  securityDeposit?: string | null;
  rooms?: Array<{ id?: string; name?: string; securityDeposit?: string | null }> | null;
} | null | undefined;

const money = (n: number) => formatRoomPriceAmount(n);

/**
 * The price card's rows table, deterministic: Rent, Security deposit, a Deposit row per room whose deposit
 * differs from the default, Application fee, Nightly rate, then every other fee the projection carries.
 * A row exists only when its value does; nothing is invented and no price that exists is hidden.
 */
export function listingPriceRows(
  rich: Pick<ListingRichContent, "startingRentLabel" | "priceRangeLabel" | "floorPlans" | "pricingBreakdown" | "estimatedMonthlyTotalLabel">,
  sub: PriceRowsSubmission,
  nightlyFrom: number,
  formatLabelMoney: (value: string) => string = (v) => v,
): ListingPriceRow[] {
  const rows: ListingPriceRow[] = [];
  const breakdown = rich.pricingBreakdown ?? [];
  const find = (label: string) => breakdown.find((line) => line.label.trim().toLowerCase() === label.toLowerCase());

  const line = listingMonthlyPriceLine(rich);
  if (line) rows.push({ key: "rent", label: "Rent", value: `${line.from ? "from " : ""}${money(line.amount)}/mo` });

  const estimated = rich.estimatedMonthlyTotalLabel?.trim();
  if (estimated) rows.push({ key: "estimated", label: "Est. with utilities", value: formatLabelMoney(estimated) });

  const defaultDeposit = parseMoneyAmount(sub?.securityDeposit ?? "");
  if (defaultDeposit > 0) {
    rows.push({ key: "deposit", label: "Security deposit", value: money(defaultDeposit) });
  } else {
    const fromFees = find("Security deposit");
    if (fromFees) rows.push({ key: "deposit", label: "Security deposit", value: formatLabelMoney(fromFees.value) });
  }
  for (const room of sub?.rooms ?? []) {
    const own = parseMoneyAmount(room.securityDeposit ?? "");
    if (own > 0 && own !== defaultDeposit) {
      rows.push({ key: `deposit-${room.id ?? room.name}`, label: `Deposit · ${room.name?.trim() || "Room"}`, value: money(own) });
    }
  }

  const application = find("Application fee");
  if (application) rows.push({ key: "application", label: "Application fee", value: formatLabelMoney(application.value) });

  const nightly = find("Nightly rate");
  if (nightly) rows.push({ key: "nightly", label: "Nightly rate", value: formatLabelMoney(nightly.value) });
  else if (nightlyFrom > 0) rows.push({ key: "nightly", label: "Nightly rate", value: `from ${money(nightlyFrom)}/night` });

  const handled = (label: string) => {
    const l = label.trim().toLowerCase();
    return l === "application fee" || l === "nightly rate" || l === "security deposit" || l.startsWith("deposit ·");
  };
  breakdown.forEach((other, index) => {
    if (handled(other.label) || !other.value?.trim()) return;
    rows.push({ key: `fee-${index}-${other.label}`, label: other.label, value: formatLabelMoney(other.value) });
  });
  return rows;
}
