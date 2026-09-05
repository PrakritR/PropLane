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
 *
 * The WORK NUMBER is not part of this. Provisioning and holding a number is
 * free on every plan (`rates.ts` zero-rates both meters), so the allowance is
 * spent purely on what the number DOES. Before that, a Free manager's $3/mo
 * number consumed most of their allowance and the number was "free" in name
 * only.
 *
 * Sizing, against the September 2026 cost model — outbound SMS $0.0120,
 * inbound $0.0075, voice $0.0140/min, number $1.15/mo, and a modelled resident
 * at 6 outbound + 4 inbound + 2 voice minutes a month:
 *
 *   Free      $2.50   ~83 texts / ~16 AI turns / ~62 voice min.  Costs us
 *                     ~$0.92 of usage + $1.15 for the number on a $0 plan, so
 *                     it has to be usable for one property without being worth
 *                     farming.
 *   Pro      $15.00   ~500 texts / ~100 AI turns.  ~$5.55 of usage against $20
 *                     of revenue — comfortably inside the plan.
 *   Business $150.00  ~5,000 texts / ~1,000 AI turns.  ~$55 against $200, and
 *                     far above what 20 properties generate.
 *
 * Business is CAPPED rather than unmetered. "No limit" is not a price, it is an
 * unbounded liability on a fixed fee, and it removes the only signal that an
 * account has started doing something nobody priced. The cap sits so far above
 * real use that reaching it is itself the alert — and with a card on file,
 * passing it bills rather than blocks.
 */

export type CommsPlanTier = "free" | "pro" | "business";

/**
 * `null` would mean no cap. Every tier is capped; the type keeps `null` so a
 * deliberate uncapped plan stays expressible without reworking every reader.
 */
export const COMMS_INCLUDED_ALLOWANCE_CENTS: Record<CommsPlanTier, number | null> = {
  free: 250,
  pro: 1500,
  business: 15000,
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
