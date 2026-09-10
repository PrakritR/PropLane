/** Monthly retail communication credit. Number setup and rental are included separately. */

export type CommsPlanTier = "free" | "pro" | "business";

/**
 * `null` would mean no cap. Every tier is capped; the type keeps `null` so a
 * deliberate uncapped plan stays expressible without reworking every reader.
 */
export const COMMS_INCLUDED_ALLOWANCE_CENTS: Record<CommsPlanTier, number | null> = {
  free: 200,
  pro: 1000,
  business: 10000,
};

export function normalizeCommsPlanTier(raw: string | null | undefined): CommsPlanTier {
  const t = String(raw ?? "").trim().toLowerCase();
  if (t === "pro") return "pro";
  if (t === "business") return "business";
  return "free";
}

export function includedAllowanceCents(tier: CommsPlanTier): number | null {
  return COMMS_INCLUDED_ALLOWANCE_CENTS[tier];
}

export type CommsAllowanceState = {
  tier: CommsPlanTier;
  /** null when the plan is uncapped. */
  allowanceCents: number | null;
  usedCents: number;
  /** null when uncapped. Never negative. */
  remainingCents: number | null;
  /** Past the included allowance — from here on, usage costs money. */
  exhausted: boolean;
  /**
   * Hard stop when included and purchased credit are exhausted. A saved card
   * never authorizes more usage.
   */
  blocked: boolean;
};

export function evaluateCommsAllowance(input: {
  tier: CommsPlanTier;
  usedCents: number;
  hasPaymentMethod: boolean;
  purchasedRemainingCents?: number;
}): CommsAllowanceState {
  const allowanceCents = includedAllowanceCents(input.tier);
  const usedCents = Math.max(0, Math.round(input.usedCents));

  if (allowanceCents === null) {
    return {
      tier: input.tier,
      allowanceCents: null,
      usedCents,
      remainingCents: null,
      exhausted: false,
      blocked: false,
    };
  }

  const purchased = Math.max(0, Math.round(input.purchasedRemainingCents ?? 0));
  const exhausted = usedCents >= allowanceCents + purchased;
  return {
    tier: input.tier,
    allowanceCents,
    usedCents,
    remainingCents: Math.max(0, allowanceCents + purchased - usedCents),
    exhausted,
    blocked: exhausted,
  };
}

/** Usage that is actually billable — everything above the included allowance. */
export function billableCentsAboveAllowance(input: {
  tier: CommsPlanTier;
  totalUsedCents: number;
}): number {
  const allowanceCents = includedAllowanceCents(input.tier);
  if (allowanceCents === null) return 0;
  return Math.max(0, Math.round(input.totalUsedCents) - allowanceCents);
}

/**
 * The pricing-card line for a plan's included communication (PRP-282). Derived
 * from the allowance so the public page can never promise a number the code
 * does not enforce; a rate change updates the copy for free.
 */
export function commsAllowanceFeatureText(tier: CommsPlanTier): string {
  const allowance = includedAllowanceCents(tier);
  if (allowance === null) return "Unlimited texting, calls & AI assistant";
  const dollars = allowance % 100 === 0 ? `$${allowance / 100}` : `$${(allowance / 100).toFixed(2)}`;
  return `${dollars}/mo of communication credit included; buy more anytime`;
}

export function commsAllowanceBlockedMessage(tier: CommsPlanTier): string {
  const allowance = includedAllowanceCents(tier);
  const label = allowance === null ? "" : `$${(allowance / 100).toFixed(2)}`;
  return `You've used the ${label} of communication credit included with your plan this month. Buy more usage in Settings → Communication to resume texting, calls and AI. A saved card does not enable automatic charges.`;
}
