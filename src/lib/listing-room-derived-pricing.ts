/**
 * Suggested room charges derived from the monthly rent.
 *
 * A manager who has typed a rent has already said most of what the other money
 * fields need. Rather than making them compute a weekly rate or retype the
 * deposit, the wizard SHOWS these as suggestions in the empty fields.
 *
 * ## They are suggestions, not silent writes
 *
 * Nothing here is stored unless the manager accepts it. That is deliberate and
 * not timidity:
 *
 * - A **security deposit** is capped by law in several places PropLane operates,
 *   and the cap depends on the jurisdiction and the lease. Writing "one month's
 *   rent" into a real charge without the manager looking at it would put an
 *   unlawful number on a lease.
 * - A **weekly or daily rate** is not a display convenience — setting one can
 *   change how every rent charge is billed (see docs/agents/rent-basis.md), so
 *   it may only ever be an explicit act.
 *
 * So these values render as the field's placeholder, and a single control lets
 * the manager accept them. What is suggested is visible before it is real.
 */

/** Weeks in a year, so a weekly rate is the true monthly rent annualized. */
const WEEKS_PER_YEAR = 52;
const MONTHS_PER_YEAR = 12;
/** The estimate the rest of the codebase already uses to normalize a daily rate. */
const DAYS_PER_MONTH = 30;

export type DerivedRoomCharges = {
  /** Monthly rent × 12 ÷ 52, rounded to the dollar. */
  weeklyRent: number;
  /** Monthly rent ÷ 30, rounded to the dollar. */
  dailyRent: number;
  /** One month's rent — the common convention, and the number a manager expects to see. */
  securityDeposit: number;
  /** Half a month's rent, rounded to the dollar. */
  moveInFee: number;
};

/**
 * Suggestions for a room, or null when there is no rent to derive them from.
 * A zero or negative rent yields null rather than a row of zeroes, because
 * "$0 suggested" reads as a real answer.
 */
export function derivedRoomCharges(monthlyRent: number): DerivedRoomCharges | null {
  if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) return null;
  return {
    weeklyRent: Math.round((monthlyRent * MONTHS_PER_YEAR) / WEEKS_PER_YEAR),
    dailyRent: Math.round(monthlyRent / DAYS_PER_MONTH),
    securityDeposit: Math.round(monthlyRent),
    moveInFee: Math.round(monthlyRent / 2),
  };
}

/** Formats a suggestion for a placeholder, e.g. "242" for a $242 weekly rate. */
export function suggestionPlaceholder(value: number | undefined): string {
  return value && value > 0 ? String(value) : "";
}

/**
 * Is this field still empty, and therefore showing a suggestion rather than a
 * value the manager chose? Used to label the field so a suggestion is never
 * mistaken for a stored figure.
 */
export function isUnsetCharge(value: string | number | undefined | null): boolean {
  if (typeof value === "number") return !(value > 0);
  return !String(value ?? "").replace(/[^0-9.]/g, "").trim();
}
