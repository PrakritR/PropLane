import "server-only";
import type Stripe from "stripe";
/** Withdraw-only policy. Repeated calls preserve accounts already on manual payouts. */
export async function ensureManualPayoutPolicy(stripe: Stripe, accountId: string): Promise<boolean> {
  const account = await stripe.accounts.retrieve(accountId);
  if (account.settings?.payouts?.schedule?.interval === "manual") return false;
  await stripe.accounts.update(accountId, { settings: { payouts: { schedule: { interval: "manual" } } } });
  return true;
}
