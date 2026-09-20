import "server-only";

import { NextResponse } from "next/server";
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeNextPayoutDate,
  estimateArrivalDate,
  feeCentsForMethod,
  fromStripePayoutSchedule,
  matchServiceLabelForPayout,
  netCentsForPayout,
  normalizePayoutHistoryRow,
  normalizePayoutStatus,
  toStripePayoutSchedule,
  validatePayoutAgainstBalance,
  type CreatePayoutInput,
  type PayoutBankInfo,
  type PayoutHistoryItem,
  type PayoutMethod,
  type PayoutSchedule,
  type PayoutScheduleWithNext,
  type PayoutSetupState,
  type StripePayoutDbRow,
  type VendorPayoutCandidate,
} from "@/lib/stripe-payouts";
import { resolvePayoutsReadiness } from "@/lib/stripe-payouts-readiness.server";

const CURRENCY = "usd";

/**
 * How long an in-app claim that never received a Stripe payout id is given
 * before reconciliation writes it off as failed. A claim only lacks the id
 * when the process died between `stripe.payouts.create` and the stamp, or
 * the stamp itself failed twice — either way, a payout Stripe did create is
 * found by `findPayoutForUnstampedClaim` first, so only a genuinely
 * unconfirmed claim ever ages out.
 */
const UNCONFIRMED_CLAIM_GRACE_MS = 15 * 60 * 1000;

export type PayoutSnapshot = {
  currency: "usd";
  availableCents: number;
  instantAvailableCents: number;
  pendingCents: number;
  onTheWayCents: number;
  bank: PayoutBankInfo | null;
  schedule: PayoutScheduleWithNext;
  setup: PayoutSetupState;
  history: PayoutHistoryItem[];
};

export function emptyPayoutSnapshot(): PayoutSnapshot {
  return {
    currency: CURRENCY,
    availableCents: 0,
    instantAvailableCents: 0,
    pendingCents: 0,
    onTheWayCents: 0,
    bank: null,
    schedule: { interval: "weekly", weeklyAnchor: "friday", nextPayoutAt: null },
    setup: { identity: "needed", bank: "needed", ready: false },
    history: [],
  };
}

function currencyAmount(rows: Array<{ amount: number; currency: string }> | undefined, currency: string): number {
  return rows?.find((r) => r.currency === currency)?.amount ?? 0;
}

/** Picks the bank account payouts should describe: default-for-currency first, else the first bank account. */
function selectPrimaryBankAccount(account: Stripe.Account): Stripe.BankAccount | null {
  const externalAccounts = account.external_accounts?.data ?? [];
  const bankAccounts = externalAccounts.filter(
    (ea): ea is Stripe.BankAccount => ea.object === "bank_account",
  );
  if (bankAccounts.length === 0) return null;
  return bankAccounts.find((b) => b.default_for_currency) ?? bankAccounts[0]!;
}

function bankInfoFromAccount(account: Stripe.Account): PayoutBankInfo | null {
  const bank = selectPrimaryBankAccount(account);
  if (!bank) return null;
  const accountType = bank.account_type === "checking" || bank.account_type === "savings" ? bank.account_type : null;
  return {
    last4: bank.last4,
    bankName: bank.bank_name ?? null,
    accountType,
    instantEligible: Array.isArray(bank.available_payout_methods)
      ? bank.available_payout_methods.includes("instant")
      : false,
    // Stripe's BankAccount object does not expose a "verified since" timestamp;
    // reporting a fabricated date would be worse than omitting it.
    verifiedAt: null,
  };
}

/**
 * Fetches the last 50 payouts for this connect account plus, for a vendor
 * portal read, a best-effort service label per row (see
 * `matchServiceLabelForPayout`).
 */
async function readHistory(
  db: SupabaseClient,
  opts: { ownerUserId: string; portal: "manager" | "vendor" },
): Promise<PayoutHistoryItem[]> {
  const { data, error } = await db
    .from("stripe_payouts")
    .select(
      "id, amount_cents, fee_cents, method, status, destination_last4, created_at, arrival_date, initiated_in_app, failure_message",
    )
    .eq("manager_user_id", opts.ownerUserId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as StripePayoutDbRow[];

  if (opts.portal !== "vendor" || rows.length === 0) {
    return rows.map((row) => normalizePayoutHistoryRow(row));
  }

  const { data: vendorPayouts } = await db
    .from("vendor_payouts")
    .select("work_order_id, amount_cents, updated_at")
    .eq("vendor_user_id", opts.ownerUserId)
    .eq("status", "paid")
    .limit(200);

  const workOrderIds = [...new Set((vendorPayouts ?? []).map((r) => String(r.work_order_id)))];
  const labelByWorkOrderId = new Map<string, string | null>();
  if (workOrderIds.length > 0) {
    const { data: workOrders } = await db
      .from("portal_work_order_records")
      .select("id, row_data")
      .in("id", workOrderIds);
    for (const wo of workOrders ?? []) {
      const rowData = (wo as { row_data?: { title?: string; propertyName?: string } }).row_data;
      const title = rowData?.title?.trim();
      const property = rowData?.propertyName?.trim();
      const label = [property, title].filter(Boolean).join(" · ") || title || null;
      labelByWorkOrderId.set(String((wo as { id: string }).id), label);
    }
  }

  const candidates: VendorPayoutCandidate[] = (vendorPayouts ?? []).map((r) => ({
    workOrderId: String(r.work_order_id),
    amountCents: Number(r.amount_cents) || 0,
    updatedAt: String(r.updated_at),
    label: labelByWorkOrderId.get(String(r.work_order_id)) ?? null,
  }));

  return rows.map((row) => {
    const serviceLabel = matchServiceLabelForPayout(
      { amountCents: Number(row.amount_cents) || 0, createdAt: row.created_at },
      candidates,
    );
    return normalizePayoutHistoryRow(row, { serviceLabel });
  });
}

/** Sum of `stripe_payouts` rows already sent to the bank but not yet arrived ("On the way"). */
async function readOnTheWayCents(db: SupabaseClient, ownerUserId: string): Promise<number> {
  const { data, error } = await db
    .from("stripe_payouts")
    .select("amount_cents")
    .eq("manager_user_id", ownerUserId)
    .in("status", ["pending", "in_transit"]);
  if (error) throw new Error(error.message);
  return (data ?? []).reduce((sum, row) => sum + (Number((row as { amount_cents: number }).amount_cents) || 0), 0);
}

type PendingClaimRow = {
  id: string;
  stripe_payout_id: string | null;
  amount_cents: number;
  fee_cents: number | null;
  method: string | null;
  vendor_user_id: string | null;
  created_at: string;
};

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === "23505") return true;
  return /duplicate key|unique constraint|stripe_payouts_stripe_id_unique/i.test(error.message ?? "");
}

function methodFromRow(method: string | null | undefined): PayoutMethod {
  return method === "instant" ? "instant" : "standard";
}

function arrivalDateForPayout(payout: Stripe.Payout, method: PayoutMethod): string | null {
  return payout.arrival_date
    ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
    : estimateArrivalDate(method);
}

function payoutStatusPatch(payout: Stripe.Payout, method: PayoutMethod) {
  return {
    stripe_payout_id: payout.id,
    status: normalizePayoutStatus(payout.status ?? "pending", payout.failure_code),
    arrival_date: arrivalDateForPayout(payout, method),
    failure_message: payout.failure_message ?? null,
    updated_at: new Date().toISOString(),
  };
}

/**
 * The `payout.created` webhook beat the stamp and already inserted its own
 * row for this Stripe payout (`stripe_payouts_stripe_id_unique`). The claim's
 * own facts — gross amount, fee, method, vendor — move onto that row, which
 * becomes the in-app row, and the claim is deleted so the pending-claim
 * index never holds a row nothing can advance.
 */
async function mergeClaimIntoWebhookRow(db: SupabaseClient, claimId: string, payoutId: string): Promise<void> {
  const { data: claim, error: claimReadError } = await db
    .from("stripe_payouts")
    .select("amount_cents, fee_cents, method, vendor_user_id")
    .eq("id", claimId)
    .maybeSingle();
  if (claimReadError) throw new Error(claimReadError.message);
  if (claim) {
    const row = claim as Pick<PendingClaimRow, "amount_cents" | "fee_cents" | "method" | "vendor_user_id">;
    const patch: Record<string, unknown> = {
      initiated_in_app: true,
      amount_cents: row.amount_cents,
      fee_cents: row.fee_cents,
      method: row.method,
      updated_at: new Date().toISOString(),
    };
    if (row.vendor_user_id) patch.vendor_user_id = row.vendor_user_id;
    const { error: mergeError } = await db.from("stripe_payouts").update(patch).eq("stripe_payout_id", payoutId);
    if (mergeError) throw new Error(mergeError.message);
  }
  const { error: deleteError } = await db.from("stripe_payouts").delete().eq("id", claimId);
  if (deleteError) throw new Error(deleteError.message);
}

/**
 * Stamps the Stripe payout onto the claim row. A unique-index collision with
 * a webhook-inserted row merges onto that row instead; any other failure is
 * retried once and then thrown so the caller can log it — never swallowed.
 */
async function stampClaimWithPayout(
  db: SupabaseClient,
  opts: { claimId: string; payout: Stripe.Payout; method: PayoutMethod },
): Promise<void> {
  const patch = payoutStatusPatch(opts.payout, opts.method);
  const attempt = () => db.from("stripe_payouts").update(patch).eq("id", opts.claimId);
  let { error } = await attempt();
  if (error && !isUniqueViolation(error)) ({ error } = await attempt());
  if (!error) return;
  if (isUniqueViolation(error)) {
    await mergeClaimIntoWebhookRow(db, opts.claimId, opts.payout.id);
    return;
  }
  throw new Error(error.message);
}

/**
 * For a claim that never got its Stripe id: the payout Stripe created for it,
 * if any — matched on the connected account by creation time, method and the
 * exact amount sent to Stripe, skipping ids another in-app row already holds.
 */
async function findPayoutForUnstampedClaim(
  stripe: Stripe,
  db: SupabaseClient,
  accountId: string,
  claim: PendingClaimRow,
  method: PayoutMethod,
): Promise<Stripe.Payout | null> {
  const createdAtSeconds = Math.floor(Date.parse(claim.created_at) / 1000);
  if (!Number.isFinite(createdAtSeconds)) return null;
  const feeCents = claim.fee_cents ?? feeCentsForMethod(method, claim.amount_cents);
  const expectedAmount = method === "instant" ? netCentsForPayout(claim.amount_cents, feeCents) : claim.amount_cents;
  const list = await stripe.payouts.list(
    { limit: 25, created: { gte: createdAtSeconds - 60 } },
    { stripeAccount: accountId },
  );
  const candidates = (list.data ?? []).filter((p) => p.amount === expectedAmount && p.method === method);
  if (candidates.length === 0) return null;
  const { data: claimedRows } = await db
    .from("stripe_payouts")
    .select("stripe_payout_id")
    .in(
      "stripe_payout_id",
      candidates.map((p) => p.id),
    )
    .eq("initiated_in_app", true);
  const taken = new Set((claimedRows ?? []).map((r) => String((r as { stripe_payout_id: string }).stripe_payout_id)));
  return candidates.find((p) => !taken.has(p.id)) ?? null;
}

async function reconcileClaim(
  stripe: Stripe,
  db: SupabaseClient,
  accountId: string,
  claim: PendingClaimRow,
): Promise<void> {
  const method = methodFromRow(claim.method);
  if (claim.stripe_payout_id) {
    const payout = await stripe.payouts.retrieve(claim.stripe_payout_id, {}, { stripeAccount: accountId });
    const patch = payoutStatusPatch(payout, method);
    if (patch.status === "pending") return;
    const { error } = await db.from("stripe_payouts").update(patch).eq("id", claim.id);
    if (error) throw new Error(error.message);
    return;
  }

  const payout = await findPayoutForUnstampedClaim(stripe, db, accountId, claim, method);
  if (payout) {
    await stampClaimWithPayout(db, { claimId: claim.id, payout, method });
    return;
  }
  const ageMs = Date.now() - Date.parse(claim.created_at);
  if (!Number.isFinite(ageMs) || ageMs < UNCONFIRMED_CLAIM_GRACE_MS) return;
  const { error } = await db
    .from("stripe_payouts")
    .update({
      status: "failed",
      failure_message: "Stripe never confirmed this payout.",
      updated_at: new Date().toISOString(),
    })
    .eq("id", claim.id);
  if (error) throw new Error(error.message);
}

/**
 * Brings every pending in-app claim for a connected account in line with
 * Stripe's own view of the payout. One in-flight in-app payout per account is
 * the product rule (`stripe_payouts_pending_claim_unique`), and the
 * `payout.*` webhooks normally advance the row — but a webhook that never
 * arrives (local, preview, an endpoint not subscribed for connected
 * accounts) must not leave that index blocking Pay out forever. Runs before
 * every snapshot read and every new payout attempt. Each claim is handled on
 * its own; a failure is logged and never blocks the read or the payout.
 */
export async function reconcilePendingInAppClaims(
  stripe: Stripe,
  db: SupabaseClient,
  accountId: string,
): Promise<void> {
  const { data, error } = await db
    .from("stripe_payouts")
    .select("id, stripe_payout_id, amount_cents, fee_cents, method, vendor_user_id, created_at")
    .eq("stripe_connect_account_id", accountId)
    .eq("status", "pending")
    .eq("initiated_in_app", true);
  if (error) {
    console.error(`[stripe-payouts] could not read pending claims for ${accountId}: ${error.message}`);
    return;
  }
  for (const claim of (data ?? []) as PendingClaimRow[]) {
    try {
      await reconcileClaim(stripe, db, accountId, claim);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`[stripe-payouts] could not reconcile claim ${claim.id} for ${accountId}: ${message}`);
    }
  }
}

export async function readPayoutSnapshot(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { accountId: string; ownerUserId: string; portal: "manager" | "vendor" },
): Promise<PayoutSnapshot> {
  await reconcilePendingInAppClaims(stripe, db, opts.accountId);
  const [account, balance, history, onTheWayCents] = await Promise.all([
    stripe.accounts.retrieve(opts.accountId),
    stripe.balance.retrieve({}, { stripeAccount: opts.accountId }),
    readHistory(db, { ownerUserId: opts.ownerUserId, portal: opts.portal }),
    readOnTheWayCents(db, opts.ownerUserId),
  ]);

  const bank = bankInfoFromAccount(account);
  const setup = resolvePayoutsReadiness(account);

  const schedule = fromStripePayoutSchedule(account.settings?.payouts?.schedule ?? null);
  const availableCents = currencyAmount(balance.available, CURRENCY);
  const nextPayoutAt = computeNextPayoutDate(schedule);

  return {
    currency: CURRENCY,
    availableCents,
    instantAvailableCents: currencyAmount(balance.instant_available, CURRENCY),
    pendingCents: currencyAmount(balance.pending, CURRENCY),
    onTheWayCents,
    bank,
    schedule: { ...schedule, nextPayoutAt },
    setup,
    history,
  };
}

export type CreateInAppPayoutResult =
  | { ok: true; payoutId: string; amountCents: number; feeCents: number; netCents: number; arrivalDate: string | null; method: PayoutMethod }
  | { ok: false; status: 422 | 409 | 400 | 500; error: string };

/**
 * Idempotent, claim-before-call create — the same pattern as
 * `payoutVendorForWorkOrder` (`src/lib/stripe-vendor-payout.ts`): a pending
 * `stripe_payouts` row is written BEFORE Stripe is ever called, and a partial
 * unique index (`stripe_payouts_pending_claim_unique`, migration
 * `20260920200000_in_app_payouts.sql`) on
 * `(stripe_connect_account_id) WHERE status = 'pending' AND initiated_in_app`
 * makes a second concurrent/duplicate click lose the insert race — that
 * becomes the 409. The client's amount is re-checked against a FRESH balance
 * read, never trusted from the request alone.
 */
export async function createInAppPayout(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { accountId: string; ownerUserId: string; vendorUserId?: string | null; input: CreatePayoutInput },
): Promise<CreateInAppPayoutResult> {
  const [account, balance] = await Promise.all([
    stripe.accounts.retrieve(opts.accountId),
    stripe.balance.retrieve({}, { stripeAccount: opts.accountId }),
  ]);
  const bank = bankInfoFromAccount(account);
  const setup = resolvePayoutsReadiness(account);

  // A `destinationId` names a specific external account/card off THIS
  // account's own live destination list — never trusted as-is. Omitted, the
  // payout goes to the account's default external account (unchanged
  // behavior). Instant specifically needs a debit CARD destination (the
  // Withdraw sheet's own "needs a debit card" copy); a bank account's own
  // `instant_available_payout_methods` is the fallback signal only for the
  // no-destination (default-account) path below.
  let destination: (typeof setup.destinations)[number] | null = null;
  if (opts.input.destinationId) {
    destination = setup.destinations.find((d) => d.id === opts.input.destinationId) ?? null;
    if (!destination) {
      return { ok: false, status: 400, error: "That destination is not on this account." };
    }
    if (opts.input.method === "instant" && destination.kind !== "card") {
      return { ok: false, status: 400, error: "Instant payouts need a debit card destination." };
    }
  }

  const validation = validatePayoutAgainstBalance(
    opts.input,
    {
      availableCents: currencyAmount(balance.available, CURRENCY),
      instantAvailableCents: currencyAmount(balance.instant_available, CURRENCY),
      bankInstantEligible: destination ? destination.kind === "card" : (bank?.instantEligible ?? false),
    },
    setup,
  );
  if (!validation.ok) return { ok: false, status: 422, error: validation.error };

  const feeCents = feeCentsForMethod(opts.input.method, opts.input.amountCents);

  await reconcilePendingInAppClaims(stripe, db, opts.accountId);

  const { data: claimed, error: claimError } = await db
    .from("stripe_payouts")
    .insert({
      manager_user_id: opts.ownerUserId,
      vendor_user_id: opts.vendorUserId ?? null,
      stripe_connect_account_id: opts.accountId,
      amount_cents: opts.input.amountCents,
      fee_cents: feeCents,
      method: opts.input.method,
      currency: CURRENCY,
      status: "pending",
      initiated_in_app: true,
      row_data: {},
    })
    .select("id")
    .maybeSingle();

  if (claimError || !claimed) {
    // Unique-index conflict on the partial index = a payout is already in flight.
    // Anything else (outage, grant, schema drift) is an infrastructure failure,
    // not a pending payout, and must not be reported to the manager as one.
    if (isUniqueViolation(claimError)) {
      return { ok: false, status: 409, error: "A payout is already in progress for this account." };
    }
    console.error(
      `[stripe-payouts] could not claim a payout row for ${opts.accountId}: ${claimError?.message ?? "no row returned"}`,
    );
    return { ok: false, status: 500, error: "Could not start the payout. Try again in a moment." };
  }
  const claimId = (claimed as { id: string }).id;

  // For Instant, Stripe assesses its 1% fee as a SEPARATE debit from the
  // connected account's own balance on top of whatever `amount` is requested
  // (docs.stripe.com/connect/instant-payouts) — it is not subtracted from the
  // payout `amount` itself. To make "Bank receives $X" true (net of fee), we
  // request the NET amount as the Stripe payout `amount`; the gross
  // `amountCents` the user typed is what `validatePayoutAgainstBalance`
  // already checked against `instant_available`, so the balance has room for
  // both the net transfer and Stripe's fee. Standard has no fee, so gross ==
  // net and this is a no-op there.
  const stripeAmount =
    opts.input.method === "instant" ? netCentsForPayout(opts.input.amountCents, feeCents) : opts.input.amountCents;

  try {
    const payout = await stripe.payouts.create(
      {
        amount: stripeAmount,
        currency: CURRENCY,
        method: opts.input.method,
        ...(destination ? { destination: destination.id } : {}),
      },
      { stripeAccount: opts.accountId, idempotencyKey: `in-app-payout:${claimId}` },
    );

    const arrivalDate = arrivalDateForPayout(payout, opts.input.method);

    try {
      await stampClaimWithPayout(db, { claimId, payout, method: opts.input.method });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(
        `[stripe-payouts] claim ${claimId} for ${opts.accountId} could not be stamped with ${payout.id} — reconciliation will retry: ${message}`,
      );
    }

    return {
      ok: true,
      payoutId: payout.id,
      amountCents: opts.input.amountCents,
      feeCents,
      netCents: netCentsForPayout(opts.input.amountCents, feeCents),
      arrivalDate,
      method: opts.input.method,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stripe payout failed.";
    // Frees the partial-unique-index slot (status is no longer 'pending') so a
    // retry after a transient Stripe failure is not permanently blocked.
    await db
      .from("stripe_payouts")
      .update({ status: "failed", failure_message: message, updated_at: new Date().toISOString() })
      .eq("id", claimId);
    return { ok: false, status: 400, error: message };
  }
}

export async function writePayoutSchedule(
  stripe: Stripe,
  opts: { accountId: string; schedule: PayoutSchedule },
): Promise<PayoutScheduleWithNext> {
  const account = await stripe.accounts.update(opts.accountId, {
    settings: {
      payouts: {
        schedule: toStripePayoutSchedule(opts.schedule) as Stripe.AccountUpdateParams.Settings.Payouts.Schedule,
      },
    },
  });
  const schedule = fromStripePayoutSchedule(account.settings?.payouts?.schedule ?? null);
  return { ...schedule, nextPayoutAt: computeNextPayoutDate(schedule) };
}

/**
 * Security-review follow-up: a caught Stripe (or other library) error's OWN
 * message must never reach the client. Stripe's account-access error embeds
 * the Connect account id verbatim ("This API key does not have access to
 * account acct_123... (or that account does not exist)."), and other thrown
 * errors can carry equally internal detail — neither belongs in a payout
 * response body. Log the real message server-side (still diagnosable from
 * logs) and answer with one generic message instead.
 *
 * This is only for the UNEXPECTED-error fallback in a route's catch block.
 * It is never the right call for a validation failure — those already carry
 * our own crafted message (`validateCreatePayoutRequestBody`,
 * `validateScheduleRequestBody`, `STRIPE_NOT_CONFIGURED`, the payout-owner
 * resolution errors, etc.) and must keep returning that message verbatim, at
 * their own status code, without going through this helper.
 */
export function stripePayoutErrorResponse(context: string, e: unknown): NextResponse {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[${context}]`, message);
  return NextResponse.json({ error: "Something went wrong processing that request. Please try again." }, { status: 500 });
}
