import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Enrich a payment ledger row with the charge id and the fee/net Stripe actually reported.
 *
 * `ledger_entries` is the manager's book. Two capture models exist:
 *
 *  - DESTINATION charge (legacy sessions, application fees): created on PropLane's platform account
 *    and transferred to the manager. Stripe's processing fee is debited from PropLane's balance,
 *    never the manager's, so the manager's row carries `stripe_fee_cents = 0` and a net equal to
 *    the destination transfer (charge minus the retained application fee).
 *  - PLATFORM capture (every marked `source_arbitration_v` household payment: no destination, the
 *    central source allocator credits the owner): the fee and net are whatever Stripe's balance
 *    transaction for the charge says. They are written only when that transaction is readable.
 *    Until then they stay NULL ("unknown"): a captured card payment is never recorded as a
 *    0 fee with net equal to gross on the strength of nothing.
 *
 * `stripe_charge_id` is recorded in both models whenever the charge is known.
 */
export async function enrichLedgerPaymentFromStripeCharge(
  db: SupabaseClient,
  stripe: Stripe,
  opts: {
    stripeChargeId: string;
    stripeCheckoutSessionId?: string | null;
    applicationFeeCents?: number | null;
    /** True when the charge was created with `transfer_data.destination` (the legacy model). */
    destinationCharge?: boolean;
  },
): Promise<boolean> {
  const charge = await stripe.charges.retrieve(opts.stripeChargeId, { expand: ["balance_transaction"] });
  const patch: Record<string, unknown> = {
    stripe_charge_id: opts.stripeChargeId,
    updated_at: new Date().toISOString(),
  };
  if (opts.destinationCharge === false) {
    const balance = await readBalanceTransaction(stripe, charge);
    if (balance) {
      patch.stripe_fee_cents = balance.fee;
      patch.net_cents = balance.net;
    }
  } else {
    const applicationFeeCents = typeof opts.applicationFeeCents === "number" ? opts.applicationFeeCents : 0;
    patch.stripe_fee_cents = 0;
    if (typeof charge.amount === "number") patch.net_cents = Math.max(0, charge.amount - applicationFeeCents);
    if (typeof opts.applicationFeeCents === "number") patch.axis_fee_cents = opts.applicationFeeCents;
  }

  let query = db.from("ledger_entries").update(patch).eq("entry_type", "payment");
  if (opts.stripeCheckoutSessionId) {
    query = query.eq("stripe_checkout_session_id", opts.stripeCheckoutSessionId);
  } else {
    query = query.eq("stripe_charge_id", opts.stripeChargeId);
  }

  const { data, error } = await query.select("id").limit(5);
  if (error) throw new Error(error.message);
  return (data?.length ?? 0) > 0;
}

/** The fee and net of the charge's own balance transaction, or null while Stripe has not posted one. */
async function readBalanceTransaction(
  stripe: Stripe,
  charge: Stripe.Charge,
): Promise<{ fee: number; net: number } | null> {
  try {
    const ref = charge.balance_transaction;
    const transaction = typeof ref === "string" ? await stripe.balanceTransactions.retrieve(ref) : ref;
    if (!transaction || !Number.isSafeInteger(transaction.fee) || !Number.isSafeInteger(transaction.net)) return null;
    return { fee: transaction.fee, net: transaction.net };
  } catch {
    return null;
  }
}

export async function stripeChargeIdFromCheckoutSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<string | null> {
  const details = await paymentIntentDetailsFromCheckoutSession(stripe, session);
  return details.chargeId;
}

async function paymentIntentDetailsFromCheckoutSession(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<{ chargeId: string | null; applicationFeeCents: number | null; destinationCharge: boolean }> {
  const piRef = session.payment_intent;
  const piId = typeof piRef === "string" ? piRef : piRef?.id;
  if (!piId) return { chargeId: null, applicationFeeCents: null, destinationCharge: false };

  const pi = await stripe.paymentIntents.retrieve(piId);
  const ch = pi.latest_charge;
  const chargeId = typeof ch === "string" ? ch : ch?.id ?? null;
  return {
    chargeId,
    applicationFeeCents: pi.application_fee_amount ?? null,
    destinationCharge: Boolean(pi.transfer_data?.destination),
  };
}

export async function enrichLedgerFromCheckoutSession(
  db: SupabaseClient,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const { chargeId, applicationFeeCents, destinationCharge } = await paymentIntentDetailsFromCheckoutSession(stripe, session);
  if (!chargeId) return;
  await enrichLedgerPaymentFromStripeCharge(db, stripe, {
    stripeChargeId: chargeId,
    stripeCheckoutSessionId: session.id,
    applicationFeeCents,
    destinationCharge,
  });
}
