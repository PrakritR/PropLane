import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import type { PlaidApi } from "plaid";
import { attachPlaidBankToStripeCustomer } from "@/lib/plaid/stripe-processor.server";
import { getPlaidItemForOwner, type PlaidItemRow } from "@/lib/plaid/items.server";

export type ResidentPlaidPayDeps = {
  db: SupabaseClient;
  plaid: Pick<PlaidApi, "processorStripeBankAccountTokenCreate">;
  stripe: Pick<Stripe, "tokens" | "customers" | "paymentIntents">;
  /** Original-actor check on the frozen attempt; throws "does not belong" for another resident. */
  assertAttempt: (db: SupabaseClient, paymentIntent: Stripe.PaymentIntent, userId: string) => Promise<unknown>;
  loadItem?: typeof getPlaidItemForOwner;
};

export type ResidentPlaidPayInput = {
  /** The session user. Never taken from the request body. */
  userId: string;
  stripeCustomerId: string;
  paymentIntentId: string;
  plaidItemId: string;
  authorized: boolean;
  ip: string;
  userAgent: string;
};

export type ResidentPlaidPayResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Pay an existing manual-ACH PaymentIntent from a Plaid-linked bank. The one-time debit
 * authorization (`authorized`) is required here as it is on the typed path, and becomes the
 * mandate. The item is looked up by our row id scoped to the session user, and the attempt is
 * proven to be this resident's before any provider call.
 */
export async function payManualAchWithPlaidBank(
  deps: ResidentPlaidPayDeps,
  input: ResidentPlaidPayInput,
): Promise<ResidentPlaidPayResult> {
  if (!input.authorized) return { ok: false, status: 400, error: "Authorize the bank debit first." };
  const loadItem = deps.loadItem ?? getPlaidItemForOwner;
  const item: PlaidItemRow | null = await loadItem(deps.db, input.userId, input.plaidItemId);
  if (!item || item.purpose !== "resident_pay" || item.status !== "active") {
    return { ok: false, status: 404, error: "Bank connection not found." };
  }

  const paymentIntent = await deps.stripe.paymentIntents.retrieve(input.paymentIntentId);
  await deps.assertAttempt(deps.db, paymentIntent, input.userId);
  if (paymentIntent.status !== "requires_payment_method") {
    return { ok: false, status: 409, error: "This bank payment already has a bank on it." };
  }
  const intentCustomer = typeof paymentIntent.customer === "string" ? paymentIntent.customer : paymentIntent.customer?.id;
  if (intentCustomer && intentCustomer !== input.stripeCustomerId) {
    return { ok: false, status: 403, error: "Bank payment is not yours." };
  }

  const { bankAccountId } = await attachPlaidBankToStripeCustomer(
    { plaid: deps.plaid, stripe: deps.stripe },
    { item, stripeCustomerId: input.stripeCustomerId },
  );
  if (!intentCustomer) {
    await deps.stripe.paymentIntents.update(paymentIntent.id, {
      customer: input.stripeCustomerId,
      metadata: { bank_link: "plaid" },
    });
  }
  await deps.stripe.paymentIntents.confirm(paymentIntent.id, {
    payment_method: bankAccountId,
    mandate_data: {
      customer_acceptance: { type: "online", online: { ip_address: input.ip, user_agent: input.userAgent } },
    },
  });
  return { ok: true };
}
