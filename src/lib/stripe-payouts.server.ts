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
import {
  availableCentsFromHoldAndStripe,
  payoutsAvailableNote,
} from "@/lib/stripe-platform-hold";
import { listPlatformHoldsForOwner, readOwnerPlatformFunds } from "@/lib/stripe-platform-hold.server";

const CURRENCY = "usd";

const MAX_PAYOUT_RECONCILE_ROWS = 1_000;

export type PayoutSnapshot = {
  currency: "usd";
  availableCents: number;
  instantAvailableCents: number;
  pendingCents: number;
  onTheWayCents: number;
  payoutReconciliationPending?: boolean;
  recoveryOutstandingCents?: number;
  recoveryReservedCents?: number;
  heldCents: number;
  releasePendingCents?: number;
  heldDepositCents?: number;
  withdrawableCents: number;
  availableNote: string;
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
    payoutReconciliationPending: false,
    recoveryOutstandingCents: 0,
    recoveryReservedCents: 0,
    heldCents: 0,
    releasePendingCents: 0,
    withdrawableCents: 0,
    availableNote: "",
    bank: null,
    schedule: { interval: "manual", nextPayoutAt: null },
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

/** Stamped provider payouts are on the way; unstamped claims are unknown. */
export async function readPayoutTransit(db: SupabaseClient, ownerUserId: string): Promise<{
  onTheWayCents: number; payoutReconciliationPending: boolean;
}> {
  let onTheWayCents = 0;
  let payoutReconciliationPending = false;
  let offset = 0;
  for (;;) {
    const { data, error } = await db
      .from("stripe_payouts")
      .select("id, amount_cents, fee_cents, method, row_data, stripe_payout_id, initiated_in_app")
      .eq("manager_user_id", ownerUserId)
      .in("status", ["pending", "in_transit"])
      .order("id", { ascending: true })
      .range(offset, offset + 499);
    if (error) throw new Error(error.message);
    if (!data?.length) return { onTheWayCents, payoutReconciliationPending };
    for (const row of data) {
      const payout = row as { id: string; amount_cents: number; fee_cents: number | null;
        method: string | null; row_data: unknown; stripe_payout_id: string | null;
        initiated_in_app: boolean };
      if (!Number.isSafeInteger(payout.amount_cents) || payout.amount_cents <= 0) {
        throw new Error("Pending payout has invalid durable amount.");
      }
      if (!payout.stripe_payout_id) {
        if (!payout.initiated_in_app) throw new Error("Pending payout is missing provider identity.");
        payoutReconciliationPending = true;
      } else {
        const terms = frozenPayoutTerms(payout);
        const bankAmount = payout.initiated_in_app && payout.method === "instant"
          ? terms?.stripeAmountCents ?? (Number.isSafeInteger(payout.fee_cents)
            ? netCentsForPayout(payout.amount_cents, payout.fee_cents!) : NaN)
          : payout.amount_cents;
        if (!Number.isSafeInteger(bankAmount) || bankAmount <= 0) {
          throw new Error("Pending payout has invalid bank amount.");
        }
        onTheWayCents += bankAmount;
      }
    }
    offset += data.length;
  }
}

/** Creditor debt is an obligation, never added to available money. Reserved
 * fresh income is shown separately until exact clearing posts recovered cash. */
export async function readOwnerRecoveryStatus(db: SupabaseClient, ownerUserId: string): Promise<{
  recoveryOutstandingCents: number; recoveryReservedCents: number;
}> {
  const creditors = new Map<string, { outstanding: number; reserved: number }>();
  let offset = 0;
  for (;;) {
    const { data, error } = await db.from("platform_hold_refund_attempts")
      .select("id, funded_debt_cents, recovered_cents")
      .eq("owner_user_id", ownerUserId).eq("status", "succeeded")
      .order("id", { ascending: true }).range(offset, offset + 499);
    if (error) throw new Error("Could not read owner recovery creditors.");
    if (!data?.length) break;
    for (const row of data) {
      const funded = Number(row.funded_debt_cents);
      const recovered = Number(row.recovered_cents);
      if (typeof row.id !== "string" || !Number.isSafeInteger(funded) || funded < 0 ||
          !Number.isSafeInteger(recovered) || recovered < 0 || recovered > funded) {
        throw new Error("Owner recovery creditor has inconsistent durable totals.");
      }
      creditors.set(row.id, { outstanding: funded - recovered, reserved: 0 });
    }
    offset += data.length;
  }
  offset = 0;
  for (;;) {
    const { data, error } = await db.from("platform_source_consumption_legs")
      .select("id, creditor_refund_attempt_id, source_net_cents")
      .eq("owner_user_id", ownerUserId).eq("kind", "owner_debt_recovery")
      .eq("status", "reserved")
      .order("id", { ascending: true }).range(offset, offset + 499);
    if (error) throw new Error("Could not read reserved owner recovery.");
    if (!data?.length) break;
    for (const row of data) {
      const creditor = creditors.get(String(row.creditor_refund_attempt_id ?? ""));
      const reserved = Number(row.source_net_cents);
      if (!creditor || !Number.isSafeInteger(reserved) || reserved <= 0) {
        throw new Error("Owner recovery reservation lacks an exact creditor.");
      }
      creditor.reserved += reserved;
      if (!Number.isSafeInteger(creditor.reserved) || creditor.reserved > creditor.outstanding) {
        throw new Error("Owner recovery reservations exceed outstanding debt.");
      }
    }
    offset += data.length;
  }
  let recoveryOutstandingCents = 0;
  let recoveryReservedCents = 0;
  for (const creditor of creditors.values()) {
    recoveryOutstandingCents += creditor.outstanding;
    recoveryReservedCents += creditor.reserved;
  }
  if (!Number.isSafeInteger(recoveryOutstandingCents) ||
      !Number.isSafeInteger(recoveryReservedCents)) {
    throw new Error("Owner recovery totals exceed safe money range.");
  }
  return { recoveryOutstandingCents, recoveryReservedCents };
}

type PendingClaimRow = {
  id: string;
  manager_user_id: string;
  stripe_payout_id: string | null;
  amount_cents: number;
  fee_cents: number | null;
  method: string | null;
  vendor_user_id: string | null;
  created_at: string;
  row_data?: unknown;
};

type FrozenPayoutTerms = {
  version: 1;
  destinationId: string;
  stripeAmountCents: number;
  originalClaimId?: string;
};

function frozenPayoutTerms(claim: Pick<PendingClaimRow, "row_data">): FrozenPayoutTerms | null {
  const value = claim.row_data;
  if (!value || typeof value !== "object") return null;
  const terms = (value as { inAppPayout?: FrozenPayoutTerms }).inAppPayout;
  return terms?.version === 1 && typeof terms.destinationId === "string" && terms.destinationId.length > 0 &&
    Number.isSafeInteger(terms.stripeAmountCents) && terms.stripeAmountCents > 0 ? terms : null;
}

function payoutMatchesClaim(payout: Stripe.Payout, claim: PendingClaimRow, accountId: string): boolean {
  const terms = frozenPayoutTerms(claim);
  return terms != null && payout.metadata?.proplane_in_app_claim === (terms.originalClaimId ?? claim.id) &&
    payout.metadata?.owner_user_id === claim.manager_user_id &&
    payout.metadata?.stripe_account_id === accountId &&
    payout.amount === terms.stripeAmountCents && payout.currency === CURRENCY &&
    payout.method === methodFromRow(claim.method) && payout.destination === terms.destinationId;
}

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
    .select("amount_cents, fee_cents, method, vendor_user_id, row_data")
    .eq("id", claimId)
    .maybeSingle();
  if (claimReadError) throw new Error(claimReadError.message);
  if (claim) {
    const row = claim as Pick<PendingClaimRow, "amount_cents" | "fee_cents" | "method" | "vendor_user_id" | "row_data">;
    const patch: Record<string, unknown> = {
      initiated_in_app: true,
      amount_cents: row.amount_cents,
      fee_cents: row.fee_cents,
      method: row.method,
      row_data: row.row_data && typeof row.row_data === "object"
        ? { ...row.row_data, inAppPayout: {
            ...(row.row_data as { inAppPayout?: Record<string, unknown> }).inAppPayout,
            originalClaimId: claimId } }
        : row.row_data,
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
 * Only exact claim metadata and frozen destination/amount may adopt an
 * unstamped payout. An older claim without those terms remains for review.
 */
async function findPayoutForUnstampedClaim(
  stripe: Stripe,
  _db: SupabaseClient,
  accountId: string,
  claim: PendingClaimRow,
  method: PayoutMethod,
): Promise<Stripe.Payout | null> {
  void method;
  if (!frozenPayoutTerms(claim)) return null;
  const createdAtSeconds = Math.floor(Date.parse(claim.created_at) / 1000);
  if (!Number.isFinite(createdAtSeconds)) return null;
  let after: string | undefined;
  let scanned = 0;
  let match: Stripe.Payout | null = null;
  for (;;) {
    const page = await stripe.payouts.list({ limit: 100,
      created: { gte: createdAtSeconds - 60 }, ...(after ? { starting_after: after } : {}) },
    { stripeAccount: accountId });
    for (const payout of page.data ?? []) {
      scanned += 1;
      if (payout.metadata?.proplane_in_app_claim !== claim.id) continue;
      if (!payoutMatchesClaim(payout, claim, accountId) || match) {
        throw new Error("Payout claim has conflicting provider evidence.");
      }
      match = payout;
    }
    if (scanned > MAX_PAYOUT_RECONCILE_ROWS || (page.has_more &&
        (!page.data?.length || scanned >= MAX_PAYOUT_RECONCILE_ROWS))) {
      throw new Error("Payout provider history is incomplete.");
    }
    if (!page.has_more) return match;
    after = page.data[page.data.length - 1]?.id;
  }
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
    if (frozenPayoutTerms(claim) && !payoutMatchesClaim(payout, claim, accountId)) {
      throw new Error("Stamped payout no longer matches its frozen claim.");
    }
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
  // Absence in a list cannot prove that Stripe rejected the original create.
  // Keep the claim reserved for exact provider reconciliation/manual review.
}

/**
 * Brings every pending in-app claim for a connected account in line with
 * Stripe's own view of the payout. One in-flight in-app payout per account is
 * the product rule (`stripe_payouts_pending_claim_unique`), and the
 * `payout.*` webhooks normally advance the row — but a webhook that never
 * arrives (local, preview, an endpoint not subscribed for connected
 * accounts) leaves an unstamped claim reserved until exact evidence arrives. Runs before
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
    .select("id, manager_user_id, stripe_payout_id, amount_cents, fee_cents, method, vendor_user_id, created_at, row_data")
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
  const account = await stripe.accounts.retrieve(opts.accountId);
  if (account.id !== opts.accountId || account.metadata?.axis_user_id !== opts.ownerUserId) {
    throw new Error("Saved payout account does not belong to this owner.");
  }
  await reconcilePendingInAppClaims(stripe, db, opts.accountId);
  const [balance, history, transit, recovery] = await Promise.all([
    stripe.balance.retrieve({}, { stripeAccount: opts.accountId }),
    readHistory(db, { ownerUserId: opts.ownerUserId, portal: opts.portal }),
    readPayoutTransit(db, opts.ownerUserId),
    opts.portal === "manager" ? readOwnerRecoveryStatus(db, opts.ownerUserId)
      : Promise.resolve({ recoveryOutstandingCents: 0, recoveryReservedCents: 0 }),
  ]);

  const bank = bankInfoFromAccount(account);
  const setup = resolvePayoutsReadiness(account);

  const schedule = fromStripePayoutSchedule(account.settings?.payouts?.schedule ?? null);
  const stripeAvailableCents = currencyAmount(balance.available, CURRENCY);
  const nextPayoutAt = computeNextPayoutDate(schedule);
  const { heldCents, releasePendingCents } = await readOwnerPlatformFunds(db, opts.ownerUserId);
  const holdHistory = await holdHistoryItems(db, opts.ownerUserId);
  let heldDepositCents = 0;
  if (opts.portal === "manager") {
    const { data: deposits, error: depositError } = await db.from("security_deposit_ledger").select("amount_held_cents").eq("manager_user_id", opts.ownerUserId);
    if (depositError) throw new Error("Could not verify held deposits.");
    heldDepositCents = (deposits ?? []).reduce((sum, row) => sum + Number(row.amount_held_cents ?? 0), 0);
  }
  const bankLabel = bank ? `${bank.bankName ?? "Bank"} ··${bank.last4}` : null;

  return {
    currency: CURRENCY,
    availableCents: availableCentsFromHoldAndStripe(heldCents, stripeAvailableCents),
    instantAvailableCents: currencyAmount(balance.instant_available, CURRENCY),
    pendingCents: currencyAmount(balance.pending, CURRENCY),
    onTheWayCents: transit.onTheWayCents,
    payoutReconciliationPending: transit.payoutReconciliationPending,
    ...recovery,
    heldCents,
    releasePendingCents,
    withdrawableCents: stripeAvailableCents,
    heldDepositCents,
    availableNote: payoutsAvailableNote({ ready: setup.ready, heldCents, bankLabel }),
    bank,
    schedule: { ...schedule, nextPayoutAt },
    setup,
    history: [...holdHistory, ...history],
  };
}

export async function snapshotWithPlatformHolds(
  db: SupabaseClient,
  ownerUserId: string,
  base: PayoutSnapshot = emptyPayoutSnapshot(),
): Promise<PayoutSnapshot> {
  const [{ heldCents, releasePendingCents }, holdHistory, recovery] = await Promise.all([
    readOwnerPlatformFunds(db, ownerUserId), holdHistoryItems(db, ownerUserId),
    readOwnerRecoveryStatus(db, ownerUserId),
  ]);
  return {
    ...base,
    availableCents: availableCentsFromHoldAndStripe(heldCents, base.withdrawableCents),
    heldCents,
    releasePendingCents,
    ...recovery,
    availableNote: payoutsAvailableNote({ ready: base.setup.ready, heldCents }),
    history: [...holdHistory, ...base.history],
  };
}

async function holdHistoryItems(db: SupabaseClient, ownerUserId: string): Promise<PayoutHistoryItem[]> {
  const rows = await listPlatformHoldsForOwner(db, ownerUserId);
  return rows.map((row) => {
    if (!Number.isSafeInteger(row.amountCents) || row.amountCents < 0 ||
        !row.createdAt || !Number.isFinite(Date.parse(row.createdAt))) {
      throw new Error("Held payment history has invalid durable terms.");
    }
    const historicalAmount = row.originalAmountCents == null ? row.amountCents : row.originalAmountCents;
    if (!Number.isSafeInteger(historicalAmount) || historicalAmount < 0 ||
        (row.originalAmountCents != null && historicalAmount <= 0)) {
      throw new Error("Held payment history has invalid original allocation.");
    }
    return ({
    id: `hold:${row.id}`,
    kind: "source_movement" as const,
    amountCents: historicalAmount,
    feeCents: 0,
    netCents: historicalAmount,
    method: null,
    status: row.status === "held" || row.status === "classified_held" ? "pending" : row.status === "refunded" ? "canceled" : "paid",
    destinationLast4: null,
    createdAt: row.createdAt,
    arrivalDate: null,
    initiatedInApp: false,
    failureMessage: null,
    serviceLabel:
      row.status === "transferred"
        ? "Moved from PropLane to Stripe"
        : row.status === "held" || row.status === "classified_held"
          ? row.originalAmountCents == null ? "Remaining source amount" : "Captured source allocation"
          : "Refunded source allocation",
    });
  });
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
  opts: {
    accountId: string;
    ownerUserId: string;
    vendorUserId?: string | null;
    input: CreatePayoutInput;
    /**
     * VENDOR_BANKING_ENABLED: overrides the shared 1%
     * INSTANT_PAYOUT_FEE_BPS with the vendor-specific Instant-withdraw fee
     * (1.5%, $0.50 minimum). Omitted (every manager caller, and the vendor
     * route with the flag off), this keeps using `feeCentsForMethod` exactly
     * as before — byte-for-byte.
     */
    computeFeeCents?: (method: PayoutMethod, amountCents: number) => number;
    /** Cents of the available balance that may NOT be withdrawn (e.g. frozen by an open dispute). Default 0. */
    reservedCents?: number;
  },
): Promise<CreateInAppPayoutResult> {
  const [account, balance] = await Promise.all([
    stripe.accounts.retrieve(opts.accountId),
    stripe.balance.retrieve({}, { stripeAccount: opts.accountId }),
  ]);
  if (account.id !== opts.accountId || account.metadata?.axis_user_id !== opts.ownerUserId) {
    return { ok: false, status: 409, error: "Reconnect your Stripe account before withdrawing." };
  }
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
  }
  const payableDestination = destination ?? setup.destinations.find((item) => item.default) ?? null;
  if (!payableDestination?.payable ||
      (opts.input.method === "instant" &&
        (payableDestination.kind !== "card" || !payableDestination.instantEligible)) ||
      (opts.input.method === "standard" && payableDestination.kind !== "bank")) {
    return { ok: false, status: 422, error: "Choose an eligible payout destination." };
  }

  const reservedCents = Math.max(0, Math.round(opts.reservedCents ?? 0));
  const validation = validatePayoutAgainstBalance(
    opts.input,
    {
      availableCents: Math.max(0, currencyAmount(balance.available, CURRENCY) - reservedCents),
      instantAvailableCents: Math.max(0, currencyAmount(balance.instant_available, CURRENCY) - reservedCents),
      bankInstantEligible: payableDestination.kind === "card" && payableDestination.instantEligible,
    },
    setup,
  );
  if (!validation.ok) return { ok: false, status: 422, error: validation.error };

  const feeCents = (opts.computeFeeCents ?? feeCentsForMethod)(opts.input.method, opts.input.amountCents);
  const stripeAmount = opts.input.method === "instant"
    ? netCentsForPayout(opts.input.amountCents, feeCents) : opts.input.amountCents;
  const frozenDestinationId = payableDestination.id;
  if (!frozenDestinationId) {
    return { ok: false, status: 422, error: "Add a payout destination before withdrawing." };
  }

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
      row_data: { inAppPayout: { version: 1, destinationId: frozenDestinationId,
        stripeAmountCents: stripeAmount } },
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
  try {
    const payout = await stripe.payouts.create(
      {
        amount: stripeAmount,
        currency: CURRENCY,
        method: opts.input.method,
        destination: frozenDestinationId,
        metadata: { proplane_in_app_claim: claimId, owner_user_id: opts.ownerUserId,
          stripe_account_id: opts.accountId },
      },
      { stripeAccount: opts.accountId, idempotencyKey: `in-app-payout:${claimId}` },
    );
    if (!payoutMatchesClaim(payout, {
      id: claimId, manager_user_id: opts.ownerUserId, stripe_payout_id: null,
      amount_cents: opts.input.amountCents, fee_cents: feeCents,
      method: opts.input.method, vendor_user_id: opts.vendorUserId ?? null,
      created_at: new Date().toISOString(),
      row_data: { inAppPayout: { version: 1, destinationId: frozenDestinationId,
        stripeAmountCents: stripeAmount } },
    }, opts.accountId)) {
      throw new Error("Stripe payout did not match the frozen claim.");
    }

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
    console.error(`[stripe-payouts] payout create outcome unknown for ${claimId}`, error);
    return { ok: false, status: 409,
      error: "Payout is being reconciled. Check its status before trying again." };
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
