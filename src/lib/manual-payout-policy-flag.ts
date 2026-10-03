/**
 * Withdraw-only payouts for every account (studio C2-SX8: "it should just be
 * payout to withdraw to a bank account" — no automatic payout schedule).
 *
 * Default OFF. Turning it on changes real Stripe accounts: new manager
 * accounts are created on manual payouts, and the hourly
 * `/api/cron/manual-payout-policy` job converts existing connected accounts.
 * Set `MANUAL_PAYOUT_POLICY_ENABLED=1` only when the captain rolls it out.
 * Off keeps today's behavior: vendors on manual (vendor banking), managers on
 * weekly Friday deposits.
 */
export function manualPayoutPolicyEnabled(): boolean {
  const raw = process.env.MANUAL_PAYOUT_POLICY_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}
