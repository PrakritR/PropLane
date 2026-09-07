/** Shared copy for manager Plan page and public partner pricing — keep amounts aligned with `MANAGER_TIER_MONTHLY_USD`. */

import { commsAllowanceFeatureText } from "@/lib/comms-billing/allowances";

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
      sub: "List one property, run applications and tours, and collect payments, without resident or inbox tools.",
    },
    annual: {
      headline: "Free",
      period: null,
      sub: "List one property, run applications and tours, and collect payments, without resident or inbox tools.",
    },
    features: [
      { text: "1 property listing", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & work orders", included: false },
      { text: "Inbox & co-managers", included: false },
      { text: "Dedicated phone number & texting", included: false },
      { text: commsAllowanceFeatureText("free"), included: true },
      { text: "Priority admin support", included: false },
    ],
  },
  {
    id: "pro",
    label: "Pro",
    monthly: {
      headline: "$20",
      period: "/ mo",
      sub: "Everything in Free, plus residents, lease generation, services, inbox, and up to 2 co-managers.",
    },
    annual: {
      headline: "$192",
      period: "/ yr",
      sub: "Everything in Free, plus residents, lease generation, services, inbox, and up to 2 co-managers (~20% off annual).",
    },
    features: [
      { text: "Up to 2 property listings", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & work orders", included: true },
      { text: "Inbox & up to 2 co-managers", included: true },
      { text: "Dedicated phone number & texting (active paid plan — not during the free trial)", included: true },
      { text: commsAllowanceFeatureText("pro"), included: true },
      { text: "Priority admin support", included: false },
    ],
  },
  {
    id: "business",
    label: "Business",
    monthly: {
      headline: "$200",
      period: "/ mo",
      sub: "Everything in Pro at portfolio scale: 20 properties, 20 co-managers, and priority admin support.",
    },
    annual: {
      headline: "$1,920",
      period: "/ yr",
      sub: "Everything in Pro at portfolio scale: 20 properties, 20 co-managers, and priority support (~20% off annual).",
    },
    features: [
      { text: "Up to 20 property listings", included: true },
      { text: "Applications & tour scheduling", included: true },
      { text: "Payment collection & charges", included: true },
      { text: "Residents, leases & work orders", included: true },
      { text: "Inbox & up to 20 co-managers", included: true },
      { text: "Dedicated phone number & texting (active paid plan — not during the free trial)", included: true },
      { text: commsAllowanceFeatureText("business"), included: true },
      { text: "Priority admin support", included: true },
    ],
  },
];
