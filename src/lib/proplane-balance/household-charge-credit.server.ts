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
  const managerUserId = session.metadata?.manager_user_id?.trim();
  const managerPayoutCents = Number(session.metadata?.manager_payout_cents ?? "");
  if (!managerUserId || !Number.isFinite(managerPayoutCents) || managerPayoutCents <= 0) return;

  const piRef = session.payment_intent;
  const piId = typeof piRef === "string" ? piRef : piRef?.id;
  if (!piId) return;

  const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge.balance_transaction"] });
  const charge = typeof pi.latest_charge === "string" ? null : pi.latest_charge;
  if (!charge) return;
  const balanceTransaction =
    typeof charge.balance_transaction === "string" ? null : charge.balance_transaction;

  // `available_on` is Stripe's own clearing estimate (epoch seconds); fall
  // back to "now" only if Stripe has not enriched the charge yet, so the entry
  // is never stuck pending forever — `proplane_balance_settle_due` still
  // flips it the moment it is read after that.
  const availableOnIso = balanceTransaction?.available_on
    ? new Date(balanceTransaction.available_on * 1000).toISOString()
    : new Date().toISOString();

  const accountId = await ensureWorkspaceBalanceAccountId(db, managerUserId);
  await creditResidentPaymentPending(db, {
    accountId,
    amountCents: managerPayoutCents,
    availableOnIso,
    stripeChargeId: charge.id,
    idempotencyKey: `resident-payment:${session.id}`,
  });
}
