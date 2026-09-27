import { MANAGER_PLAN_TIERS } from "@/data/manager-plan-tiers";
import { RATE_CARD, formatRateCardUsd } from "@/lib/billing/rate-card";
import { COMMS_INCLUDED_ALLOWANCE_CENTS } from "@/lib/comms-billing/allowances";
import { formatUsdFromCents } from "@/lib/comms-billing/rates";
import { WORKSPACE_PLAN_ENTITLEMENTS } from "@/lib/workspaces/types";

/**
 * The one feature-comparison table for the public pricing surfaces —
 * `/pricing`'s full "Compare every feature" table and the home page pricing
 * teaser's condensed grid both read this SAME array (captain 2026-09-25,
 * item 6: "features from ... the real /pricing page's feature list; nothing
 * invented"). Before this file the table lived only in `pricing/page.tsx`;
 * splitting it out here is what lets the teaser show a subset without a
 * second, driftable copy. Every cell comes from `RATE_CARD` or another
 * enforced source (`manager-plan-tiers.ts`, `comms-billing/allowances.ts`,
 * `workspaces/types.ts`), never a retyped number.
 */

export type CompareCell = boolean | string;
export const YES: CompareCell = true;
export const NO: CompareCell = false;

export type CompareRow = { label: string; cells: [CompareCell, CompareCell, CompareCell] };
export type CompareGroup = { group: string; rows: CompareRow[] };

export const COMPARE: CompareGroup[] = [
  {
    group: "Homes & team",
    rows: [
      {
        // Captain: copy never says "doors" — price is per resident
        // (`docs/agents/...`, proplane-billing-per-actual-resident). The
        // field names on RATE_CARD stay as-is (an internal API name change is
        // a separate, larger piece of work); only the user-facing label changed.
        label: "Residents included",
        cells: [
          String(RATE_CARD.free.includedDoors),
          String(RATE_CARD.pro.includedDoors),
          String(RATE_CARD.business.includedDoors),
        ],
      },
      {
        label: "Extra resident price",
        cells: [
          "—",
          `${formatRateCardUsd(RATE_CARD.pro.perExtraDoorMonthlyCents ?? 0)}/mo`,
          `${formatRateCardUsd(RATE_CARD.business.perExtraDoorMonthlyCents ?? 0)}/mo`,
        ],
      },
      { label: "Co-managers", cells: [NO, "Unlimited", "Unlimited"] },
      { label: "Workspaces", cells: ["1", "1", String(WORKSPACE_PLAN_ENTITLEMENTS.business.workspaces)] },
      { label: "Per-module access for co-managers", cells: [NO, YES, YES] },
    ],
  },
  {
    group: "Leasing",
    rows: [
      { label: "Public listing, apply link, tours", cells: [YES, YES, YES] },
      { label: "Applications", cells: [YES, YES, YES] },
      { label: "Residents & services", cells: [NO, YES, YES] },
      { label: "Lease drafted from the application, e-sign", cells: [NO, YES, YES] },
    ],
  },
  {
    group: "Money",
    rows: [
      { label: "Rent by card or bank", cells: [YES, YES, YES] },
      { label: "Ledger & reports", cells: [YES, YES, YES] },
      { label: "Who pays processing fees", cells: ["Resident", "Resident or manager", "Resident or manager"] },
    ],
  },
  {
    group: "Communication",
    rows: [
      { label: "Work number, texting & calls", cells: [NO, "1 included", "1 per workspace"] },
      {
        label: "Included credit / month",
        cells: [
          formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.free!),
          formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.pro!),
          formatUsdFromCents(COMMS_INCLUDED_ALLOWANCE_CENTS.business!),
        ],
      },
      { label: "AI assistant in the portal", cells: [YES, YES, YES] },
      { label: "AI drafts in Communication", cells: [NO, YES, YES] },
    ],
  },
  {
    group: "Support",
    rows: [{ label: "Priority admin support", cells: [NO, NO, YES] }],
  },
];

export function Check() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4 shrink-0 text-primary"
      aria-hidden
    >
      <path d="M4 10.5l3.5 3.5L16 5.5" />
    </svg>
  );
}

export function Dash() {
  return <span aria-hidden className="inline-block h-[2px] w-3 shrink-0 rounded bg-border" />;
}

export function CellValue({ value }: { value: CompareCell }) {
  if (value === true) return <Check />;
  if (value === false) return <Dash />;
  return <span className="text-[13.5px] font-semibold text-foreground">{value}</span>;
}

/** Tier column headers for a condensed grid — same labels as the full table's. */
export const COMPARE_TIER_LABELS = MANAGER_PLAN_TIERS.map((t) => t.label);

/**
 * Flattens every group's rows and returns just the ones named, in the given
 * order — how the home page teaser shows a representative subset without a
 * second, hand-maintained feature list. A label that does not match a real
 * `COMPARE` row is silently skipped rather than rendered as a placeholder,
 * so a typo or a renamed row shows up as "missing," never as invented copy.
 */
export function pickCompareRows(labels: string[]): CompareRow[] {
  const all = COMPARE.flatMap((g) => g.rows);
  return labels
    .map((label) => all.find((row) => row.label === label))
    .filter((row): row is CompareRow => Boolean(row));
}
