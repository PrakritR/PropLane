import "server-only";

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
  resolveSetupState,
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

const CURRENCY = "usd";

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

function requirementList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
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

export async function readPayoutSnapshot(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { accountId: string; ownerUserId: string; portal: "manager" | "vendor" },
): Promise<PayoutSnapshot> {
  const [account, balance, history, onTheWayCents] = await Promise.all([
    stripe.accounts.retrieve(opts.accountId),
    stripe.balance.retrieve({}, { stripeAccount: opts.accountId }),
    readHistory(db, { ownerUserId: opts.ownerUserId, portal: opts.portal }),
    readOnTheWayCents(db, opts.ownerUserId),
  ]);

  const bank = bankInfoFromAccount(account);
  const setup = resolveSetupState({
    detailsSubmitted: Boolean(account.details_submitted),
    currentlyDue: requirementList(account.requirements?.currently_due),
    pendingVerification: requirementList(account.requirements?.pending_verification),
    hasExternalAccount: bank !== null,
  });

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
  | { ok: false; status: 422 | 409 | 400; error: string };

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
  const setup = resolveSetupState({
    detailsSubmitted: Boolean(account.details_submitted),
    currentlyDue: requirementList(account.requirements?.currently_due),
    pendingVerification: requirementList(account.requirements?.pending_verification),
    hasExternalAccount: bank !== null,
  });

  const validation = validatePayoutAgainstBalance(
    opts.input,
    {
      availableCents: currencyAmount(balance.available, CURRENCY),
      instantAvailableCents: currencyAmount(balance.instant_available, CURRENCY),
      bankInstantEligible: bank?.instantEligible ?? false,
    },
    setup,
  );
  if (!validation.ok) return { ok: false, status: 422, error: validation.error };

  const feeCents = feeCentsForMethod(opts.input.method, opts.input.amountCents);

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
    return { ok: false, status: 409, error: "A payout is already in progress for this account." };
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
      { amount: stripeAmount, currency: CURRENCY, method: opts.input.method },
      { stripeAccount: opts.accountId, idempotencyKey: `in-app-payout:${claimId}` },
    );

    const arrivalDate = payout.arrival_date
      ? new Date(payout.arrival_date * 1000).toISOString().slice(0, 10)
      : estimateArrivalDate(opts.input.method);

    // Best-effort: if the `payout.created` webhook races this and inserts its
    // own row for `payout.id` first, this update can lose to the unique index
    // on `stripe_payout_id`. That is a rare timing window (the webhook would
    // have to beat this synchronous continuation), and either way the caller
    // already has the correct amount/fee/net from this response — a lost
    // write here is a stale duplicate history row, not a wrong payment.
    await db
      .from("stripe_payouts")
      .update({
        stripe_payout_id: payout.id,
        status: payout.status ?? "pending",
        arrival_date: arrivalDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", claimId)
      .then(
        () => undefined,
        () => undefined,
      );

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
