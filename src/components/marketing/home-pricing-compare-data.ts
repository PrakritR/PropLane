import { MANAGER_PLAN_TIERS, type PlanTierId } from "@/data/manager-plan-tiers";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
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

export type HomePlanColumn = {
  id: PlanTierId | "managed";
  name: string;
  price: string;
  period: string | null;
  cta: { href: string; label: string };
};

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

/** Plans in column order: the three software tiers, then the managed service. */
export const HOME_PLAN_COLUMNS: readonly HomePlanColumn[] = [
  ...MANAGER_PLAN_TIERS.map(
    (tier): HomePlanColumn => ({
      id: tier.id,
      name: tier.label,
      price:
        tier.id === "free"
          ? formatRateCardUsd(RATE_CARD.free.floorMonthlyCents)
          : tier.monthly.headline,
      period: tier.id === "free" ? null : "/mo",
      cta: TIER_CTA[tier.id],
    }),
  ),
  {
    id: "managed",
    name: "We manage it for you",
    price: MANAGED_PRICE_HEADLINE,
    period: null,
    cta: { href: MANAGED_CONTACT_HREF, label: "Talk to us" },
  },
];

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
