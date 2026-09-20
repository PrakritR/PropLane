/**
 * Prefilled defaults for the charges a lease names (PLAN-0920-0423).
 *
 * A NEW listing arrives with every lease charge filled in with a sensible figure and a
 * "Filled" mark, so the lease it generates states an early move-out fee, a holdover rate
 * and the usual flat fees without the manager typing six numbers. Two of them follow the
 * rent: the early move-out fee is one month of the Default room rent, holdover is one and
 * a half days of it. Those keep tracking the rent until the manager types their own
 * figure, at which point the mark drops and the typed value stands.
 *
 * This is deliberately NOT the Sep 5 "operator default" that was removed from the lease
 * builder: nothing here is a silent fallback inside the document. The figures live ON the
 * listing, visible, marked and editable, and the builder still prints only what the listing
 * saves. Existing listings are untouched — a blank field on an old listing stays blank.
 *
 * `leaseChargeDefaultKeys` on the submission lists the charges still at their default. The
 * wizard shows the mark for those, clears a key when its field is typed over, and the
 * normalizer re-derives the rent-based ones from the current rent on every save/load.
 */
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";

export const LEASE_CHARGE_DEFAULT_KEYS = [
  "longTermBreakLeaseFee",
  "longTermHoldoverDailyRate",
  "longTermReturnedPaymentFee",
  "longTermTrashViolationFee",
  "longTermDepositLaborRate",
  "longTermDepositReissueFee",
] as const;

export type LeaseChargeDefaultKey = (typeof LEASE_CHARGE_DEFAULT_KEYS)[number];

/** The two defaults that follow the rent; everything else is a flat figure. */
export const RENT_BASED_LEASE_CHARGE_KEYS: readonly LeaseChargeDefaultKey[] = [
  "longTermBreakLeaseFee",
  "longTermHoldoverDailyRate",
];

const FLAT_LEASE_CHARGE_DEFAULTS: Record<
  Exclude<LeaseChargeDefaultKey, "longTermBreakLeaseFee" | "longTermHoldoverDailyRate">,
  string
> = {
  longTermReturnedPaymentFee: "35",
  longTermTrashViolationFee: "50",
  longTermDepositLaborRate: "45",
  longTermDepositReissueFee: "25",
};

export function isLeaseChargeDefaultKey(value: unknown): value is LeaseChargeDefaultKey {
  return typeof value === "string" && (LEASE_CHARGE_DEFAULT_KEYS as readonly string[]).includes(value);
}

/**
 * The rent the rent-based defaults derive from: the Default room's rent, else the whole
 * place's, else the first room that has one. Zero when the listing has no rent yet — the
 * rent-based fields then stay blank (and marked) until a rent is typed.
 */
export function leaseChargeDefaultRent(
  sub: Pick<ManagerListingSubmissionV1, "houseDefaults" | "entireHomeMonthlyRent" | "rooms">,
): number {
  const house = Number(sub.houseDefaults?.monthlyRent ?? 0);
  if (Number.isFinite(house) && house > 0) return house;
  const whole = Number(sub.entireHomeMonthlyRent ?? 0);
  if (Number.isFinite(whole) && whole > 0) return whole;
  for (const room of sub.rooms ?? []) {
    const rent = Number(room.monthlyRent ?? 0);
    if (Number.isFinite(rent) && rent > 0) return rent;
  }
  return 0;
}

/** Every default figure for a given monthly rent. Rent-based ones are "" until rent is known. */
export function leaseChargeDefaults(monthlyRent: number): Record<LeaseChargeDefaultKey, string> {
  const rent = Number.isFinite(monthlyRent) && monthlyRent > 0 ? monthlyRent : 0;
  return {
    // One month's rent: the usual liquidated figure for leaving early.
    longTermBreakLeaseFee: rent > 0 ? String(Math.round(rent)) : "",
    // 150 % of the daily rate, rounded up to a whole dollar.
    longTermHoldoverDailyRate: rent > 0 ? String(Math.ceil((rent / 30) * 1.5)) : "",
    ...FLAT_LEASE_CHARGE_DEFAULTS,
  };
}

/** Which charges are still at their default on this listing. Absent = none (an existing listing). */
export function leaseChargeDefaultKeysOf(sub: Pick<ManagerListingSubmissionV1, "leaseChargeDefaultKeys">): LeaseChargeDefaultKey[] {
  const raw = sub.leaseChargeDefaultKeys;
  if (!Array.isArray(raw)) return [];
  return LEASE_CHARGE_DEFAULT_KEYS.filter((k) => raw.includes(k));
}

/** "filled" while the charge is still its prefilled default, else null. */
export function leaseChargeDefaultMark(
  sub: Pick<ManagerListingSubmissionV1, "leaseChargeDefaultKeys">,
  key: LeaseChargeDefaultKey,
): "filled" | null {
  return leaseChargeDefaultKeysOf(sub).includes(key) ? "filled" : null;
}

/**
 * The value a marked, rent-based charge SHOWS: derived from the current rent, so the wizard
 * reads the right figure the moment the rent changes rather than after a save. A charge
 * that is not marked shows exactly what is stored.
 */
export function resolvedLeaseChargeValue(
  sub: Pick<ManagerListingSubmissionV1, "leaseChargeDefaultKeys" | "houseDefaults" | "entireHomeMonthlyRent" | "rooms"> &
    Partial<Record<LeaseChargeDefaultKey, string | undefined>>,
  key: LeaseChargeDefaultKey,
): string {
  const stored = sub[key] ?? "";
  if (!RENT_BASED_LEASE_CHARGE_KEYS.includes(key)) return stored;
  if (!leaseChargeDefaultKeysOf(sub).includes(key)) return stored;
  return leaseChargeDefaults(leaseChargeDefaultRent(sub))[key];
}

/**
 * Seed a NEW listing: every charge marked and filled from its default. Called once from the
 * wizard's blank-listing factory; never from the normalizer, so existing listings are left
 * exactly as saved.
 */
export function seedLeaseChargeDefaults<T extends ManagerListingSubmissionV1>(sub: T): T {
  const defaults = leaseChargeDefaults(leaseChargeDefaultRent(sub));
  return { ...sub, ...defaults, leaseChargeDefaultKeys: [...LEASE_CHARGE_DEFAULT_KEYS] };
}

/**
 * Re-derive the rent-based charges that are still marked from the listing's current rent.
 * Run by the normalizer on every save/load; a typed-over field (key absent) is never touched.
 */
export function refreshMarkedLeaseChargeDefaults<T extends ManagerListingSubmissionV1>(sub: T): T {
  const keys = leaseChargeDefaultKeysOf(sub);
  if (!keys.length) return sub;
  const defaults = leaseChargeDefaults(leaseChargeDefaultRent(sub));
  const next: Partial<Record<LeaseChargeDefaultKey, string | undefined>> = {};
  for (const key of keys) {
    if (!RENT_BASED_LEASE_CHARGE_KEYS.includes(key)) continue;
    next[key] = defaults[key] || undefined;
  }
  return { ...sub, ...next, leaseChargeDefaultKeys: keys };
}

/** Drop a charge's mark once the manager typed over it (the wizard's onChange). */
export function withoutLeaseChargeDefault(
  sub: Pick<ManagerListingSubmissionV1, "leaseChargeDefaultKeys">,
  key: LeaseChargeDefaultKey,
): LeaseChargeDefaultKey[] | undefined {
  const keys = leaseChargeDefaultKeysOf(sub).filter((k) => k !== key);
  return keys.length ? keys : undefined;
}
