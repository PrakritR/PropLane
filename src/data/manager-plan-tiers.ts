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
      sub: "Run applications and tours, collect payments, with the in-app inbox and email. Up to 20 residents.",
    },
    annual: {
      headline: "Free",
      period: null,
      sub: "Run applications and tours, collect payments, with the in-app inbox and email. Up to 20 residents.",
    },
    features: [
      { text: "Up to 20 residents", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & services", included: false },
      { text: "Inbox included; co-managers on Pro", included: true },
      { text: "Work number, texting & calls — on Pro", included: false },
      { text: "1 workspace", included: true },
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
      sub: "Everything in Free, plus residents, lease generation, services, inbox, and unlimited co-managers.",
    },
    annual: {
      headline: PRO_ANNUAL_USD,
      period: "/ yr",
      sub: `Everything in Free, plus residents, lease generation, services, inbox, and unlimited co-managers (~${PRO_ANNUAL_DISCOUNT}% off annual).`,
    },
    features: [
      { text: "Up to 100 residents", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & services", included: true },
      { text: "Inbox & unlimited co-managers", included: true },
      { text: "1 work number + 1 work email per workspace", included: true },
      { text: "1 workspace · extras $15/mo", included: true },
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
      sub: "Everything in Pro at portfolio scale: more residents, more included workspaces, and priority admin support.",
    },
    annual: {
      headline: BUSINESS_ANNUAL_USD,
      period: "/ yr",
      sub: `Everything in Pro at portfolio scale: more residents, more included workspaces, and priority support (~${BUSINESS_ANNUAL_DISCOUNT}% off annual).`,
    },
    features: [
      { text: "Up to 500 residents", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & services", included: true },
      { text: "Inbox & unlimited co-managers", included: true },
      { text: "1 work number + 1 work email per workspace", included: true },
      { text: `${BUSINESS_WORKSPACES} workspaces included · extras $30/mo`, included: true },
      { text: commsAllowanceFeatureText("business"), included: true },
      { text: "Processing fees separate; account approval required for coverage", included: true },
      { text: "Priority admin support", included: true },
    ],
  },
];
