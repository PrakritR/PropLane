/**
 * The one answer to "what percent of rent does PropLane keep?" - shared by the server policy writer and the admin
 * Service modal, so the range and the parse are stated once. Pure and client-safe (no `server-only`, no node imports).
 */

/** PropLane's default cut of rent, in percent (`ownerShareBps` 9000). */
export const DEFAULT_MANAGEMENT_FEE_PERCENT = 10;
export const MAX_MANAGEMENT_FEE_PERCENT = 30;

/** Percent PropLane keeps -> the policy's owner share in basis points. 0 to 30 percent, at most two decimals. */
export function ownerShareBpsForFeePercent(percent: unknown): number | null {
  const n = typeof percent === "number" ? percent : typeof percent === "string" && percent.trim() !== "" ? Number(percent) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_MANAGEMENT_FEE_PERCENT) return null;
  const feeBps = Math.round(n * 100);
  if (Math.abs(feeBps - n * 100) > 1e-6) return null;
  return 10_000 - feeBps;
}

/** The owner share in basis points -> the percent PropLane keeps. */
export function feePercentForOwnerShareBps(ownerShareBps: number): number {
  return (10_000 - ownerShareBps) / 100;
}

export const MANAGEMENT_FEE_RANGE_MESSAGE = `Enter a fee between 0 and ${MAX_MANAGEMENT_FEE_PERCENT}%.`;

/**
 * How one amount of rent splits at a given fee percent: PropLane's fee ROUNDS DOWN to the cent and the owner gets the
 * remainder - the same rule as `targetMonthlyFeeCents` for a month's rent with no monthly minimum (`fee-math.ts`,
 * which is not client-safe, so the card's example lives here). Integer cents in, integer cents out.
 */
export function managementFeeSplitCents(rentCents: number, feePercent: number): { feeCents: number; ownerCents: number } {
  if (!Number.isSafeInteger(rentCents) || rentCents < 0) throw new Error("Rent must be non-negative integer cents.");
  const feeBps = Math.round(feePercent * 100);
  const feeCents = Math.floor((rentCents * feeBps) / 10_000);
  return { feeCents, ownerCents: rentCents - feeCents };
}

