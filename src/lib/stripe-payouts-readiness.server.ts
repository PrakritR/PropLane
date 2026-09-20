import "server-only";

import type Stripe from "stripe";
import { identityStatusFromAccount } from "@/lib/stripe-connect-identity.server";
import { payoutDestinationsFromAccount, type PayoutDestination } from "@/lib/stripe-external-accounts.server";

export type PayoutsSetupStep = "done" | "needed" | "pending";

export type PayoutsReadiness = {
  identity: PayoutsSetupStep;
  bank: "done" | "needed";
  ready: boolean;
  /** Default-for-currency first. The Withdraw sheet's "To" picker and Bank accounts list both read this. */
  destinations: PayoutDestination[];
};

/**
 * The ONE payouts-ready decision, replacing the separate hand-rolled checks
 * that used to live in `stripe-payouts.ts`'s `resolveSetupState` (bank
 * readiness from "has any external account") and the Payment-settings
 * modal's own `stripeState === "ready"` (Stripe's aggregate
 * `payouts_enabled`/`transfers` capability, a charges-acceptance signal, not
 * a payout-identity one). Every surface that shows a Set up state, gates the
 * Withdraw/Pay out button, or renders a "Payouts · Ready" row reads THIS —
 * never a second computation:
 *
 *   ready = identity verified (Stripe's own `requirements`, the same source
 *           `payout_identity_status` is refreshed from) AND at least one
 *           VERIFIED payout destination (a card is always verified; a bank
 *           account must have cleared micro-deposit/instant verification —
 *           "has some external account" is not enough).
 *
 * Takes an `Account` already fetched by the caller (every caller already
 * does `stripe.accounts.retrieve` for its own balance/create/status read) so
 * this never issues a second Stripe call.
 */
export function resolvePayoutsReadiness(account: Stripe.Account): PayoutsReadiness {
  const identitySnapshot = identityStatusFromAccount(account);
  const identity: PayoutsSetupStep =
    identitySnapshot.status === "verified" ? "done" : identitySnapshot.status === "pending" ? "pending" : "needed";

  const destinations = payoutDestinationsFromAccount(account);
  const hasVerifiedDestination = destinations.some((d) => d.status === "verified");
  const bank: "done" | "needed" = hasVerifiedDestination ? "done" : "needed";

  return {
    identity,
    bank,
    ready: identity === "done" && bank === "done",
    destinations,
  };
}
