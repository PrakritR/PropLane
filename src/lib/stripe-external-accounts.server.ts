import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isStripeConnectAccountAccessError } from "@/lib/stripe-connect";

export type PayoutDestinationKind = "bank" | "card";
export type PayoutDestinationStatus = "new" | "validated" | "verified" | "errored" | "unknown";

export type PayoutDestination = {
  id: string;
  kind: PayoutDestinationKind;
  /** Bank name (e.g. "Chase") for a bank account, or card brand (e.g. "Visa") for a card. */
  label: string;
  last4: string;
  status: PayoutDestinationStatus;
  payable: boolean;
  instantEligible: boolean;
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
 * Maps Stripe's actual external-account state without claiming verification.
 * Documented values for an EXTERNAL (Connect) bank account are `new`,
 * `errored`, `verification_failed`, `tokenized_account_number_deactivated`
 * (the `validated`/`verified` states describe a CUSTOMER-owned bank account) —
 * this still maps the fuller set defensively since Stripe's own typing
 * leaves `status` as a bare `string`. An unrecognized future value fails
 * closed to unknown rather than claiming verification.
 */
function bankAccountStatus(bank: Stripe.BankAccount): PayoutDestinationStatus {
  switch (bank.status) {
    case "verified":
      return "verified";
    case "new":
      return "new";
    case "validated":
      return "validated";
    case "errored":
    case "verification_failed":
    case "tokenized_account_number_deactivated":
      return "errored";
    default:
      return "unknown";
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
      payable: ["new", "validated", "verified"].includes(bankAccountStatus(ea)),
      instantEligible: Array.isArray(ea.available_payout_methods) &&
        ea.available_payout_methods.includes("instant"),
      default: Boolean(ea.default_for_currency),
    };
  }
  if (ea.object === "card") {
    return {
      id: ea.id,
      kind: "card",
      label: ea.brand?.trim() || "Card",
      last4: ea.last4,
      status: ea.funding === "debit" ? "verified" : "unknown",
      payable: ea.funding === "debit" && Array.isArray(ea.available_payout_methods) &&
        ea.available_payout_methods.includes("instant"),
      instantEligible: ea.funding === "debit" && Array.isArray(ea.available_payout_methods) &&
        ea.available_payout_methods.includes("instant"),
      default: Boolean(ea.default_for_currency),
    };
  }
  return null;
}

/**
 * Destinations off an `Account` object already in hand — no Stripe call.
 * Default-for-currency sorts first (the Withdraw sheet's "To" picker and the
 * Bank accounts list both want the default account on top); ties keep
 * Stripe's own order. Shared by {@link listPayoutDestinations} and
 * `stripe-payouts-readiness.server.ts`, which already has the account from
 * its own balance/create read and would otherwise pay for a second
 * `accounts.retrieve`.
 */
export function payoutDestinationsFromAccount(account: Stripe.Account): PayoutDestination[] {
  const externalAccounts = account.external_accounts?.data ?? [];
  const destinations: PayoutDestination[] = [];
  for (const ea of externalAccounts) {
    const destination = toPayoutDestination(ea);
    if (destination) destinations.push(destination);
  }
  return destinations.sort((a, b) => Number(b.default) - Number(a.default));
}

/** Live list of payout destinations straight from Stripe — never the display cache. Never returns full account/card numbers, only last4. */
export async function listPayoutDestinations(stripe: Stripe, accountId: string): Promise<PayoutDestination[]> {
  const account = await stripe.accounts.retrieve(accountId);
  return payoutDestinationsFromAccount(account);
}

/** Saved Connect id is a pointer, not ownership authority. */
export async function assertOwnedPayoutAccount(stripe: Stripe, accountId: string,
  ownerUserId: string): Promise<Stripe.Account> {
  const account = await stripe.accounts.retrieve(accountId);
  if (account.id !== accountId || account.metadata?.axis_user_id !== ownerUserId) {
    throw new Error("Saved payout account does not belong to this owner.");
  }
  return account;
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

export const REMOVE_DEFAULT_REFUSAL = "Make another account the default before removing this one.";

/**
 * `null` when removal may proceed; otherwise the refusal text. The default
 * external account can only be removed when it is the only one left.
 */
export function removeDefaultRefusal(
  externalAccounts: ReadonlyArray<{ id: string; default_for_currency?: boolean | null }>,
  destinationId: string,
): string | null {
  const target = externalAccounts.find((ea) => ea.id === destinationId);
  if (!target?.default_for_currency) return null;
  return externalAccounts.some((ea) => ea.id !== destinationId) ? REMOVE_DEFAULT_REFUSAL : null;
}

/**
 * Removes an external account. Refused (409) when it is the default and others
 * exist, or when it is the account's ONLY external account and a payout is
 * currently pending or in transit — a payout already claimed against this destination must not lose it mid-flight.
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

  // The default is where every automatic payout goes — it cannot be removed
  // while another destination exists (make another one the default first).
  // Re-derived here from Stripe's own list, never from the client.
  const refusal = removeDefaultRefusal(externalAccounts, destinationId);
  if (refusal) return { ok: false, status: 409, error: refusal };

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
  _stripe: Stripe,
  _accountId: string,
  _destinationId: string,
  _amounts: [number, number],
): Promise<AddDestinationResult> {
  return { ok: false, status: 400,
    error: "This payout bank account does not use in-app microdeposit verification." };
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

async function beginPayoutDestinationsCacheRefresh(db: SupabaseClient, ownerUserId: string): Promise<number> {
  const { data, error } = await db.rpc("begin_payout_destination_cache_refresh", { p_owner_user_id: ownerUserId });
  if (error || !Number.isSafeInteger(data) || Number(data) <= 0) {
    throw new Error(error?.message ?? "Could not begin payout destination refresh.");
  }
  return Number(data);
}

/** Atomically replaces this owner's display rows, provided a newer Stripe
 * read has not already been applied. Nothing beyond last4 and bank/card label
 * is stored. */
export async function replacePayoutDestinationsCache(
  db: SupabaseClient,
  ownerUserId: string,
  connectAccountId: string,
  destinations: PayoutDestination[],
  version?: number,
): Promise<void> {
  const token = version ?? await beginPayoutDestinationsCacheRefresh(db, ownerUserId);
  const rows = destinations.map((d) => ({
    id: d.id,
    kind: d.kind,
    label: d.label,
    last4: d.last4,
    // The retained display cache predates live payable/status fields. Keep
    // its existing SQL enum while the live route carries exact Stripe state.
    status: d.status === "verified" ? "verified"
      : d.status === "new" || d.status === "validated" ? "verifying" : "errored",
    is_default: d.default,
  }));
  const { error } = await db.rpc("finish_payout_destination_cache_refresh", {
    p_owner_user_id: ownerUserId, p_connect_account_id: connectAccountId,
    p_version: token, p_destinations: rows,
  });
  if (error) throw new Error(error.message);
}

/** Reads live from Stripe and refreshes the cache in one step — the pattern every route and the webhook handler use after a mutation. */
export async function refreshPayoutDestinationsCacheFromStripe(
  stripe: Stripe,
  db: SupabaseClient,
  ownerUserId: string,
  accountId: string,
): Promise<PayoutDestination[]> {
  const version = await beginPayoutDestinationsCacheRefresh(db, ownerUserId);
  const account = await assertOwnedPayoutAccount(stripe, accountId, ownerUserId);
  const destinations = payoutDestinationsFromAccount(account);
  await replacePayoutDestinationsCache(db, ownerUserId, accountId, destinations, version);
  return destinations;
}
