/**
 * Included communication allowance, by plan.
 *
 * Every manager gets a real amount of texting, calling and AI for free, so a
 * work number can be set up and used without a card on file at all. Only usage
 * BEYOND the allowance is billed, and only then is a card required.
 *
 * The allowance is expressed in CENTS OF USAGE VALUE rather than a message
 * count, because the meters are not comparable: an outbound SMS segment is 3¢
 * and an AI turn is 15¢. One number per plan covers every meter and stays
 * correct when a rate changes.
 */

export type CommsPlanTier = "free" | "pro" | "business";

/** `null` means no cap — Business is unmetered by design. */
export const COMMS_INCLUDED_ALLOWANCE_CENTS: Record<CommsPlanTier, number | null> = {
  // ~165 outbound texts, or ~33 AI turns, or ~2 hours of calls a month. Enough
  // to genuinely run a small portfolio, not enough to be worth abusing.
  free: 500,
  // 5x Free.
  pro: 2500,
  business: null,
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
   * Hard stop: the allowance is spent AND there is no card to bill. This is the
   * only state that refuses to send; with a card, going over simply bills.
   */
  blocked: boolean;
};

export function evaluateCommsAllowance(input: {
  tier: CommsPlanTier;
  usedCents: number;
  hasPaymentMethod: boolean;
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

  const exhausted = usedCents >= allowanceCents;
  return {
    tier: input.tier,
    allowanceCents,
    usedCents,
    remainingCents: Math.max(0, allowanceCents - usedCents),
    exhausted,
    blocked: exhausted && !input.hasPaymentMethod,
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

export function commsAllowanceBlockedMessage(tier: CommsPlanTier): string {
  const allowance = includedAllowanceCents(tier);
  const label = allowance === null ? "" : `$${(allowance / 100).toFixed(2)}`;
  return `You've used the ${label} of messaging and calling included with your plan this month. Add a card in Settings → Communication to keep sending — usage past the included amount is billed as you go.`;
}
