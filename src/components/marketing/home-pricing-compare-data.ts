import { MANAGER_PLAN_TIERS, type PlanTierId } from "@/data/manager-plan-tiers";
import { RATE_CARD, formatRateCardUsd, type RateCardTier } from "@/lib/billing/rate-card";
import {
  MANAGED_CONTACT_HREF,
  MANAGED_INCLUDES,
  MANAGED_PRICE_HEADLINE,
} from "@/lib/marketing/managed-service";
import {
  pickCompareRows,
  type CompareCell,
} from "@/components/marketing/site/pricing-compare-data";
import { TIER_CTA } from "@/components/marketing/site/pricing-cards";

/**
 * The homepage's "compare the plans" table. Every row and every software cell is the SAME `COMPARE` data the
 * /pricing page reads (rate card, plan entitlements, comms allowances); the managed column is derived from
 * `MANAGED_INCLUDES` (the service runs the home on PropLane, so it covers a feature when one of its inclusions
 * does) — no number or value is typed here.
 */

export type HomePlanPrice = { price: string; period: string | null; sub: string };

export type HomePlanColumn = {
  id: PlanTierId | "managed";
  name: string;
  monthly: HomePlanPrice;
  /** The yearly floor shown as its per-month equivalent, the way /pricing derives it from the same rate card. */
  annual: HomePlanPrice;
  cta: { href: string; label: string };
};

/** Whole dollars when exact, otherwise dollars and cents ($490 / 12 = $40.83). */
function usd(cents: number): string {
  return cents % 100 === 0
    ? formatRateCardUsd(cents)
    : `$${(cents / 100).toFixed(2)}`;
}

/** Months of the monthly floor an annual plan saves, from the rate card (never typed). */
function monthsFree(tier: RateCardTier): number {
  const card = RATE_CARD[tier];
  return Math.round((card.floorMonthlyCents * 12 - card.floorAnnualCents) / card.floorMonthlyCents);
}
export const ANNUAL_MONTHS_FREE = Math.min(monthsFree("pro"), monthsFree("business"));

function softwareColumn(id: PlanTierId, name: string): HomePlanColumn {
  const card = RATE_CARD[id];
  if (id === "free") {
    const free: HomePlanPrice = { price: usd(card.floorMonthlyCents), period: null, sub: "No card required" };
    return { id, name, monthly: free, annual: free, cta: TIER_CTA[id] };
  }
  return {
    id,
    name,
    monthly: { price: usd(card.floorMonthlyCents), period: "/mo", sub: "Billed monthly" },
    annual: {
      price: usd(Math.round(card.floorAnnualCents / 12)),
      period: "/mo",
      sub: `Billed yearly · ${usd(card.floorAnnualCents)}`,
    },
    cta: TIER_CTA[id],
  };
}

/** Plans in column order: the three software tiers, then the managed service. */
export const HOME_PLAN_COLUMNS: readonly HomePlanColumn[] = [
  ...MANAGER_PLAN_TIERS.map((tier) => softwareColumn(tier.id, tier.label)),
  (() => {
    const quoted: HomePlanPrice = { price: MANAGED_PRICE_HEADLINE, period: null, sub: "Quoted for your home" };
    return {
      id: "managed",
      name: "We manage it for you",
      monthly: quoted,
      annual: quoted,
      cta: { href: MANAGED_CONTACT_HREF, label: "Talk to us" },
    } satisfies HomePlanColumn;
  })(),
];

/** Row label -> the managed-service inclusion that covers it. `null` = the value is quoted per home. */
const MANAGED_COVERAGE: Record<string, (typeof MANAGED_INCLUDES)[number]["id"] | null> = {
  "Residents included": null,
  "Public listing, apply link, tours": "leasing",
  Applications: "leasing",
  "Residents & services": "maintenance",
  "Lease drafted from the application, e-sign": "leasing",
  "Rent by card or bank": "rent",
  "Ledger & reports": "reporting",
  "Work number, texting & calls": "line",
  "AI assistant in the portal": "line",
  "AI drafts in Communication": "line",
};

export type HomeCompareRow = { label: string; cells: [CompareCell, CompareCell, CompareCell, CompareCell] };

/** The same rows, in the same order, for all four plans. */
export const HOME_COMPARE_ROWS: readonly HomeCompareRow[] = pickCompareRows(
  Object.keys(MANAGED_COVERAGE),
).map((row) => {
  const covered = MANAGED_COVERAGE[row.label];
  const managed: CompareCell =
    covered === null
      ? MANAGED_PRICE_HEADLINE
      : MANAGED_INCLUDES.some((item) => item.id === covered);
  return { label: row.label, cells: [...row.cells, managed] };
});
