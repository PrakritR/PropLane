import "server-only";

import type Stripe from "stripe";
import type { PlaidApi } from "plaid";
import { readPlaidAccessToken, type PlaidItemRow } from "@/lib/plaid/items.server";

export type StripeProcessorDeps = {
  plaid: Pick<PlaidApi, "processorStripeBankAccountTokenCreate">;
  stripe: Pick<Stripe, "tokens" | "customers">;
};

/**
 * Turn the resident's Plaid-verified account into a verified bank on their existing Stripe
 * Customer. Plaid only verifies; Stripe still holds the bank and moves the money.
 *
 * Why a legacy `ba_` bank account and not a `us_bank_account` PaymentMethod: a Plaid processor
 * token is a `btok_` Stripe token, and a token cannot be attached through SetupIntents or
 * PaymentMethods. The supported path is `customers.createSource`, which yields a bank account
 * that is already `verified` (no micro-deposits). Stripe lists that object as a `us_bank_account`
 * PaymentMethod under the same `ba_` id, so the existing PaymentIntent confirm (and the saved
 * bank list) take it as is.
 *
 * Reuses a bank already on the customer (same Stripe fingerprint) instead of adding a duplicate.
 * Never returns or logs an account or routing number.
 */
export async function attachPlaidBankToStripeCustomer(
  deps: StripeProcessorDeps,
  input: { item: Pick<PlaidItemRow, "id" | "owner_user_id" | "access_token_enc" | "plaid_account_id">; stripeCustomerId: string },
): Promise<{ bankAccountId: string; reused: boolean }> {
  if (!input.item.plaid_account_id) throw new Error("No bank account was shared.");
  const accessToken = readPlaidAccessToken(input.item);
  const res = await deps.plaid.processorStripeBankAccountTokenCreate({
    access_token: accessToken,
    account_id: input.item.plaid_account_id,
  });
  const tokenId = res.data.stripe_bank_account_token;

  const token = await deps.stripe.tokens.retrieve(tokenId);
  const fingerprint = token.bank_account?.fingerprint ?? null;
  if (fingerprint) {
    const existing = await deps.stripe.customers.listSources(input.stripeCustomerId, { object: "bank_account", limit: 100 });
    const match = existing.data.find(
      (source) => source.object === "bank_account" && source.fingerprint === fingerprint && source.status === "verified",
    );
    if (match) return { bankAccountId: match.id, reused: true };
  }

  const source = await deps.stripe.customers.createSource(input.stripeCustomerId, { source: tokenId });
  if (source.object !== "bank_account" || source.status !== "verified") {
    throw new Error("The linked bank could not be verified.");
  }
  return { bankAccountId: source.id, reused: false };
}
