/**
 * The single price line at the top of the public listing card.
 *
 * "$1,050 / mo" when the listing rents at one monthly price, "from $1,050 / mo" whenever the figure is the
 * LOWEST of several — a room-by-room listing renting $1,050–$1,800 says "from $1,050 / mo", because the
 * cheapest room's rent is not the price of the home. When nothing prices the listing there is no line at
 * all: the card never prints "$0" or a dash for a price it does not have.
 */
import type { ListingRichContent } from "@/data/listing-rich-content";
import { listingOffersCustomLeaseSurcharge, listingOffersMonthToMonthSurcharge } from "@/lib/listing-fees";
import { parseMoneyAmount } from "@/lib/parse-money";
import { formatRoomPriceAmount } from "@/lib/room-pricing";
import { listingFoldsAllMonthlyFeesIntoRent, type RentRuleAddress } from "@/lib/seattle-rent-rule";

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

/** `title` is the row's hover text: the formula behind a figure, never a line printed under the row. */
export type ListingPriceRow = { key: string; label: string; value: string; title?: string };

type PriceRowsSubmission = {
  securityDeposit?: string | null;
  monthToMonthSurcharge?: string | null;
  customLeaseSurcharge?: string | null;
  allowedLeaseTerms?: string[] | null;
  leaseTermsBody?: string | null;
  shortTermRentalsAllowed?: boolean | null;
  airbnbRentalsAllowed?: boolean | null;
  address?: string;
  city?: string;
  state?: string;
  neighborhood?: string;
  zip?: string;
  rooms?: Array<{ id?: string; name?: string; securityDeposit?: string | null }> | null;
  /** The whole-home arrangement's proration method, when the listing rents as one home. */
  entireHomeProrateMethod?: string | null;
} | null | undefined;

/**
 * The first month is billed by the day; the formula is the row's tooltip. True only while the listing prorates from
 * the monthly rent (`prorateMethod: "auto"`, what `computeProratedFirstMonthTotals` does by default).
 */
export const FIRST_MONTH_PRORATION_FORMULA = "Monthly rent ÷ days in that month × days you stay; a move-in on the 1st is a full month";

/**
 * A room (or the whole home) set to "Set per day" bills `dailyRentRate × days`, which is NOT the monthly-rent formula,
 * so the row says what is true for every room instead of quoting a figure the first charge will not match.
 */
export const FIRST_MONTH_DAILY_RATE_PRORATION_FORMULA = "Charged for the days you stay; a room priced per day uses its own daily rate";

/**
 * Does anything on this listing prorate from a per-day rate rather than the monthly rent? Read from the submission the
 * billing engine reads (`entireHomeProrateMethod`, each room's own `prorateMethod`, and the per-resident / per-term
 * price rows that override it), so the public tooltip cannot promise a formula the charge does not use.
 */
export function listingProratesFromDailyRate(sub: PriceRowsSubmission): boolean {
  if (sub?.entireHomeProrateMethod === "daily_rate") return true;
  const seen = new Set<unknown>();
  const visit = (node: unknown, depth: number): boolean => {
    if (node === null || typeof node !== "object" || depth > 6 || seen.has(node)) return false;
    seen.add(node);
    if (Array.isArray(node)) return node.some((item) => visit(item, depth + 1));
    const row = node as Record<string, unknown>;
    if (row.prorateMethod === "daily_rate") return true;
    return Object.values(row).some((value) => visit(value, depth + 1));
  };
  return visit(sub?.rooms ?? null, 0);
}

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
  /** The stored property record: a Seattle property whose submission never recorded a city is still Seattle. */
  listingProperty?: RentRuleAddress | null,
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

  // The two lease-length surcharges are their own labelled rows, behind the same gate every reader uses
  // (offered lease length + the Seattle fold-into-rent rule), so a surcharge that is never billed is never shown.
  const gateSub = sub as Parameters<typeof listingOffersMonthToMonthSurcharge>[0] | null | undefined;
  const mtm = parseMoneyAmount(sub?.monthToMonthSurcharge ?? "");
  const showMtm = mtm > 0 && gateSub != null && listingOffersMonthToMonthSurcharge(gateSub, listingProperty);
  if (showMtm) rows.push({ key: "month-to-month", label: "Month-to-month", value: `+${money(mtm)}/mo` });
  const custom = parseMoneyAmount(sub?.customLeaseSurcharge ?? "");
  const showCustom =
    custom > 0 &&
    gateSub != null &&
    listingOffersCustomLeaseSurcharge(gateSub) &&
    !listingFoldsAllMonthlyFeesIntoRent(gateSub, listingProperty);
  if (showCustom) {
    rows.push({ key: "custom-term", label: "Custom term · starts any day", value: `+${money(custom)}/mo` });
  }
  // A monthly rent is what gets prorated; a listing with no monthly price has nothing to prorate. The tooltip states
  // the formula the first charge actually uses, so a per-day room never advertises the monthly-rent arithmetic.
  if (line) {
    rows.push({
      key: "first-month",
      label: "First month",
      value: "Prorated by day",
      title: listingProratesFromDailyRate(sub) ? FIRST_MONTH_DAILY_RATE_PRORATION_FORMULA : FIRST_MONTH_PRORATION_FORMULA,
    });
  }

  const handled = (label: string) => {
    const l = label.trim().toLowerCase();
    return (
      l === "application fee" ||
      l === "nightly rate" ||
      l === "security deposit" ||
      l.startsWith("deposit ·") ||
      // Already shown above as the labelled surcharge rows (or deliberately hidden by the gate).
      l === "month-to-month surcharge" ||
      l === "custom lease"
    );
  };
  breakdown.forEach((other, index) => {
    if (handled(other.label) || !other.value?.trim()) return;
    rows.push({ key: `fee-${index}-${other.label}`, label: other.label, value: formatLabelMoney(other.value) });
  });
  return rows;
}
