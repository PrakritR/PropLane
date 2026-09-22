/**
 * The one source of truth for PropLane manager pricing (per-door billing,
 * PLAN-DOOR step 2).
 *
 * Before this file, prices lived independently in three places that nothing
 * kept in sync: the caps and dollar figures `manager-access.ts` ENFORCES, the
 * headline copy `manager-plan-tiers.ts` DISPLAYS, and the Stripe price ids
 * `stripe-price-ids.ts` reads from env (which the app never reads amounts back
 * from). Raising a price meant editing two files plus Stripe and hoping they
 * agreed. This file is read BY the other two; it never reads them back, and it
 * has no dependency on this repo's door-count module
 * (`src/lib/billing/door-count*.ts`, owned separately) — it only prices a
 * given door count, it does not compute one.
 *
 * All money is in integer cents, the repo-wide convention (see
 * `comms-billing/allowances.ts`). Every rate-card figure here is a whole
 * dollar amount, but it is still stored in cents for consistency with every
 * other money value in the codebase.
 */

export const RATE_CARD_VERSION = "2026-09-door-v1";

export type RateCardTier = "free" | "pro" | "business";
export type RateCardBilling = "monthly" | "annual";

export type TierRateCard = {
  tier: RateCardTier;
  /** Base subscription price, in cents, for one full monthly billing period. */
  floorMonthlyCents: number;
  /** Base subscription price, in cents, for one full annual billing period. */
  floorAnnualCents: number;
  /** Doors included in the floor before per-door overage applies. */
  includedDoors: number;
  /**
   * Cents per door beyond `includedDoors`, expressed as a monthly rate.
   * `null` means the tier has a hard door cap instead of overage pricing —
   * Free cannot exceed its included doors at all (see `priceForDoors`).
   */
  perExtraDoorMonthlyCents: number | null;
  /** Monthly communication credit included with the plan, in cents. */
  commsIncludedAllowanceCents: number;
};

/**
 * The approved rate card (Option A). An account's price must be pinnable to
 * the version it migrated on — a later rate change adds a NEW version and
 * leaves existing accounts priced under the one they signed up under, rather
 * than silently re-pricing them. Do not mutate the cents figures below for an
 * existing `RATE_CARD_VERSION`; bump the version and (when versioning is
 * wired up by a later step) add a new entry instead.
 */
export const RATE_CARD: Record<RateCardTier, TierRateCard> = {
  free: {
    tier: "free",
    floorMonthlyCents: 0,
    floorAnnualCents: 0,
    includedDoors: 2,
    perExtraDoorMonthlyCents: null,
    commsIncludedAllowanceCents: 0,
  },
  pro: {
    tier: "pro",
    floorMonthlyCents: 4_900,
    floorAnnualCents: 49_000,
    includedDoors: 20,
    perExtraDoorMonthlyCents: 300,
    commsIncludedAllowanceCents: 2_500,
  },
  business: {
    tier: "business",
    floorMonthlyCents: 24_900,
    floorAnnualCents: 249_000,
    includedDoors: 120,
    perExtraDoorMonthlyCents: 200,
    commsIncludedAllowanceCents: 15_000,
  },
};

export const RATE_CARD_TIERS: RateCardTier[] = ["free", "pro", "business"];

function floorCentsFor(tier: RateCardTier, billing: RateCardBilling): number {
  const card = RATE_CARD[tier];
  return billing === "annual" ? card.floorAnnualCents : card.floorMonthlyCents;
}

/**
 * The one place door-price arithmetic happens: floor plus overage.
 *
 * Doors beyond `includedDoors` bill at `perExtraDoorMonthlyCents` per door per
 * month. On `"annual"` billing that monthly overage rate is annualized (×12)
 * so the return value stays "total for one period of this cadence" — the same
 * unit the floor itself is already in; overage is not discounted the way the
 * annual floor is (the rate card gives one overage rate per tier, not a
 * separate annual one).
 *
 * Throws on a negative door count, and throws for Free asked to price more
 * doors than it includes — Free has no overage rate because it is a hard cap,
 * not a price to quote (see `RATE_CARD.free.perExtraDoorMonthlyCents`).
 */
export function priceForDoors(tier: RateCardTier, doors: number, billing: RateCardBilling): number {
  if (!Number.isFinite(doors) || doors < 0) {
    throw new Error(`priceForDoors: doors must be a non-negative number, got ${doors}`);
  }
  const card = RATE_CARD[tier];
  const floor = floorCentsFor(tier, billing);
  const extraDoors = Math.max(0, Math.floor(doors) - card.includedDoors);
  if (extraDoors === 0) return floor;
  if (card.perExtraDoorMonthlyCents === null) {
    throw new Error(
      `priceForDoors: ${tier} has no overage rate and cannot price ${doors} doors above its ${card.includedDoors}-door cap`,
    );
  }
  const periodMultiplier = billing === "annual" ? 12 : 1;
  return floor + extraDoors * card.perExtraDoorMonthlyCents * periodMultiplier;
}

/**
 * Whole-dollar USD for a plan-card headline, e.g. `4_900` -> `"$49"`,
 * `249_000` -> `"$2,490"`. Every rate-card cents figure is a whole dollar
 * amount, so this never needs a decimal.
 */
export function formatRateCardUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("en-US")}`;
}

/**
 * The actual discount annual billing gives vs. paying the monthly floor 12
 * times, rounded to the nearest percent. Computed rather than typed in so
 * marketing copy ("~N% off annual") can never drift from what the floors
 * actually work out to.
 */
export function annualDiscountPercent(tier: RateCardTier): number {
  const card = RATE_CARD[tier];
  if (card.floorMonthlyCents === 0) return 0;
  const fullYear = card.floorMonthlyCents * 12;
  return Math.round((1 - card.floorAnnualCents / fullYear) * 100);
}
