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
  rentBasis?: "monthly" | "weekly" | "daily";
  dailyRentPrice?: number | null;
  /** Headline weekly rate. A real quoted rate, never 7 x the daily one. */
  weeklyRentPrice?: number | null;
  /** Extra monthly rent on a SHORT tenancy, folded into the rent line. */
  shortLeaseSurchargeMonthly?: string | null;
  /** Months at or below which a tenancy is short. Absent means the surcharge never applies. */
  shortLeaseMaxMonths?: number | null;
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
  /**
   * "flexible" means the room advertises NO billable price — the rent is agreed with
   * each resident (PRP-329). Absent or "fixed" is the long-standing behaviour.
   */
  pricingMode?: "fixed" | "flexible";
  /** Advertised guidance bounds for a flexible room. Never a charge. */
  flexibleRentMin?: number | null;
  flexibleRentMax?: number | null;
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

/** The room's headline weekly price, or undefined when it is not weekly-priced. */
export function roomWeeklyRentPrice(room: RoomPricingLike | null | undefined): number | undefined {
  if (!room || room.rentBasis !== "weekly") return undefined;
  return positiveNumber(room.weeklyRentPrice);
}

/** True only when the manager explicitly priced this room by the week. */
export function roomIsWeeklyPriced(room: RoomPricingLike | null | undefined): boolean {
  return roomWeeklyRentPrice(room) !== undefined;
}

/** True only when the manager explicitly priced this room by the day. */
export function roomIsDailyPriced(room: RoomPricingLike | null | undefined): boolean {
  return roomDailyRentPrice(room) !== undefined;
}

/** "day" / "week" for an explicitly daily- or weekly-priced room, otherwise "month". */
export function roomPricePeriod(room: RoomPricingLike | null | undefined): "day" | "week" | "month" {
  if (roomIsDailyPriced(room)) return "day";
  if (roomIsWeeklyPriced(room)) return "week";
  return "month";
}

/** Short period suffix, e.g. "/day", "/week" or "/mo". */
export function roomPricePeriodSuffix(
  room: RoomPricingLike | null | undefined,
): "/day" | "/week" | "/mo" {
  const period = roomPricePeriod(room);
  return period === "day" ? "/day" : period === "week" ? "/week" : "/mo";
}

/**
 * Weeks used to convert a weekly rate to an approximate MONTHLY figure for sorting,
 * budget filters and aggregate labels ONLY — never for a charge, which always bills
 * real periods. 52/12: a month is not four weeks, and using 4 understates a weekly
 * room by roughly 8% against every monthly room it is ranked beside.
 */
export const WEEKLY_RENT_MONTH_ESTIMATE_WEEKS = 52 / 12;

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
  const weekly = roomWeeklyRentPrice(room);
  if (weekly !== undefined) return Number((weekly * WEEKLY_RENT_MONTH_ESTIMATE_WEEKS).toFixed(2));
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
  weeklyRentPrice?: number | null | undefined,
): number {
  if ((weeklyRentPrice ?? 0) > 0) {
    return Number(((weeklyRentPrice ?? 0) * WEEKLY_RENT_MONTH_ESTIMATE_WEEKS).toFixed(2));
  }
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
  const weekly = roomWeeklyRentPrice(room);
  if (weekly !== undefined) return weekly;
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

/** Whether this room's rent is negotiated per resident rather than advertised as one figure. */
export function roomPricingIsFlexible(room: RoomPricingLike | null | undefined): boolean {
  return room?.pricingMode === "flexible";
}

/**
 * The advertised guidance range for a flexible room, or null when it advertises no
 * numbers at all. A single bound is a legitimate range ("from $600"); normalization
 * has already dropped a maximum below the minimum.
 */
export function roomFlexibleRange(
  room: RoomPricingLike | null | undefined,
): { min?: number; max?: number } | null {
  if (!roomPricingIsFlexible(room)) return null;
  const min = positiveNumber(room?.flexibleRentMin);
  const max = positiveNumber(room?.flexibleRentMax);
  if (min === undefined && max === undefined) return null;
  return { min, max };
}

/**
 * What a PROSPECT is shown for this room.
 *
 * Deliberately never returns a bare number for a flexible room: the range is guidance
 * the manager may agree an exception to, and a naked "$600" would read as the price.
 * With no bounds at all it says so in words rather than inventing $0 — PRP-329 acceptance 2.
 */
export function roomAdvertisedPriceLabel(
  room: RoomPricingLike | null | undefined,
  fallback = "—",
): string {
  if (!roomPricingIsFlexible(room)) return roomHeadlinePriceLabel(room, fallback);
  const suffix = roomPricePeriodSuffix(room);
  const range = roomFlexibleRange(room);
  if (!range) return "Flexible pricing · Contact manager to discuss pricing";
  const { min, max } = range;
  const span =
    min !== undefined && max !== undefined
      ? `${formatRoomPriceAmount(min)}\u2013${formatRoomPriceAmount(max)}`
      : min !== undefined
        ? `From ${formatRoomPriceAmount(min)}`
        : `Up to ${formatRoomPriceAmount(max as number)}`;
  return `${span}${suffix} · Flexible pricing`;
}

/**
 * The comparable figure a flexible room sorts and budget-filters on, or undefined when
 * it advertises no bounds.
 *
 * The MINIMUM, never a midpoint: a midpoint is a number the manager never wrote, and a
 * prospect filtering "under $700" should still be shown a $600-$900 room they may well
 * be able to agree. An unpriced flexible room returns undefined so callers can decide
 * to show-but-not-rank it rather than sorting it as free.
 */
export function roomFlexibleSortAmount(room: RoomPricingLike | null | undefined): number | undefined {
  const range = roomFlexibleRange(room);
  if (!range) return undefined;
  return range.min ?? range.max;
}

/**
 * Whole months a tenancy spans, or undefined when the dates cannot say.
 * Rounds UP, so a 2-month-and-a-day lease is 3 months rather than 2: the threshold
 * is the manager's "2-3 months", and a lease that runs past the window should fall
 * OUT of the surcharge rather than sneak under it on a rounding artefact.
 */
export function tenancyWholeMonths(
  leaseStart: string | null | undefined,
  leaseEnd: string | null | undefined,
): number | undefined {
  const start = String(leaseStart ?? "").trim();
  const end = String(leaseEnd ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return undefined;
  const a = new Date(`${start}T12:00:00Z`);
  const b = new Date(`${end}T12:00:00Z`);
  if (!Number.isFinite(a.getTime()) || !Number.isFinite(b.getTime()) || b < a) return undefined;
  const months =
    (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  return b.getUTCDate() >= a.getUTCDate() ? months + 1 : months;
}

/** The room's short-lease surcharge amount, or 0 when it has none. */
export function roomShortLeaseSurcharge(room: RoomPricingLike | null | undefined): number {
  const value = String(room?.shortLeaseSurchargeMonthly ?? "").trim();
  if (!value) return 0;
  const amount = parseMoneyAmount(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** Prospect-facing note when a room charges extra on short tenancies. */
export function roomShortLeaseListingNote(room: RoomPricingLike | null | undefined): string | null {
  const surcharge = roomShortLeaseSurcharge(room);
  const maxMonths = room?.shortLeaseMaxMonths;
  if (surcharge <= 0 || maxMonths === undefined || !Number.isInteger(maxMonths) || maxMonths < 1) {
    return null;
  }
  const monthWord = maxMonths === 1 ? "month" : "months";
  return `+${formatRoomPriceAmount(surcharge)}/mo on leases of ${maxMonths} ${monthWord} or less`;
}

/** Billable rent for a weekly-priced room over a span of days. */
export function weeklyRentForBillableDays(weeklyRate: number, billableDays: number): number {
  if (!(weeklyRate > 0) || !(billableDays > 0)) return 0;
  return Number(((billableDays / 7) * weeklyRate).toFixed(2));
}

/** Weekly headline rate with any short-lease surcharge folded in (lease + ledger parity). */
export function weeklyRentWithFoldedShortLeaseSurcharge(
  room: RoomPricingLike | null | undefined,
  application: { rentalType?: string | null; leaseStart?: string | null; leaseEnd?: string | null } | null | undefined,
  baseWeekly?: number,
): number | undefined {
  const weekly = baseWeekly ?? roomWeeklyRentPrice(room);
  if (weekly === undefined) return undefined;
  const surcharge = tenancyPaysShortLeaseSurcharge(room, application) ? roomShortLeaseSurcharge(room) : 0;
  const weeklySurcharge = surcharge > 0 ? Number(((surcharge * 12) / 52).toFixed(2)) : 0;
  return Number((weekly + weeklySurcharge).toFixed(2));
}

/**
 * Whether THIS tenancy pays the room's short-lease surcharge.
 *
 * Never on an explicit short-term/nightly stay: that is already priced by its own
 * nightly rate, and charging a monthly short-lease surcharge on top would bill the
 * same shortness twice. Undated leases do NOT get it either — a surcharge must be
 * something the manager can point at a date range to justify, and guessing here
 * would silently raise rent on every lease whose dates have not been filled in.
 */
export function tenancyPaysShortLeaseSurcharge(
  room: RoomPricingLike | null | undefined,
  application: { rentalType?: string | null; leaseStart?: string | null; leaseEnd?: string | null } | null | undefined,
): boolean {
  if (roomShortLeaseSurcharge(room) <= 0) return false;
  const rentalType = application?.rentalType;
  if (rentalType === "short_term" || rentalType === "airbnb") return false;
  const months = tenancyWholeMonths(application?.leaseStart, application?.leaseEnd);
  if (months === undefined) return false;
  // No threshold means the manager never said what "short" is here, so nothing is
  // short. Never guess a window — that would surcharge tenancies nobody agreed to.
  const threshold = Number(room?.shortLeaseMaxMonths);
  if (!Number.isInteger(threshold) || threshold < 1) return false;
  return months <= threshold;
}

/** Whether a placement is a short stay (nightly) or a normal tenancy. */
export type StayKind = "short" | "long";

/**
 * One placement's resolved rent truth. The lease document and the charge ledger both
 * read this, so they cannot quote different numbers for the same resident.
 */
export type StayPricing = {
  stayKind: StayKind;
  basis: "monthly" | "daily" | "weekly";
  dailyRate: number | undefined;
  weeklyRate: number | undefined;
  monthlyRate: number | undefined;
  deposit: number | undefined;
  source: "room" | "listing" | "application_override";
  /**
   * Short-lease surcharge already INCLUDED in {@link monthlyRate}, in dollars.
   *
   * The resident is quoted one honest number ("$1,150/mo"), and this says how much of
   * it is the surcharge so the agreement can print "$1,000 rent + $150 short-lease
   * surcharge" without a second charge appearing on the ledger. 0 when none applies.
   */
  shortLeaseSurcharge: number;
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
function negotiatedMonthlyRent(application: StayPricingInput["application"]): number | undefined {
  const override = positiveMoney(application?.managerRentOverride);
  if (override !== undefined) return override;
  const signed = Number(application?.signedMonthlyRent ?? 0);
  return Number.isFinite(signed) && signed > 0 ? signed : undefined;
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
        weeklyRate: undefined,
        monthlyRate: undefined,
        deposit,
        shortLeaseSurcharge: 0,
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
      weeklyRate: undefined,
      monthlyRate: undefined,
      deposit,
      // A nightly stay is already priced for being short; a monthly short-lease
      // surcharge on top would bill the same shortness twice.
      shortLeaseSurcharge: 0,
      source: roomRate !== undefined ? "room" : "listing",
    };
  }

  const negotiated = negotiatedMonthlyRent(app);
  if (negotiated !== undefined) {
    return {
      stayKind: "long",
      basis: "monthly",
      dailyRate: undefined,
      weeklyRate: undefined,
      monthlyRate: negotiated,
      deposit,
      shortLeaseSurcharge: 0,
      source: "application_override",
    };
  }

  // A flexible room reaching here has NO agreed rent for this resident: every
  // negotiated path above (manager override, signed/renewed rent) already returned.
  // Falling through to the room's own monthly OR daily figure would bill a figure the public listing stopped
  // showing the moment the manager switched to flexible pricing — a stale hidden
  // fixed value, which PRP-329 acceptance 3 names explicitly. Undefined instead, so
  // the caller must obtain an agreed amount before a lease or charge exists. The
  // deposit still resolves: it is agreed separately and is not the negotiated rent.
  if (roomPricingIsFlexible(room)) {
    return {
      stayKind: "long",
      basis: "monthly",
      dailyRate: undefined,
      weeklyRate: undefined,
      monthlyRate: undefined,
      deposit,
      shortLeaseSurcharge: 0,
      source: "room",
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
      weeklyRate: undefined,
      monthlyRate: undefined,
      deposit,
      shortLeaseSurcharge: 0,
      source: "room",
    };
  }

  const roomWeekly = roomWeeklyRentPrice(room);
  if (roomWeekly !== undefined) {
    const surcharge = tenancyPaysShortLeaseSurcharge(room, app) ? roomShortLeaseSurcharge(room) : 0;
    const foldedWeekly = weeklyRentWithFoldedShortLeaseSurcharge(room, app, roomWeekly)!;
    return {
      stayKind: "long",
      basis: "weekly",
      dailyRate: undefined,
      weeklyRate: foldedWeekly,
      monthlyRate: undefined,
      deposit,
      shortLeaseSurcharge: surcharge,
      source: "room",
    };
  }

  // The manager quotes "$1,000/mo, +$150 if the lease is short". The resident should see
  // ONE number, so the surcharge is folded into the rate rather than arriving as a
  // separate fee line, while `shortLeaseSurcharge` keeps the breakdown for the
  // agreement. Folding rather than adding a charge is what keeps the ledger, the lease
  // document and the listing quoting the same figure.
  const baseMonthly = positiveNumber(room?.monthlyRent);
  const surcharge = tenancyPaysShortLeaseSurcharge(room, app) ? roomShortLeaseSurcharge(room) : 0;
  return {
    stayKind: "long",
    basis: "monthly",
    dailyRate: undefined,
    weeklyRate: undefined,
    monthlyRate: baseMonthly === undefined ? undefined : Number((baseMonthly + surcharge).toFixed(2)),
    deposit,
    shortLeaseSurcharge: surcharge,
    source: "room",
  };
}
