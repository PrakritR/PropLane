import "server-only";

import type Stripe from "stripe";
import { manualPayoutPolicyEnabled } from "@/lib/manual-payout-policy-flag";

/** The schedule an owner's account lands on when it first becomes payout-ready: weekly, Mondays. */
export const DEFAULT_AUTOMATIC_PAYOUT_SCHEDULE = { interval: "weekly", weekly_anchor: "monday" } as const;

/**
 * "Payouts just work": when an account first becomes payout-ready and is still on manual, switch it to the
 * automatic default. Never overrides a daily/weekly/monthly choice, never runs while the withdraw-only policy is on,
 * and never touches a vendor account (vendor banking owns its own schedule). The Transfer path is unaffected: the
 * schedule is a setting on the same connected account that transfers already target.
 */
export async function ensureAutomaticPayoutSchedule(
  stripe: Stripe,
  account: Pick<Stripe.Account, "id" | "settings">,
  opts: { vendorOwned: boolean },
): Promise<boolean> {
  if (manualPayoutPolicyEnabled() || opts.vendorOwned) return false;
  if (account.settings?.payouts?.schedule?.interval !== "manual") return false;
  await stripe.accounts.update(account.id, { settings: { payouts: { schedule: { ...DEFAULT_AUTOMATIC_PAYOUT_SCHEDULE } } } });
  return true;
}
