/**
 * Pure types/helpers for the PropLane balance ledger — no Supabase/Stripe
 * imports here, so this file is safe to unit test without mocking either.
 */

export type BalanceOwnerKind = "workspace" | "vendor";

export type BalanceEntryKind =
  | "resident_payment"
  | "vendor_payment_out"
  | "vendor_payment_in"
  | "withdrawal"
  | "withdrawal_reversal"
  | "fee"
  | "adjustment";

export type BalanceSnapshot = {
  currency: string;
  availableCents: number;
  pendingCents: number;
};

/**
 * `proplane_balance_move` raises exactly
 * `INSUFFICIENT_BALANCE: available=<n> requested=<n>` when the payer's
 * available balance cannot cover the move. Postgres wraps the message (adds a
 * `CONTEXT:` suffix and/or an object qualifier), so this matches the prefix
 * and parses the two numbers out rather than doing an exact match.
 */
export function parseInsufficientBalanceError(
  message: string,
): { availableCents: number; requestedCents: number; shortfallCents: number } | null {
  const match = /INSUFFICIENT_BALANCE:\s*available=(-?\d+)\s+requested=(-?\d+)/.exec(message);
  if (!match) return null;
  const availableCents = Number(match[1]);
  const requestedCents = Number(match[2]);
  if (!Number.isFinite(availableCents) || !Number.isFinite(requestedCents)) return null;
  return { availableCents, requestedCents, shortfallCents: Math.max(0, requestedCents - availableCents) };
}

/**
 * Frees the withdrawal-claim partial unique index
 * (`proplane_balance_withdrawal_claim_unique`, `stripe_object_id is null`)
 * on a claim whose Stripe transfer call itself failed — no real Stripe object
 * exists to stamp, so a timestamped sentinel takes its place. Never matches a
 * real Stripe object id (those start with `tr_`), so it can never be mistaken
 * for one on read.
 */
export function withdrawalReversedSentinel(atIso: string = new Date().toISOString()): string {
  return `reversed:${atIso}`;
}

export function isReversedSentinel(stripeObjectId: string | null | undefined): boolean {
  return typeof stripeObjectId === "string" && stripeObjectId.startsWith("reversed:");
}

/** One cent short of covering `amountCents` given `availableCents`. */
export function shortfallCents(availableCents: number, amountCents: number): number {
  return Math.max(0, amountCents - availableCents);
}
