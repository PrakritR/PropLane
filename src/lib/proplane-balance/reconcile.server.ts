import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";
import { ensureWorkspaceBalanceAccountId, creditResidentPaymentPending } from "@/lib/proplane-balance/ledger.server";

export type ReconcilePlatformLedgerChargesResult = {
  scanned: number;
  credited: number;
  alreadyCredited: number;
  skipped: number;
  errors: string[];
};

const DEFAULT_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_LIMIT = 200;

/**
 * Backstop for `household-charge-credit.server.ts`'s best-effort webhook
 * write: `checkout.session.completed` credits the ledger next to
 * `markHouseholdChargePaidFromStripeSession`, logged on failure rather than
 * thrown (so a transient failure there never fails the webhook's own success
 * path) — which means a failed credit can leave real platform money with NO
 * `proplane_balance_entries` row at all. This finds that gap and closes it.
 *
 * Uses Stripe's Search API (`paymentIntents.search`) to find succeeded
 * PaymentIntents carrying `metadata.funding_model = "platform_ledger"` (the
 * ONE marker `createAxisAchCheckoutSession` stamps for this funding model —
 * see `stripe-axis-ach-checkout.ts`), then, for each one whose charge has NO
 * matching `proplane_balance_entries` row (matched by `stripe_object_id`,
 * `kind = "resident_payment"`), credits it through the EXACT SAME path the
 * webhook uses (`creditResidentPaymentPending`) with the EXACT SAME
 * idempotency key shape (`resident-payment:<checkout session id>`) — so this
 * can never double-credit a charge the webhook already handled (or a late
 * webhook redelivery can never double-credit one this reconciliation already
 * caught), and running this pass twice is a no-op the second time.
 *
 * A no-op entirely while `PROPLANE_BALANCE_ENABLED` is off.
 */
export async function reconcilePlatformLedgerCharges(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { createdAfterEpochSeconds?: number; limit?: number } = {},
): Promise<ReconcilePlatformLedgerChargesResult> {
  const result: ReconcilePlatformLedgerChargesResult = {
    scanned: 0,
    credited: 0,
    alreadyCredited: 0,
    skipped: 0,
    errors: [],
  };
  if (!proplaneBalanceEnabled()) return result;

  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_LIMIT), 1), 1000);
  const createdAfter = opts.createdAfterEpochSeconds ?? Math.floor(Date.now() / 1000) - DEFAULT_LOOKBACK_SECONDS;
  const query = `status:'succeeded' AND metadata['funding_model']:'platform_ledger' AND created>${createdAfter}`;

  let page: string | undefined;
  do {
    let search: Stripe.ApiSearchResult<Stripe.PaymentIntent>;
    try {
      search = await stripe.paymentIntents.search({
        query,
        limit: Math.min(100, limit - result.scanned),
        page,
      });
    } catch (e) {
      result.errors.push(`search: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }

    for (const pi of search.data) {
      if (result.scanned >= limit) break;
      result.scanned += 1;
      try {
        await reconcileOnePaymentIntent(stripe, db, pi, result);
      } catch (e) {
        result.errors.push(`${pi.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    page = search.has_more ? (search.next_page ?? undefined) : undefined;
  } while (page && result.scanned < limit);

  return result;
}

async function reconcileOnePaymentIntent(
  stripe: Stripe,
  db: SupabaseClient,
  pi: Stripe.PaymentIntent,
  result: ReconcilePlatformLedgerChargesResult,
): Promise<void> {
  const managerUserId = pi.metadata?.manager_user_id?.trim();
  const managerPayoutCents = Number(pi.metadata?.manager_payout_cents ?? "");
  if (!managerUserId || !Number.isFinite(managerPayoutCents) || managerPayoutCents <= 0) {
    result.skipped += 1;
    return;
  }

  const chargeRef = pi.latest_charge;
  const chargeId = typeof chargeRef === "string" ? chargeRef : chargeRef?.id;
  if (!chargeId) {
    result.skipped += 1;
    return;
  }

  const { data: existingEntry, error: existingError } = await db
    .from("proplane_balance_entries")
    .select("id")
    .eq("stripe_object_id", chargeId)
    .eq("kind", "resident_payment")
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existingEntry) {
    result.alreadyCredited += 1;
    return;
  }

  // The checkout session this PaymentIntent belongs to — reused so the
  // credit's idempotency key is byte-identical to what the webhook would
  // have used, never a reconciliation-only key scheme.
  const sessions = await stripe.checkout.sessions.list({ payment_intent: pi.id, limit: 1 });
  const session = sessions.data[0];
  if (!session) {
    result.skipped += 1;
    return;
  }

  const charge =
    typeof chargeRef === "string" || !chargeRef
      ? await stripe.charges.retrieve(chargeId, { expand: ["balance_transaction"] })
      : chargeRef;
  const balanceTransaction = typeof charge.balance_transaction === "string" ? null : charge.balance_transaction;
  const availableOnIso = balanceTransaction?.available_on
    ? new Date(balanceTransaction.available_on * 1000).toISOString()
    : new Date().toISOString();

  const accountId = await ensureWorkspaceBalanceAccountId(db, managerUserId);
  const credit = await creditResidentPaymentPending(db, {
    accountId,
    amountCents: managerPayoutCents,
    availableOnIso,
    stripeChargeId: chargeId,
    idempotencyKey: `resident-payment:${session.id}`,
  });
  if (credit.alreadyCredited) result.alreadyCredited += 1;
  else result.credited += 1;
}
