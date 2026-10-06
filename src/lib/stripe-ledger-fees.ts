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
 *    central source allocator credits the owner): the money is captured on PropLane's platform, so
 *    Stripe's own fee is PropLane's cost and never belongs on the manager's book. The row carries
 *    the FROZEN per-charge `recipient_net_cents` the owner is actually paid, and a fee of only what
 *    the owner bears under the frozen fee payer — the processing fee when it is `manager`, zero when
 *    the resident or PropLane absorbs it. Until those frozen terms exist the fee and net stay NULL
 *    ("unknown"): a captured card payment is never recorded as a 0 fee with net equal to gross on
 *    the strength of nothing, and never as the platform's net either.
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
  if (opts.destinationCharge === false) {
    return enrichPlatformCaptureLedger(db, opts.stripeChargeId, opts.stripeCheckoutSessionId ?? null);
  }
  const charge = await stripe.charges.retrieve(opts.stripeChargeId);
  const patch: Record<string, unknown> = {
    stripe_charge_id: opts.stripeChargeId,
    updated_at: new Date().toISOString(),
  };
  const applicationFeeCents = typeof opts.applicationFeeCents === "number" ? opts.applicationFeeCents : 0;
  patch.stripe_fee_cents = 0;
  if (typeof charge.amount === "number") patch.net_cents = Math.max(0, charge.amount - applicationFeeCents);
  if (typeof opts.applicationFeeCents === "number") patch.axis_fee_cents = opts.applicationFeeCents;

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

type CapturedRecipientTerms = {
  source_fee_payer: string | null;
  source_verified_at: string | null;
  source_components: Array<{
    source_id: string; principal_cents: number; recipient_net_cents: number;
  }> | null;
};

/**
 * A platform capture's manager rows, written per charge from the hold's own frozen components —
 * the capture can cover a whole cart, and each charge's recipient net is its own fact.
 *
 * With no verified frozen terms yet, only `stripe_charge_id` is recorded and fee/net stay NULL.
 */
async function enrichPlatformCaptureLedger(
  db: SupabaseClient,
  stripeChargeId: string,
  stripeCheckoutSessionId: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data: holds, error } = await db
    .from("platform_payment_holds")
    .select("source_fee_payer,source_verified_at,source_components")
    .eq("stripe_charge_id", stripeChargeId)
    .limit(2);
  if (error) throw new Error(error.message);
  const hold = (holds ?? []).length === 1 ? ((holds ?? [])[0] as CapturedRecipientTerms) : null;
  const feePayer = hold?.source_verified_at ? hold.source_fee_payer : null;
  const components = Array.isArray(hold?.source_components) ? hold!.source_components! : [];

  if (feePayer && components.length) {
    let patched = 0;
    for (const component of components) {
      if (!component.source_id?.trim() ||
          !Number.isSafeInteger(component.principal_cents) ||
          !Number.isSafeInteger(component.recipient_net_cents) ||
          component.recipient_net_cents <= 0 ||
          component.recipient_net_cents > component.principal_cents) {
        // Leave this row unknown rather than record a figure the capture does not support.
        continue;
      }
      const { data, error: updateError } = await db
        .from("ledger_entries")
        .update({
          stripe_charge_id: stripeChargeId,
          net_cents: component.recipient_net_cents,
          // Only what the owner bears. A resident- or PropLane-paid processing fee is a
          // known zero on the owner's book, not an unknown.
          stripe_fee_cents: feePayer === "manager"
            ? component.principal_cents - component.recipient_net_cents
            : 0,
          updated_at: now,
        })
        .eq("entry_type", "payment")
        .eq("source_charge_id", component.source_id)
        .select("id")
        .limit(5);
      if (updateError) throw new Error(updateError.message);
      patched += data?.length ?? 0;
    }
    if (patched > 0) return true;
  }

  let query = db
    .from("ledger_entries")
    .update({ stripe_charge_id: stripeChargeId, updated_at: now })
    .eq("entry_type", "payment");
  query = stripeCheckoutSessionId
    ? query.eq("stripe_checkout_session_id", stripeCheckoutSessionId)
    : query.eq("stripe_charge_id", stripeChargeId);
  const { data, error: fallbackError } = await query.select("id").limit(5);
  if (fallbackError) throw new Error(fallbackError.message);
  return (data?.length ?? 0) > 0;
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
