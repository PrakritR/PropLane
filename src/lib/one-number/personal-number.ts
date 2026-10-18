/**
 * Number model (captain, Oct 18): every workspace texts on the set PropLane line. Only a Pro or
 * Business workspace may take a personalized number of its own; PropLane's managed service uses the
 * same default line as everyone and has no exemption. The plan is read only through
 * `resolveEffectiveManagerSkuTier` (docs/agents/plan-entitlements.md); this module holds what a
 * refusal says and the tier rule.
 */

/** A Free workspace stays on the PropLane line. Neutral on purpose: no plan names, no upsell. */
export const PERSONAL_NUMBER_FREE_REFUSAL = {
  code: "personal_number_needs_paid_plan",
  error: "This workspace texts from the PropLane line.",
} as const;

/** The plan tiers that may hold a personalized number. */
export function planMayHavePersonalNumber(tier: "free" | "pro" | "business" | null | undefined): boolean {
  return tier === "pro" || tier === "business";
}
