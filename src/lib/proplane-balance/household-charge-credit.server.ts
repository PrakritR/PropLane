import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ensureWorkspaceBalanceAccountId, creditResidentPaymentPending } from "@/lib/proplane-balance/ledger.server";

/**
 * Webhook-side half of the funding switch in `stripe-axis-ach-checkout.ts`.
 * Runs next to `markHouseholdChargePaidFromStripeSession` in the
 * `checkout.session.completed` handler; a no-op unless the checkout session
 * itself opted into `funding_model: "platform_ledger"` (only resident
 * household-charge checkout, only when `PROPLANE_BALANCE_ENABLED` was on at
 * checkout time — see `stripe-household-charge-checkout.server.ts`).
 *
 * Credits a PENDING `resident_payment` entry for the manager's PropLane
 * balance, `available_on` the charge's own Stripe balance-transaction
 * available date — the same clearing window a destination transfer would have
 * waited on. Idempotent on the checkout session id, so a webhook redelivery
 * (or the success-page retry every other path here tolerates) never double-credits.
 */
export async function creditProplaneBalanceFromHouseholdChargeSession(
  db: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<void> {
  if (session.metadata?.funding_model !== "platform_ledger") return;
  if (session.payment_status !== "paid") return;
  const managerUserId = session.metadata?.manager_user_id?.trim();
  const managerPayoutCents = Number(session.metadata?.manager_payout_cents ?? "");
  if (!managerUserId || !Number.isSafeInteger(managerPayoutCents) || managerPayoutCents <= 0) {
    throw new Error("Resident balance payment lacks its captured recipient amount.");
  }

  const piRef = session.payment_intent;
  const piId = typeof piRef === "string" ? piRef : piRef?.id;
  if (!piId) throw new Error("Paid resident balance session has no payment intent.");

  const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge.balance_transaction"] });
  const charge = typeof pi.latest_charge === "string" ? null : pi.latest_charge;
  if (pi.status !== "succeeded" || pi.currency !== "usd" || !charge ||
      !charge.paid || charge.status !== "succeeded" || charge.currency !== "usd" ||
      (typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id) !== pi.id ||
      charge.amount !== session.amount_total ||
      pi.metadata?.manager_user_id !== managerUserId ||
      Number(pi.metadata?.manager_payout_cents) !== managerPayoutCents) {
    throw new Error("Resident balance credit requires a succeeded exact provider charge.");
  }
  const balanceTransaction =
    typeof charge.balance_transaction === "string" ? null : charge.balance_transaction;

  if (!balanceTransaction?.available_on || !Number.isSafeInteger(balanceTransaction.available_on)) {
    throw new Error("Resident balance credit is waiting for Stripe clearing evidence.");
  }
  const availableOnIso = new Date(balanceTransaction.available_on * 1000).toISOString();

  const accountId = await ensureWorkspaceBalanceAccountId(db, managerUserId);
  await creditResidentPaymentPending(db, {
    accountId,
    amountCents: managerPayoutCents,
    availableOnIso,
    stripeChargeId: charge.id,
    idempotencyKey: `resident-payment:${session.id}`,
  });
}
