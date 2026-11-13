/**
 * The optional tour fee: "applications, leases and tours are free through PropLane by default, but a manager can charge
 * for one". Stored as `tourFeeCents` on the manager's tour settings (property override, workspace row or account row,
 * the same resolution as the notice days); the default is 0 and 0 means nothing at all happens.
 *
 * The decisions live here and in `tour-fee.server.ts` so the booking path, the confirm gate and the cancel path read the
 * same answer. The fee is a `tour_fee` household charge: income, never rent, and its processing fee follows the ordinary
 * payer resolver (`isResidentPaysFeeChargeKind("tour_fee")` is false).
 */

/**
 * Whether a manager can see and set the fee. OFF until a prospect has somewhere safe to pay it: the resident Payments
 * page is stage-locked for a prospect (its link would be a dead click, see "Portal nav locks"), so a booking that raised
 * a fee could not be paid from the notice it sends. The server side (charge at booking, confirm gate, refund on cancel)
 * is built and tested; flipping this on exposes the setting, and the settings route ignores `tourFeeCents` until then.
 */
export const TOUR_FEE_SETTING_ENABLED = false;

/** The most a tour fee can be, in cents ($500). */
export const TOUR_FEE_MAX_CENTS = 50_000;

/** Whole cents, never negative, capped; anything unreadable is 0 (no fee). */
export function normalizeTourFeeCents(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(TOUR_FEE_MAX_CENTS, Math.round(n));
}

/** One fee charge per inquiry: the id is derived from it, so a replayed booking upserts the same row instead of billing twice. */
export function tourFeeChargeId(inquiryId: string): string {
  return `hc_tour_fee_${inquiryId.trim()}`;
}

export function tourFeeAmountLabel(cents: number): string {
  return `$${(Math.max(0, Math.round(cents)) / 100).toFixed(2)}`;
}
