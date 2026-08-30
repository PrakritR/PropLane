/**
 * Per-room rent-pricing helpers — the single source of truth for whether a room
 * is priced monthly (the default, unchanged behavior) or by the day, and for the
 * numbers/labels every surface should show.
 *
 * A room always keeps its `monthlyRent`. It MAY additionally carry a headline
 * daily price (`dailyRentPrice`) and a `rentBasis` flag. `rentBasis` is the single
 * tiebreaker for which rate is active:
 *
 *   - absent / "monthly"  → priced monthly; identical to legacy behavior.
 *   - "daily" (+ dailyRentPrice > 0) → priced by the day; charges bill
 *     billable-days × dailyRentPrice using actual day counts.
 *
 * Daily NEVER wins unless the manager explicitly sets rentBasis = "daily", so
 * every existing monthly-priced room is untouched. This is distinct from the
 * proration-only `dailyRentRate`/`prorateMethod` (which only prorate the partial
 * edge months of a monthly room) and from `shortTermDailyCost` (nightly stays).
 */

import { parseMoneyAmount } from "@/lib/parse-money";
import { isIntraMonthStay, shortTermNightlyRate } from "@/lib/short-term-stay-pricing";

/** Minimal shape needed to reason about a room's rent price. */
export type RoomPricingLike = {
  monthlyRent?: number | null;
  rentBasis?: "monthly" | "daily";
  dailyRentPrice?: number | null;
  /**
   * The room's OWN short-term nightly rate (the per-rent-row short-term set). Distinct from
   * {@link dailyRentPrice}, which is the room's headline daily BASIS for an ordinary tenancy.
   * On an explicit short-term application this is the most specific signal there is, so it
   * outranks both the daily basis and the listing-level `shortTermDailyCost`.
   */
  shortTermRent?: string | null;
  /**
   * Per-room deposits. The ledger charges these room-first, falling back to the listing's
   * shared figure, so the resolver has to read them too: a resolver that only ever saw the
   * listing figure would print one deposit on the agreement and bill another.
   */
  securityDeposit?: string | null;
  shortTermDeposit?: string | null;
};

/**
 * Days used to convert a daily rate into an approximate MONTHLY figure for
 * sorting, budget filters, and secondary "≈ $X/mo" hints ONLY. Actual charges
 * always use the real number of days in each billed month, never this constant.
 */
export const DAILY_RENT_MONTH_ESTIMATE_DAYS = 30;

function positiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? parseFloat(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The room's headline daily price, or undefined when it is not daily-priced. */
export function roomDailyRentPrice(room: RoomPricingLike | null | undefined): number | undefined {
  if (!room || room.rentBasis !== "daily") return undefined;
  return positiveNumber(room.dailyRentPrice);
}

/** True only when the manager explicitly priced this room by the day. */
export function roomIsDailyPriced(room: RoomPricingLike | null | undefined): boolean {
  return roomDailyRentPrice(room) !== undefined;
}

/** "day" for a daily-priced room, otherwise "month" (the default). */
export function roomPricePeriod(room: RoomPricingLike | null | undefined): "day" | "month" {
  return roomIsDailyPriced(room) ? "day" : "month";
}

/** Short period suffix, e.g. "/day" or "/mo". */
export function roomPricePeriodSuffix(room: RoomPricingLike | null | undefined): "/day" | "/mo" {
  return roomIsDailyPriced(room) ? "/day" : "/mo";
}

/**
 * A single comparable monthly-equivalent number for sorting, budget filters, and
 * AGGREGATE labels (rent ranges, "starting at", estimated totals) so mixed listings
 * stay coherent as "/mo" while each room's own row still shows its true "$X/day":
 * daily rooms use dailyRentPrice × {@link DAILY_RENT_MONTH_ESTIMATE_DAYS}; monthly
 * rooms use monthlyRent. Returns 0 when nothing is priced.
 */
export function roomMonthlyEquivalent(room: RoomPricingLike | null | undefined): number {
  const daily = roomDailyRentPrice(room);
  if (daily !== undefined) return Number((daily * DAILY_RENT_MONTH_ESTIMATE_DAYS).toFixed(2));
  const monthly = positiveNumber(room?.monthlyRent);
  return monthly ?? 0;
}

/**
 * Monthly-equivalent for a stored rate PAIR (e.g. a recurring rent profile) where a
 * positive daily rate is itself the signal that the daily basis is active — those
 * records carry no `rentBasis` flag. Use this anywhere a persisted rent figure is
 * reported or totalled, so a daily-priced resident never shows as $0/mo.
 */
export function rentMonthlyEquivalent(
  monthlyRent: number | null | undefined,
  dailyRentPrice: number | null | undefined,
): number {
  return roomMonthlyEquivalent({
    monthlyRent,
    rentBasis: (dailyRentPrice ?? 0) > 0 ? "daily" : "monthly",
    dailyRentPrice,
  });
}

/**
 * The headline numeric a card/detail should display (the daily price for daily
 * rooms, the monthly rent otherwise), or null when nothing is priced.
 */
export function roomHeadlineAmount(room: RoomPricingLike | null | undefined): number | null {
  const daily = roomDailyRentPrice(room);
  if (daily !== undefined) return daily;
  const monthly = positiveNumber(room?.monthlyRent);
  return monthly ?? null;
}

/**
 * Formats a headline rent amount: whole dollars stay bare ("$1,200"), fractional
 * amounts always show cents ("$39.50") so a $39.50/day room never renders "$39.5".
 */
export function formatRoomPriceAmount(amount: number): string {
  return Number.isInteger(amount) ? `$${amount.toLocaleString("en-US")}` : `$${amount.toFixed(2)}`;
}

/**
 * The room's headline price label, e.g. "$40/day" or "$825/mo". Returns
 * `fallback` when nothing is priced.
 */
export function roomHeadlinePriceLabel(
  room: RoomPricingLike | null | undefined,
  fallback = "—",
): string {
  const amount = roomHeadlineAmount(room);
  if (amount === null) return fallback;
  return `${formatRoomPriceAmount(amount)}${roomPricePeriodSuffix(room)}`;
}

/** Whether a placement is a short stay (nightly) or a normal tenancy. */
export type StayKind = "short" | "long";

/**
 * One placement's resolved rent truth. The lease document and the charge ledger both
 * read this, so they cannot quote different numbers for the same resident.
 */
export type StayPricing = {
  stayKind: StayKind;
  basis: "monthly" | "daily";
  dailyRate: number | undefined;
  monthlyRate: number | undefined;
  deposit: number | undefined;
  source: "room" | "listing" | "application_override";
};

export type StayPricingInput = {
  room: RoomPricingLike | null | undefined;
  submission:
    | {
        shortTermDailyCost?: string;
        shortTermDeposit?: string;
        securityDeposit?: string;
        /** The manager's own declaration that this listing offers short stays. */
        shortTermRentalsAllowed?: boolean;
      }
    | null
    | undefined;
  application:
    | {
        rentalType?: string | null;
        leaseStart?: string | null;
        leaseEnd?: string | null;
        managerRentOverride?: string | null;
        managerSecurityDepositOverride?: string | null;
        signedMonthlyRent?: number | null;
      }
    | null
    | undefined;
};

function positiveMoney(raw: string | null | undefined): number | undefined {
  const amount = parseMoneyAmount(String(raw ?? "").trim());
  return Number.isFinite(amount) && amount > 0 ? amount : undefined;
}

/**
 * A manager override is authoritative whenever it is NON-EMPTY, including when it parses to
 * zero. Mirrors `savedAmount` in household-charges.ts: an override of "0" (a waived deposit)
 * makes the ledger charge nothing, so the document must quote $0.00 rather than falling back
 * to the listing default and printing a deposit that is never billed.
 */
function overrideMoney(raw: string | null | undefined): number | undefined {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  const amount = parseMoneyAmount(value);
  return Number.isFinite(amount) ? amount : undefined;
}

/**
 * The resident's own negotiated monthly rent, which outranks the room's listing price
 * (monthly OR daily). Mirrors `residentNegotiatedMonthlyRent` in household-charges.ts.
 */
export function negotiatedMonthlyRentAmount(input: {
  managerRentOverride?: string | null;
  signedMonthlyRent?: number | null;
}): number {
  const override = positiveMoney(input.managerRentOverride);
  if (override !== undefined) return override;
  const signed = Number(input.signedMonthlyRent ?? 0);
  return Number.isFinite(signed) && signed > 0 ? signed : 0;
}

function negotiatedMonthlyRent(application: StayPricingInput["application"]): number | undefined {
  const amount = negotiatedMonthlyRentAmount({
    managerRentOverride: application?.managerRentOverride,
    signedMonthlyRent: application?.signedMonthlyRent,
  });
  return amount > 0 ? amount : undefined;
}

/**
 * Resolves the rate, basis, and deposit for one placement.
 *
 * Precedence, in order:
 *  1. An explicit short-term application is a short stay, priced by the day. The ROOM the
 *     applicant selected is the authority for the rate; the listing's `shortTermDailyCost`
 *     is only the fallback. A negotiated monthly rent deliberately does NOT apply here —
 *     the short-term charge path does not consult it either, and letting the document do so
 *     would recreate the document/ledger disagreement this resolver exists to remove.
 *  2. Otherwise a negotiated monthly rent (manager override, then signed/renewed rent) wins.
 *  3. Otherwise a room priced by the day is a short stay ONLY when the manager offers short
 *     stays on this listing (`shortTermRentalsAllowed`) AND the stay fits inside one calendar
 *     month. Both signals are required: the short-term agreement asserts an owner-occupied
 *     residence and disclaims tenancy, which a billing-basis flag plus two dates cannot
 *     establish. Without the tick the placement keeps the full residential lease, which now
 *     quotes the daily rate.
 *  4. Otherwise the room's monthly rent, byte-identical to legacy behavior.
 *
 * The deposit deliberately keys on `rentalType`, NOT on the resolved `stayKind`, because it
 * has to agree with the ledger branch that actually charges it: only an explicit short-term
 * application is billed `shortTermDeposit`. A daily-priced room on a standard application that
 * reaches the short-term DOCUMENT is therefore still quoted the standard `securityDeposit`,
 * which is what the resident is really charged.
 *
 * `leaseStart` / `leaseEnd` are REQUIRED for a correct short/long decision — they feed
 * `isIntraMonthStay`, which is half the gate in clause 3 above. Omitting them makes that gate
 * fail, so the placement resolves `"long"` and the resident signs the full residential lease.
 * That is the deliberate fail-safe direction, but it is still the WRONG document for a real
 * short stay, so always pass them. Night counting stays in `shortTermStayNightCount`, the one
 * implementation the ledger bills from.
 */
export function resolveStayPricing(input: StayPricingInput): StayPricing {
  const { room, submission: sub, application: app } = input;
  const isShortTermApplication = app?.rentalType === "short_term";
  const roomDaily = roomDailyRentPrice(room);

  // Room-first, then the listing, mirroring the ledger exactly. The room leg is what makes
  // the agreement's deposit equal the deposit actually charged; reading only the listing
  // figure understated the total on every listing whose room carries its own deposit.
  // The room leg uses overrideMoney (non-EMPTY wins), not positiveMoney (non-ZERO wins),
  // because the ledger's test is emptiness too. A manager who waives the deposit on one
  // room by entering "0" is charged nothing, so the agreement must print $0 rather than
  // skipping the room and quoting the listing's figure.
  const deposit = isShortTermApplication
    ? (overrideMoney(app?.managerSecurityDepositOverride) ??
      overrideMoney(room?.shortTermDeposit) ??
      positiveMoney(sub?.shortTermDeposit))
    : (overrideMoney(app?.managerSecurityDepositOverride) ??
      overrideMoney(room?.securityDeposit) ??
      positiveMoney(sub?.securityDeposit));

  if (isShortTermApplication) {
    // A rate negotiated for THIS resident outranks every listing figure, on a short stay
    // exactly as on a long one. The ledger has always applied it here, so the resolver must
    // too, or the agreement quotes the listing rate while the guest is billed the negotiated
    // one. It is the stay's nightly rate, since a short stay bills by the night.
    const negotiatedNightly = negotiatedMonthlyRent(app);
    if (negotiatedNightly !== undefined) {
      return {
        stayKind: "short",
        basis: "daily",
        dailyRate: negotiatedNightly,
        monthlyRate: undefined,
        deposit,
        source: "application_override",
      };
    }
    // Then most specific first: the booked room's own short-term rate, then the room's
    // daily basis, then the listing-level nightly cost. The room's short-term rate leads
    // because it is the rate the manager set FOR a short stay on that exact room.
    const roomShortTerm = shortTermNightlyRate(room?.shortTermRent) || undefined;
    const listingDaily = shortTermNightlyRate(sub?.shortTermDailyCost) || undefined;
    const roomRate = roomShortTerm ?? roomDaily;
    const dailyRate = roomRate ?? listingDaily;
    return {
      stayKind: "short",
      basis: "daily",
      dailyRate,
      monthlyRate: undefined,
      deposit,
      source: roomRate !== undefined ? "room" : "listing",
    };
  }

  const negotiated = negotiatedMonthlyRent(app);
  if (negotiated !== undefined) {
    return {
      stayKind: "long",
      basis: "monthly",
      dailyRate: undefined,
      monthlyRate: negotiated,
      deposit,
      source: "application_override",
    };
  }

  if (roomDaily !== undefined) {
    // The daily basis alone does NOT make this a short stay. A daily-priced room is a
    // supported way to bill a normal tenancy (see RecurringRentProfile.dailyRentPrice), and
    // those bill monthly and recurring. The lodger document needs an EXPLICIT manager signal
    // that this listing hosts short stays, plus a span the ledger settles as ONE up-front
    // total; anything else keeps the full residential lease and just quotes the daily rate.
    // Basis stays "daily" either way, so rent labels follow the rate.
    const offersShortStays = Boolean(sub?.shortTermRentalsAllowed);
    return {
      stayKind:
        offersShortStays && isIntraMonthStay(app?.leaseStart, app?.leaseEnd) ? "short" : "long",
      basis: "daily",
      dailyRate: roomDaily,
      monthlyRate: undefined,
      deposit,
      source: "room",
    };
  }

  return {
    stayKind: "long",
    basis: "monthly",
    dailyRate: undefined,
    monthlyRate: positiveNumber(room?.monthlyRent),
    deposit,
    source: "room",
  };
}
