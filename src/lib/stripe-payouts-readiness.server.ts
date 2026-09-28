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
 *           `payout_identity_status` is refreshed from) AND a payable
 *           default payout destination.
 *
 * "Payable" is Stripe's own semantics, not the UI-facing verified/verifying/
 * errored label {@link bankAccountStatus} in `stripe-external-accounts.server.ts`
 * produces. Per Stripe's docs, a Connect external bank account's `status` is
 * one of `new` / `validated` / `verified` / `verification_failed` / `errored`
 * — `new` is the ordinary starting state for a manually-added bank (e.g. the
 * documented test success account 110000000/000123456789) and Stripe pays out
 * to it exactly as with `verified` once the connected account itself has
 * `payouts_enabled: true`; there is no further per-bank verification step to
 * wait for. Only `verification_failed`/`errored` mean Stripe rejected that
 * specific bank and it must be fixed before it can receive money — the ONE
 * state this still refuses. A card is always immediately payable (Stripe
 * accepts or rejects it synchronously at attach time, mapped to "verified"
 * unconditionally by `bankAccountStatus`'s sibling). Gating on `verified`
 * alone left `payouts_enabled` accounts with a fresh bank permanently stuck
 * on "Add a bank account" even though Stripe would pay out today.
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
  const defaultDestination = destinations.find((d) => d.default) ?? destinations[0] ?? null;
  const hasPayableDefaultDestination =
    account.payouts_enabled === true && defaultDestination != null && defaultDestination.status !== "errored";
  const bank: "done" | "needed" = hasPayableDefaultDestination ? "done" : "needed";

  return {
    identity,
    bank,
    ready: identity === "done" && bank === "done",
    destinations,
  };
}
