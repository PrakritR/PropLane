import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStripeConnectAccountAccessError } from "@/lib/stripe-connect";

export type PayoutDestinationKind = "bank" | "card";
export type PayoutDestinationStatus = "verified" | "verifying" | "errored";

export type PayoutDestination = {
  id: string;
  kind: PayoutDestinationKind;
  /** Bank name (e.g. "Chase") for a bank account, or card brand (e.g. "Visa") for a card. */
  label: string;
  last4: string;
  status: PayoutDestinationStatus;
  default: boolean;
};

export type AddDestinationResult =
  | { ok: true; destination: PayoutDestination }
  | { ok: false; status: 422 | 400; error: string };

export type RemoveDestinationResult = { ok: true } | { ok: false; status: 409 | 400; error: string };

/**
 * A caught Stripe error's own message is usually safe to show (Stripe writes
 * these for end users — "Invalid bank account number", "Your card was
 * declined") EXCEPT the one class that embeds our internal Connect account id
 * ("This API key does not have access to account acct_123…"), which is an
 * infrastructure leak, not user input feedback. Only that class is swapped
 * for a generic message; everything else passes through, matching how
 * `validatePayoutAgainstBalance` already surfaces Stripe-informed text.
 */
function stripeExternalAccountErrorMessage(e: unknown, context: string): string {
  const message = e instanceof Error ? e.message : "Could not complete that request.";
  if (isStripeConnectAccountAccessError(message)) {
    console.error(`[${context}]`, message);
    return "We couldn't reach your Stripe account. Try reconnecting.";
  }
  return message;
}

/**
 * Maps a Stripe external account's `status` to the three states the UI shows.
 * Documented values for an EXTERNAL (Connect) bank account are `new`,
 * `errored`, `verification_failed`, `tokenized_account_number_deactivated`
 * (the `validated`/`verified` states describe a CUSTOMER-owned bank account) —
 * this still maps the fuller set defensively since Stripe's own typing
 * leaves `status` as a bare `string`. An unrecognized future value fails
 * closed to "verifying" rather than claiming "verified".
 */
function bankAccountStatus(bank: Stripe.BankAccount): PayoutDestinationStatus {
  switch (bank.status) {
    case "verified":
      return "verified";
    case "new":
    case "validated":
      return "verifying";
    case "errored":
    case "verification_failed":
    case "tokenized_account_number_deactivated":
      return "errored";
    default:
      return "verifying";
  }
}

/** Maps a card external account to a display row. Never logs or stores the PAN — only last4/brand ever leave Stripe's response. */
function toPayoutDestination(ea: Stripe.ExternalAccount): PayoutDestination | null {
  if (ea.object === "bank_account") {
    return {
      id: ea.id,
      kind: "bank",
      label: ea.bank_name?.trim() || "Bank account",
      last4: ea.last4,
      status: bankAccountStatus(ea),
      default: Boolean(ea.default_for_currency),
    };
  }
  if (ea.object === "card") {
    return {
      id: ea.id,
      kind: "card",
      label: ea.brand?.trim() || "Card",
      last4: ea.last4,
      // A card external account has no verification pipeline of its own —
      // Stripe accepts or rejects it synchronously at attach time, so a card
      // that exists on the account is always usable.
      status: "verified",
      default: Boolean(ea.default_for_currency),
    };
  }
  return null;
}

/** Live list of payout destinations straight from Stripe — never the display cache. Never returns full account/card numbers, only last4. */
export async function listPayoutDestinations(stripe: Stripe, accountId: string): Promise<PayoutDestination[]> {
  const account = await stripe.accounts.retrieve(accountId);
  const externalAccounts = account.external_accounts?.data ?? [];
  const destinations: PayoutDestination[] = [];
  for (const ea of externalAccounts) {
    const destination = toPayoutDestination(ea);
    if (destination) destinations.push(destination);
  }
  return destinations;
}

/**
 * Attaches a bank or card external account from a Stripe.js-created token
 * (`btok_…` / `tok_…`) — the server only ever sees the token id, never a raw
 * account or card number. A credit card is attached and then immediately
 * removed rather than accepted: Instant payouts require a debit card, and
 * leaving a rejected credit card attached would let it silently become the
 * default external account.
 */
export async function addPayoutDestination(
  stripe: Stripe,
  accountId: string,
  opts: { token: string },
): Promise<AddDestinationResult> {
  const token = opts.token?.trim();
  if (!token) return { ok: false, status: 422, error: "Missing card or bank token." };

  let created: Stripe.ExternalAccount;
  try {
    created = await stripe.accounts.createExternalAccount(accountId, { external_account: token });
  } catch (e) {
    return { ok: false, status: 400, error: stripeExternalAccountErrorMessage(e, "stripe-external-accounts add") };
  }

  if (created.object === "card") {
    const funding = created.funding;
    if (funding !== "debit") {
      await stripe.accounts.deleteExternalAccount(accountId, created.id).catch((e) => {
        console.error("[stripe-external-accounts] could not remove rejected credit card", e);
      });
      return { ok: false, status: 422, error: "Add a debit card — credit cards can't receive instant payouts." };
    }
  }

  const destination = toPayoutDestination(created);
  if (!destination) return { ok: false, status: 400, error: "Could not add that account." };
  return { ok: true, destination };
}

/**
 * Creates a Financial Connections Session for the CONNECTED account itself
 * (`account_holder.type: "account"`) — the "Link instantly" flow rendered
 * in-page via Stripe.js's `collectFinancialConnectionsAccounts`, never a new
 * tab. `payment_method` is the only permission requested; balances/ownership
 * are not needed to add a payout destination.
 */
export async function createFinancialConnectionsSession(
  stripe: Stripe,
  accountId: string,
): Promise<{ clientSecret: string; sessionId: string }> {
  const session = await stripe.financialConnections.sessions.create({
    account_holder: { type: "account", account: accountId },
    permissions: ["payment_method"],
    filters: { countries: ["US"] },
  });
  return { clientSecret: session.client_secret ?? "", sessionId: session.id };
}

/**
 * Turns a linked Financial Connections account into a payout external
 * account. Stripe accepts the Financial Connections Account id (`fca_…`)
 * directly as `external_account`, the same call shape as a token — so this
 * reuses {@link addPayoutDestination}'s create/verify-debit/cleanup path.
 */
export async function addFromFinancialConnections(
  stripe: Stripe,
  accountId: string,
  opts: { financialConnectionsAccountId: string },
): Promise<AddDestinationResult> {
  const id = opts.financialConnectionsAccountId?.trim();
  if (!id) return { ok: false, status: 422, error: "Missing linked bank account." };
  return addPayoutDestination(stripe, accountId, { token: id });
}

export async function setDefaultPayoutDestination(
  stripe: Stripe,
  accountId: string,
  destinationId: string,
): Promise<AddDestinationResult> {
  try {
    const updated = await stripe.accounts.updateExternalAccount(accountId, destinationId, {
      default_for_currency: true,
    });
    const destination = toPayoutDestination(updated);
    if (!destination) return { ok: false, status: 400, error: "Could not update that account." };
    return { ok: true, destination };
  } catch (e) {
    return { ok: false, status: 400, error: stripeExternalAccountErrorMessage(e, "stripe-external-accounts default") };
  }
}

/**
 * Removes an external account. Refused (409) when it is the account's ONLY
 * external account and a payout is currently pending or in transit — a
 * payout already claimed against this destination must not lose it mid-flight.
 */
export async function removePayoutDestination(
  stripe: Stripe,
  db: SupabaseClient,
  accountId: string,
  destinationId: string,
): Promise<RemoveDestinationResult> {
  const account = await stripe.accounts.retrieve(accountId);
  const externalAccounts = account.external_accounts?.data ?? [];
  const isOnly = externalAccounts.length <= 1;

  if (isOnly) {
    const { data, error } = await db
      .from("stripe_payouts")
      .select("id")
      .eq("stripe_connect_account_id", accountId)
      .in("status", ["pending", "in_transit"])
      .limit(1);
    if (error) throw new Error(error.message);
    if ((data ?? []).length > 0) {
      return {
        ok: false,
        status: 409,
        error: "Cannot remove your only bank account while a payout is pending.",
      };
    }
  }

  try {
    await stripe.accounts.deleteExternalAccount(accountId, destinationId);
    return { ok: true };
  } catch (e) {
    return { ok: false, status: 400, error: stripeExternalAccountErrorMessage(e, "stripe-external-accounts remove") };
  }
}

/**
 * Micro-deposit verification for a manually-added bank account. Stripe has
 * no typed SDK method for this Connect endpoint in the pinned `stripe`
 * version, so it goes through `rawRequest` — the same authenticated client,
 * just an untyped path (`docs.stripe.com/api/external_account_bank_accounts/verify`).
 */
export async function verifyPayoutDestinationMicroDeposits(
  stripe: Stripe,
  accountId: string,
  destinationId: string,
  amounts: [number, number],
): Promise<AddDestinationResult> {
  try {
    const updated = (await stripe.rawRequest(
      "POST",
      `/v1/accounts/${encodeURIComponent(accountId)}/external_accounts/${encodeURIComponent(destinationId)}/verify`,
      { amounts },
    )) as Stripe.ExternalAccount;
    const destination = toPayoutDestination(updated);
    if (!destination) return { ok: false, status: 400, error: "Could not verify that account." };
    return { ok: true, destination };
  } catch (e) {
    return { ok: false, status: 400, error: stripeExternalAccountErrorMessage(e, "stripe-external-accounts verify") };
  }
}

// ---------------------------------------------------------------------------
// Request-body validation (pure — no Stripe/DB access, testable directly)
// ---------------------------------------------------------------------------

export type ValidateAddBankAccountResult =
  | { ok: true; input: { token: string } }
  | { ok: false; error: string };

export function validateAddBankAccountRequestBody(body: unknown): ValidateAddBankAccountResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request." };
  const token = (body as Record<string, unknown>).token;
  if (typeof token !== "string" || !token.trim()) {
    return { ok: false, error: "Missing card or bank token." };
  }
  return { ok: true, input: { token: token.trim() } };
}

export type ValidateFinancialConnectionsAttachResult =
  | { ok: true; input: { financialConnectionsAccountId: string } }
  | { ok: false; error: string };

export function validateFinancialConnectionsAttachRequestBody(body: unknown): ValidateFinancialConnectionsAttachResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request." };
  const accountId = (body as Record<string, unknown>).accountId;
  if (typeof accountId !== "string" || !accountId.trim()) {
    return { ok: false, error: "Missing linked bank account." };
  }
  return { ok: true, input: { financialConnectionsAccountId: accountId.trim() } };
}

export type ValidateVerifyMicroDepositsResult =
  | { ok: true; input: { amounts: [number, number] } }
  | { ok: false; error: string };

export function validateVerifyMicroDepositsRequestBody(body: unknown): ValidateVerifyMicroDepositsResult {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request." };
  const amounts = (body as Record<string, unknown>).amounts;
  if (!Array.isArray(amounts) || amounts.length !== 2) {
    return { ok: false, error: "Enter both deposit amounts." };
  }
  const [a, b] = amounts.map((v) => Number(v));
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0) {
    return { ok: false, error: "Enter both deposit amounts in cents." };
  }
  return { ok: true, input: { amounts: [a, b] } };
}

// ---------------------------------------------------------------------------
// Display cache (Stripe stays the source; this is read-path-only display data)
// ---------------------------------------------------------------------------

/** Replaces every cached row for this owner. Never stores anything beyond what {@link listPayoutDestinations} already returns (last4/brand/bank name — never full numbers). */
export async function replacePayoutDestinationsCache(
  db: SupabaseClient,
  ownerUserId: string,
  destinations: PayoutDestination[],
): Promise<void> {
  const { error: deleteError } = await db.from("payout_destinations_cache").delete().eq("owner_user_id", ownerUserId);
  if (deleteError) throw new Error(deleteError.message);
  if (destinations.length === 0) return;

  const now = new Date().toISOString();
  const rows = destinations.map((d) => ({
    owner_user_id: ownerUserId,
    stripe_external_account_id: d.id,
    kind: d.kind,
    label: d.label,
    last4: d.last4,
    status: d.status,
    is_default: d.default,
    updated_at: now,
  }));
  const { error: insertError } = await db.from("payout_destinations_cache").insert(rows);
  if (insertError) throw new Error(insertError.message);
}

/** Reads live from Stripe and refreshes the cache in one step — the pattern every route and the webhook handler use after a mutation. */
export async function refreshPayoutDestinationsCacheFromStripe(
  stripe: Stripe,
  db: SupabaseClient,
  ownerUserId: string,
  accountId: string,
): Promise<PayoutDestination[]> {
  const destinations = await listPayoutDestinations(stripe, accountId);
  await replacePayoutDestinationsCache(db, ownerUserId, destinations);
  return destinations;
}
