/**
 * Shared copy for manager Plan page and public partner pricing. Every dollar
 * figure below is read from `RATE_CARD` (`src/lib/billing/rate-card.ts`), the
 * single source of truth for manager pricing — never typed in here.
 */

import { commsAllowanceFeatureText } from "@/lib/comms-billing/allowances";
import { WORKSPACE_PLAN_ENTITLEMENTS } from "@/lib/workspaces/types";
import { RATE_CARD, annualDiscountPercent, formatRateCardUsd } from "@/lib/billing/rate-card";

const BUSINESS_WORKSPACES = WORKSPACE_PLAN_ENTITLEMENTS.business.workspaces;

const PRO_MONTHLY_USD = formatRateCardUsd(RATE_CARD.pro.floorMonthlyCents);
const PRO_ANNUAL_USD = formatRateCardUsd(RATE_CARD.pro.floorAnnualCents);
const PRO_ANNUAL_DISCOUNT = annualDiscountPercent("pro");
const BUSINESS_MONTHLY_USD = formatRateCardUsd(RATE_CARD.business.floorMonthlyCents);
const BUSINESS_ANNUAL_USD = formatRateCardUsd(RATE_CARD.business.floorAnnualCents);
const BUSINESS_ANNUAL_DISCOUNT = annualDiscountPercent("business");

export type PlanTierId = "free" | "pro" | "business";

export function isPlanTierId(tier: string): tier is PlanTierId {
  return tier === "free" || tier === "pro" || tier === "business";
}

export type PlanPriceBlock = {
  headline: string;
  period: string | null;
  sub: string;
};

export type ManagerPlanTierDefinition = {
  id: PlanTierId;
  label: string;
  monthly: PlanPriceBlock;
  annual: PlanPriceBlock;
  features: { text: string; included: boolean }[];
};

/** Same feature categories in the same order on every card (included = blue check). */
export const MANAGER_PLAN_TIERS: ManagerPlanTierDefinition[] = [
  {
    id: "free",
    label: "Free",
    monthly: {
      headline: "Free",
      period: null,
      sub: "List one property, run applications and tours, and collect payments, with the in-app inbox and email.",
    },
    annual: {
      headline: "Free",
      period: null,
      sub: "List one property, run applications and tours, and collect payments, with the in-app inbox and email.",
    },
    features: [
      { text: "1 property listing", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & services", included: false },
      { text: "Inbox included; co-managers on Pro", included: true },
      { text: "Work number, texting & calls — on Pro", included: false },
      { text: commsAllowanceFeatureText("free"), included: false },
      { text: "Processing fees separate; account approval required for coverage", included: true },
      { text: "Priority admin support", included: false },
    ],
  },
  {
    id: "pro",
    label: "Pro",
    monthly: {
      headline: PRO_MONTHLY_USD,
      period: "/ mo",
      sub: "Everything in Free, plus residents, lease generation, services, inbox, and up to 2 co-managers.",
    },
    annual: {
      headline: PRO_ANNUAL_USD,
      period: "/ yr",
      sub: `Everything in Free, plus residents, lease generation, services, inbox, and up to 2 co-managers (~${PRO_ANNUAL_DISCOUNT}% off annual).`,
    },
    features: [
      { text: "Up to 2 property listings", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & services", included: true },
      { text: "Inbox & up to 2 co-managers", included: true },
      { text: "1 work number — texting & calls", included: true },
      { text: commsAllowanceFeatureText("pro"), included: true },
      { text: "Processing fees separate; account approval required for coverage", included: true },
      { text: "Priority admin support", included: false },
    ],
  },
  {
    id: "business",
    label: "Business",
    monthly: {
      headline: BUSINESS_MONTHLY_USD,
      period: "/ mo",
      sub: "Everything in Pro at portfolio scale: 20 properties, 20 co-managers, and priority admin support.",
    },
    annual: {
      headline: BUSINESS_ANNUAL_USD,
      period: "/ yr",
      sub: `Everything in Pro at portfolio scale: 20 properties, 20 co-managers, and priority support (~${BUSINESS_ANNUAL_DISCOUNT}% off annual).`,
    },
    features: [
      { text: "Up to 20 property listings", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & services", included: true },
      { text: "Inbox & up to 20 co-managers", included: true },
      { text: `${BUSINESS_WORKSPACES} workspaces, a work number in each`, included: true },
      { text: commsAllowanceFeatureText("business"), included: true },
      { text: "Processing fees separate; account approval required for coverage", included: true },
      { text: "Priority admin support", included: true },
    ],
  },
];
