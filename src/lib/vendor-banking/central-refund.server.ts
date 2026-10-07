import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { runReservedPlatformMoneyRefund } from "@/lib/platform-money-refund.server";
import { PROPLANE_SERVICE_FEE_LABEL } from "@/lib/platform-fees";
import { postGlVendorRefundReversal } from "@/lib/reports/gl-posting";
import { resolveManagerConnectAccountId } from "@/lib/stripe-connect";
import { readVendorFrozenDisputeCents } from "@/lib/vendor-banking/disputes.server";
import { emitVendorBankingEvent } from "@/lib/vendor-banking/events.server";
import { recordVendorBankingLedgerEntry } from "@/lib/vendor-banking/ledger.server";
import { getVendorBankingPayoutForVendor } from "@/lib/vendor-banking/payouts.server";
import { recordVendorServiceFeeRevenueReversal } from "@/lib/vendor-banking/platform-revenue.server";
import {
  VENDOR_REFUND_REFUSAL_COPY,
  computeVendorRefundCap,
  refundFeeShareCents,
  refundNetDebitCents,
  remainingRefundableGrossCents,
  vendorRefundAttemptKey,
  type RecoverableFunds,
} from "@/lib/vendor-banking/refund-cap";
import { refundVendorPayout } from "@/lib/vendor-banking/refund.server";

export type VendorRefundSubmitResult =
  | {
      ok: true;
      status: "succeeded" | "pending";
      requestId: string;
      grossCents: number;
      feeShareCents: number;
      netDebitCents: number;
      replay: boolean;
    }
  | { ok: false; status: 400 | 404 | 409 | 422; code?: string; error: string };

type RefundRequestRow = {
  id: string;
  attempt_key: string;
  vendor_user_id: string;
  manager_user_id: string;
  payout_id: string;
  gross_cents: number;
  fee_share_cents: number;
  net_debit_cents: number;
  reason: string;
  status: "pending" | "succeeded" | "failed";
  stripe_refund_id: string | null;
  books_settled_at: string | null;
  notified_at: string | null;
};

const REQUEST_SELECT =
  "id, attempt_key, vendor_user_id, manager_user_id, payout_id, gross_cents, fee_share_cents, net_debit_cents, reason, status, stripe_refund_id, books_settled_at, notified_at";

function mapRefundReason(reason: string | undefined): Stripe.RefundCreateParams.Reason {
  const r = reason?.trim().toLowerCase();
  if (r?.startsWith("duplicate")) return "duplicate";
  if (r === "fraudulent") return r;
  return "requested_by_customer";
}

function isUniqueViolation(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === "23505" || /duplicate key|unique constraint/i.test(error.message ?? "")));
}

/**
 * What can actually be handed back for this payout, read from the rail's own tables:
 * the hold's remaining net split into cash still held on PropLane and cash already
 * released to the vendor's connected account (and, of that, only what the account still
 * holds - a withdrawn balance cannot be reversed). Net of any open dispute freeze.
 */
export async function readVendorRefundFunds(
  stripe: Stripe,
  db: SupabaseClient,
  input: { vendorUserId: string; holdId: string },
): Promise<RecoverableFunds> {
  const { data: hold, error: holdError } = await db
    .from("platform_payment_holds")
    .select("id, owner_user_id, amount_cents, status")
    .eq("id", input.holdId)
    .eq("owner_user_id", input.vendorUserId)
    .maybeSingle();
  if (holdError) throw new Error(`Could not read the payment hold: ${holdError.message}`);
  const h = hold as { amount_cents: number; status: string } | null;
  if (!h || !["classified_held", "transferred"].includes(h.status)) {
    return { heldCents: 0, transferredOutstandingCents: 0, availableBalanceCents: 0, frozenCents: 0 };
  }
  const [transfers, reversals, frozenCents, accountId] = await Promise.all([
    db.from("platform_hold_transfer_attempts").select("amount_cents").eq("hold_id", input.holdId).eq("status", "created"),
    db.from("platform_hold_refund_transfer_legs").select("amount_cents").eq("hold_id", input.holdId).eq("status", "created"),
    readVendorFrozenDisputeCents(db, input.vendorUserId),
    resolveManagerConnectAccountId(db, input.vendorUserId),
  ]);
  if (transfers.error || reversals.error) throw new Error("Could not read the payment's transfers.");
  const sum = (rows: unknown[] | null) =>
    (rows ?? []).reduce<number>((total, row) => total + (Number((row as { amount_cents: number }).amount_cents) || 0), 0);
  const transferredOutstandingCents = Math.max(0, sum(transfers.data) - sum(reversals.data));
  const heldCents = Math.max(0, Number(h.amount_cents) - transferredOutstandingCents);

  let availableBalanceCents = 0;
  if (transferredOutstandingCents > 0 && accountId) {
    const balance = await stripe.balance.retrieve({}, { stripeAccount: accountId });
    availableBalanceCents = balance.available.find((row) => row.currency === "usd")?.amount ?? 0;
  }
  return { heldCents, transferredOutstandingCents, availableBalanceCents, frozenCents };
}

/** The vendor's refund requests, newest first - the Refunds tab list. Scoped to the vendor. */
export async function listVendorRefundRequests(db: SupabaseClient, vendorUserId: string, limit = 100) {
  const { data, error } = await db
    .from("vendor_payout_refunds")
    .select(`${REQUEST_SELECT}, created_at`)
    .eq("vendor_user_id", vendorUserId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not read refunds: ${error.message}`);
  return (data ?? []) as Array<RefundRequestRow & { created_at: string }>;
}

async function loadRequest(db: SupabaseClient, attemptKey: string): Promise<RefundRequestRow | null> {
  const { data, error } = await db.from("vendor_payout_refunds").select(REQUEST_SELECT).eq("attempt_key", attemptKey).maybeSingle();
  if (error) throw new Error(`Could not read the refund request: ${error.message}`);
  return (data as RefundRequestRow | null) ?? null;
}

type ManagerBooksContext = {
  categoryCode: string;
  propertyId: string | null;
  vendorId: string | null;
  billId: string | null;
  invoiceId: string | null;
};

async function resolveManagerBooksContext(
  db: SupabaseClient,
  payout: { manager_user_id: string; invoice_id: string | null; work_order_id: string | null },
): Promise<ManagerBooksContext> {
  const fallback: ManagerBooksContext = {
    categoryCode: "maintenance", propertyId: null, vendorId: null, billId: null, invoiceId: payout.invoice_id,
  };
  if (payout.invoice_id) {
    const { data: invoice } = await db.from("vendor_invoices").select("id, bill_id").eq("id", payout.invoice_id).maybeSingle();
    const billId = (invoice as { bill_id?: string | null } | null)?.bill_id ?? null;
    if (billId) {
      const { data: bill } = await db
        .from("manager_bills")
        .select("id, category_code, property_id, vendor_id")
        .eq("id", billId)
        .eq("manager_user_id", payout.manager_user_id)
        .maybeSingle();
      const b = bill as { category_code?: string; property_id?: string | null; vendor_id?: string | null } | null;
      if (b) {
        return {
          categoryCode: b.category_code || "maintenance",
          propertyId: b.property_id ?? null,
          vendorId: b.vendor_id ?? null,
          billId,
          invoiceId: payout.invoice_id,
        };
      }
    }
    return { ...fallback, billId };
  }
  if (payout.work_order_id) {
    const { data: expense } = await db
      .from("manager_expense_entries")
      .select("category_code, property_id, vendor_id")
      .eq("manager_user_id", payout.manager_user_id)
      .eq("source_work_order_id", payout.work_order_id)
      .limit(1)
      .maybeSingle();
    const e = expense as { category_code?: string; property_id?: string | null; vendor_id?: string | null } | null;
    if (e) {
      return { ...fallback, categoryCode: e.category_code || "maintenance", propertyId: e.property_id ?? null, vendorId: e.vendor_id ?? null };
    }
  }
  return fallback;
}

/**
 * Everything a SUCCEEDED vendor refund writes beyond the rail's own settlement: the vendor
 * statement lines, PropLane's fee reversal, the manager's expense reversal + balanced GL entry,
 * the invoice/bill refunded state, and both notifications. Idempotent step by step (ledger and
 * revenue keys, a unique reversal row keyed on the attempt, an absolute `refunded_cents`, a
 * GL entry keyed on the attempt, event ids), so the route's own call, a webhook redelivery and a
 * retry can all run it. `books_settled_at` is set last: a half-finished run is simply re-run.
 *
 * `legacyDirect` is the destination-charge path, which books its own vendor statement lines in
 * `refundVendorPayout`; this then only adds the manager side.
 */
export async function settleVendorRefundBooks(
  db: SupabaseClient,
  attemptKey: string,
  opts: { legacyDirect?: boolean } = {},
): Promise<{ settled: boolean; reason?: string }> {
  const request = await loadRequest(db, attemptKey);
  if (!request) return { settled: false, reason: "no_request" };
  if (request.books_settled_at) return { settled: true };

  let feeShareCents = request.fee_share_cents;
  let netDebitCents = request.net_debit_cents;
  let stripeRefundId = request.stripe_refund_id;
  if (!opts.legacyDirect) {
    const { data: attempt, error } = await db
      .from("platform_hold_refund_attempts")
      .select("status, gross_cents, fee_share_cents, hold_debit_cents, stripe_refund_id, payout_id, owner_user_id")
      .eq("attempt_key", attemptKey)
      .maybeSingle();
    if (error) throw new Error(`Could not read the refund attempt: ${error.message}`);
    const a = attempt as {
      status: string; gross_cents: number; fee_share_cents: number; hold_debit_cents: number;
      stripe_refund_id: string | null; payout_id: string | null; owner_user_id: string;
    } | null;
    if (!a || a.status !== "succeeded") return { settled: false, reason: "attempt_not_succeeded" };
    if (a.payout_id !== request.payout_id || a.owner_user_id !== request.vendor_user_id || a.gross_cents !== request.gross_cents) {
      throw new Error("Refund request differs from its reserved attempt; it needs review.");
    }
    feeShareCents = a.fee_share_cents;
    netDebitCents = a.hold_debit_cents;
    stripeRefundId = a.stripe_refund_id ?? stripeRefundId;
  }

  const { data: payoutData, error: payoutError } = await db
    .from("vendor_payouts")
    .select("id, manager_user_id, vendor_user_id, invoice_id, work_order_id, refunded_gross_cents, stripe_charge_id")
    .eq("id", request.payout_id)
    .eq("vendor_user_id", request.vendor_user_id)
    .maybeSingle();
  if (payoutError || !payoutData) throw new Error("Refunded payment could not be read.");
  const payout = payoutData as {
    id: string; manager_user_id: string; vendor_user_id: string; invoice_id: string | null;
    work_order_id: string | null; refunded_gross_cents: number; stripe_charge_id: string | null;
  };

  await db
    .from("vendor_payout_refunds")
    .update({
      status: "succeeded",
      fee_share_cents: feeShareCents,
      net_debit_cents: netDebitCents,
      stripe_refund_id: stripeRefundId,
      updated_at: new Date().toISOString(),
    })
    .eq("attempt_key", attemptKey);

  const idk = `vrefund:${attemptKey}`;
  if (!opts.legacyDirect) {
    await recordVendorBankingLedgerEntry(db, {
      vendorUserId: payout.vendor_user_id,
      managerUserId: payout.manager_user_id,
      kind: "refund",
      amountCents: -request.gross_cents,
      source: "refund",
      sourceId: payout.id,
      description: request.reason.trim() ? `Refund — ${request.reason.trim()}` : "Refund",
      stripeObjectId: stripeRefundId ?? payout.stripe_charge_id,
      idempotencyKey: `${idk}:refund`,
    });
    if (feeShareCents > 0) {
      await recordVendorBankingLedgerEntry(db, {
        vendorUserId: payout.vendor_user_id,
        managerUserId: payout.manager_user_id,
        kind: "adjustment",
        amountCents: feeShareCents,
        source: "refund",
        sourceId: payout.id,
        description: `${PROPLANE_SERVICE_FEE_LABEL} returned on the refund`,
        stripeObjectId: stripeRefundId ?? payout.stripe_charge_id,
        idempotencyKey: `${idk}:fee_return`,
      });
      await recordVendorServiceFeeRevenueReversal(db, {
        vendorUserId: payout.vendor_user_id,
        managerUserId: payout.manager_user_id,
        feeCents: feeShareCents,
        source: "refund",
        sourceId: payout.id,
        reversalId: attemptKey,
      });
    }
  }

  // Manager side: expense reversal + GL, then the refunded state on the invoice and bill.
  const context = await resolveManagerBooksContext(db, payout);
  const entryDate = new Date().toISOString().slice(0, 10);
  const memo = `Vendor refund${request.reason.trim() ? ` — ${request.reason.trim()}` : ""}`;
  const { error: reversalError } = await db.from("manager_expense_reversals").insert({
    attempt_key: attemptKey,
    manager_user_id: payout.manager_user_id,
    payout_id: payout.id,
    vendor_invoice_id: context.invoiceId,
    bill_id: context.billId,
    property_id: context.propertyId,
    vendor_id: context.vendorId,
    category_code: context.categoryCode,
    amount_cents: request.gross_cents,
    reversal_date: entryDate,
    memo,
  });
  if (reversalError && !isUniqueViolation(reversalError)) {
    throw new Error(`Could not record the expense reversal: ${reversalError.message}`);
  }
  await postGlVendorRefundReversal(db, {
    managerUserId: payout.manager_user_id,
    attemptKey,
    categoryCode: context.categoryCode,
    amountCents: request.gross_cents,
    entryDate,
    propertyId: context.propertyId,
    vendorId: context.vendorId,
    memo,
  });
  const refundedCents = Number(payout.refunded_gross_cents) || 0;
  if (context.invoiceId) {
    await db.from("vendor_invoices").update({ refunded_cents: refundedCents }).eq("id", context.invoiceId);
  }
  if (context.billId) {
    await db.from("manager_bills").update({ refunded_cents: refundedCents }).eq("id", context.billId).eq("manager_user_id", payout.manager_user_id);
  }

  await emitVendorBankingEvent(db, {
    kind: "refund_sent",
    eventId: `refund:${attemptKey}:sent`,
    vendorUserId: payout.vendor_user_id,
    managerUserId: payout.manager_user_id,
    facts: { amountCents: request.gross_cents },
  });
  await emitVendorBankingEvent(db, {
    kind: "refund_received",
    eventId: `refund:${attemptKey}:received`,
    vendorUserId: payout.vendor_user_id,
    managerUserId: payout.manager_user_id,
    facts: { amountCents: request.gross_cents },
  });

  await db
    .from("vendor_payout_refunds")
    .update({ books_settled_at: new Date().toISOString(), notified_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("attempt_key", attemptKey);
  return { settled: true };
}

/**
 * Webhook half: a central refund attempt reached a terminal state. A vendor refund is any
 * attempt carrying a `payout_id`; anything else is not ours (returns false so the household
 * path continues). Succeeded -> books; failed -> the request is marked failed and nothing moved.
 */
export async function settleVendorRefundFromWebhook(
  db: SupabaseClient,
  attemptId: string,
  settlement: "succeeded" | "failed" | "pending" | "unmatched",
): Promise<boolean> {
  const { data, error } = await db
    .from("platform_hold_refund_attempts")
    .select("attempt_key, payout_id")
    .eq("id", attemptId)
    .maybeSingle();
  if (error) throw new Error(`Could not read the refund attempt: ${error.message}`);
  const attempt = data as { attempt_key: string; payout_id: string | null } | null;
  if (!attempt?.payout_id) return false;
  if (settlement === "succeeded") {
    await settleVendorRefundBooks(db, attempt.attempt_key);
  } else if (settlement === "failed") {
    await db
      .from("vendor_payout_refunds")
      .update({ status: "failed", updated_at: new Date().toISOString() })
      .eq("attempt_key", attempt.attempt_key)
      .eq("status", "pending");
  }
  return true;
}

/**
 * Vendor-initiated refund of a payment they own, on the central rail. Everything that decides
 * money is recomputed here: the payout is read scoped to the signed-in vendor, the cap comes
 * from the rail's own held/released split, and the Stripe call, the hold debit and the
 * transfer reversal all happen inside `runReservedPlatformMoneyRefund` under the
 * caller-stable `attemptKey` (client key per modal open), so a retry or a double-submit replays
 * the same reservation and can never refund twice. The webhook settles a pending refund.
 */
export async function submitVendorRefund(
  stripe: Stripe,
  db: SupabaseClient,
  opts: { payoutId: string; vendorUserId: string; requestedGrossCents?: number; reason?: string; clientKey: string },
): Promise<VendorRefundSubmitResult> {
  const attemptKey = vendorRefundAttemptKey(opts.payoutId, opts.clientKey);
  if (!attemptKey) return { ok: false, status: 400, code: "IDEMPOTENCY_KEY_REQUIRED", error: "A refund needs its Idempotency-Key." };

  const payout = await getVendorBankingPayoutForVendor(db, { payoutId: opts.payoutId, vendorUserId: opts.vendorUserId });
  if (!payout) return { ok: false, status: 404, error: "Payment not found." };
  const reason = (opts.reason ?? "").trim().slice(0, 500);

  // Destination-charge payments never sat on a central hold: the existing direct path
  // (reverse_transfer) refunds them; this adds the request row and the manager side.
  if (payout.destination !== "hold") {
    return refundDestinationChargePayout(stripe, db, { payout, attemptKey, requestedGrossCents: opts.requestedGrossCents, reason });
  }

  const { data: holdRow, error: holdError } = await db
    .from("vendor_payouts")
    .select("platform_hold_id")
    .eq("id", payout.id)
    .eq("vendor_user_id", opts.vendorUserId)
    .maybeSingle();
  if (holdError) throw new Error(holdError.message);
  const holdId = (holdRow as { platform_hold_id?: string | null } | null)?.platform_hold_id ?? null;
  if (!holdId) {
    return { ok: false, status: 422, code: "REFUND_NEEDS_REVIEW", error: "This payment's refund needs review. Message the manager." };
  }

  // Replay of an attempt this vendor already started: the stored terms win, the cap is not re-asked.
  const existing = await loadRequest(db, attemptKey);
  if (existing) {
    if (existing.vendor_user_id !== opts.vendorUserId || existing.payout_id !== payout.id) {
      return { ok: false, status: 409, error: "This refund key was already used." };
    }
    if (opts.requestedGrossCents !== undefined && Math.round(opts.requestedGrossCents) !== existing.gross_cents) {
      return { ok: false, status: 409, error: "This refund key was already used for a different amount." };
    }
    if (existing.status === "failed") {
      return { ok: false, status: 422, code: "REFUND_FAILED", error: "Stripe could not complete this refund. Nothing was refunded." };
    }
    return runAndSettle(stripe, db, { attemptKey, holdId, request: existing, replay: true });
  }

  if (payout.status !== "paid" && payout.status !== "partially_refunded") {
    return { ok: false, status: 409, error: `This payment is ${payout.status} and cannot be refunded.` };
  }
  const remaining = remainingRefundableGrossCents(payout);
  if (remaining <= 0) return { ok: false, status: 409, error: VENDOR_REFUND_REFUSAL_COPY.fully_refunded };
  const requested = Math.round(opts.requestedGrossCents ?? remaining);
  if (!Number.isSafeInteger(requested) || requested <= 0) {
    return { ok: false, status: 400, error: "Enter an amount greater than $0." };
  }
  if (requested > remaining) {
    return { ok: false, status: 422, error: `At most $${(remaining / 100).toFixed(2)} can still be refunded.` };
  }

  // One refund in flight per payment: a second would race the first one's hold debit.
  const { data: inFlight, error: inFlightError } = await db
    .from("vendor_payout_refunds")
    .select("id")
    .eq("payout_id", payout.id)
    .eq("status", "pending")
    .limit(1);
  if (inFlightError) throw new Error(inFlightError.message);
  if (inFlight && inFlight.length > 0) {
    return { ok: false, status: 409, code: "REFUND_IN_FLIGHT", error: "A refund for this payment is still processing." };
  }

  const funds = await readVendorRefundFunds(stripe, db, { vendorUserId: opts.vendorUserId, holdId });
  const cap = computeVendorRefundCap(payout, funds);
  if (cap.refusal) return { ok: false, status: 409, code: `REFUND_${cap.refusal.toUpperCase()}`, error: VENDOR_REFUND_REFUSAL_COPY[cap.refusal] };
  if (requested > cap.maxGrossCents) {
    return {
      ok: false,
      status: 422,
      code: "REFUND_OVER_RECOVERABLE",
      error: `You can refund up to $${(cap.maxGrossCents / 100).toFixed(2)} - the money still held for this job plus your available balance.`,
    };
  }

  const feeShareCents = refundFeeShareCents(payout, requested);
  const netDebitCents = refundNetDebitCents(payout, requested);
  const { data: inserted, error: insertError } = await db
    .from("vendor_payout_refunds")
    .insert({
      attempt_key: attemptKey,
      vendor_user_id: opts.vendorUserId,
      manager_user_id: payout.managerUserId,
      payout_id: payout.id,
      gross_cents: requested,
      fee_share_cents: feeShareCents,
      net_debit_cents: netDebitCents,
      reason,
      status: "pending",
    })
    .select(REQUEST_SELECT)
    .maybeSingle();
  if (insertError && !isUniqueViolation(insertError)) throw new Error(`Could not record the refund: ${insertError.message}`);
  // A concurrent double-submit lost the insert race: it replays the winner's row.
  const request = (inserted as RefundRequestRow | null) ?? (await loadRequest(db, attemptKey));
  if (!request) throw new Error("Could not record the refund.");
  return runAndSettle(stripe, db, { attemptKey, holdId, request, replay: !inserted });
}

async function runAndSettle(
  stripe: Stripe,
  db: SupabaseClient,
  input: { attemptKey: string; holdId: string; request: RefundRequestRow; replay: boolean },
): Promise<VendorRefundSubmitResult> {
  const { request } = input;
  let result: Awaited<ReturnType<typeof runReservedPlatformMoneyRefund>>;
  try {
    result = await runReservedPlatformMoneyRefund(stripe, db, {
      ownerUserId: request.vendor_user_id,
      holdId: input.holdId,
      payoutId: request.payout_id,
      principalCents: request.gross_cents,
      attemptKey: input.attemptKey,
      reason: mapRefundReason(request.reason),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Refund failed";
    // No reservation was ever created: nothing is in flight, so the request is simply failed.
    const { data: reserved } = await db
      .from("platform_hold_refund_attempts")
      .select("id")
      .eq("attempt_key", input.attemptKey)
      .maybeSingle();
    if (!reserved) {
      await db
        .from("vendor_payout_refunds")
        .update({ status: "failed", updated_at: new Date().toISOString() })
        .eq("attempt_key", input.attemptKey)
        .eq("status", "pending");
      return { ok: false, status: 409, code: "REFUND_REFUSED", error: refusalMessageFromRail(message) };
    }
    return { ok: false, status: 409, code: "REFUND_IN_FLIGHT", error: "This refund is still processing. It will finish on its own." };
  }
  if (result.status === "failed") {
    await db
      .from("vendor_payout_refunds")
      .update({ status: "failed", stripe_refund_id: result.refundId || null, updated_at: new Date().toISOString() })
      .eq("attempt_key", input.attemptKey)
      .eq("status", "pending");
    return { ok: false, status: 422, code: "REFUND_FAILED", error: "Stripe could not complete this refund. Nothing was refunded." };
  }
  if (result.status === "succeeded") {
    await settleVendorRefundBooks(db, input.attemptKey);
  } else {
    await db
      .from("vendor_payout_refunds")
      .update({ stripe_refund_id: result.refundId || null, updated_at: new Date().toISOString() })
      .eq("attempt_key", input.attemptKey);
  }
  return {
    ok: true,
    status: result.status,
    requestId: request.id,
    grossCents: request.gross_cents,
    feeShareCents: request.fee_share_cents,
    netDebitCents: request.net_debit_cents,
    replay: input.replay,
  };
}

/** The rail's own refusals are internal wording; the vendor sees one plain sentence. */
function refusalMessageFromRail(message: string): string {
  if (/exceeds|vector|insufficient|overconsumed|unresolved/i.test(message)) {
    return "This payment can't be refunded from here right now. Message the manager.";
  }
  return "This refund could not be started. Nothing was refunded.";
}

async function refundDestinationChargePayout(
  stripe: Stripe,
  db: SupabaseClient,
  input: {
    payout: NonNullable<Awaited<ReturnType<typeof getVendorBankingPayoutForVendor>>>;
    attemptKey: string;
    requestedGrossCents?: number;
    reason: string;
  },
): Promise<VendorRefundSubmitResult> {
  const { payout } = input;
  const existing = await loadRequest(db, input.attemptKey);
  if (existing?.status === "succeeded") {
    await settleVendorRefundBooks(db, input.attemptKey, { legacyDirect: true });
    return { ok: true, status: "succeeded", requestId: existing.id, grossCents: existing.gross_cents, feeShareCents: existing.fee_share_cents, netDebitCents: existing.net_debit_cents, replay: true };
  }
  const result = await refundVendorPayout(stripe, db, {
    payoutId: payout.id,
    vendorUserId: payout.vendorUserId,
    requestedGrossCents: input.requestedGrossCents,
    reason: input.reason,
    idempotencyKey: input.attemptKey,
  });
  if (!result.ok) return { ok: false, status: result.status === 403 ? 409 : result.status, error: result.error };
  const { data: row, error } = await db
    .from("vendor_payout_refunds")
    .upsert(
      {
        attempt_key: input.attemptKey,
        vendor_user_id: payout.vendorUserId,
        manager_user_id: payout.managerUserId,
        payout_id: payout.id,
        gross_cents: result.requestedGrossCents,
        fee_share_cents: result.feeShareCents,
        net_debit_cents: result.netDebitCents,
        reason: input.reason,
        status: "succeeded",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "attempt_key" },
    )
    .select(REQUEST_SELECT)
    .maybeSingle();
  if (error) throw new Error(`Could not record the refund: ${error.message}`);
  await settleVendorRefundBooks(db, input.attemptKey, { legacyDirect: true });
  const r = row as RefundRequestRow;
  return { ok: true, status: "succeeded", requestId: r.id, grossCents: result.requestedGrossCents, feeShareCents: result.feeShareCents, netDebitCents: result.netDebitCents, replay: false };
}

export type VendorRefundListItem = {
  id: string;
  status: "pending" | "succeeded" | "failed";
  grossCents: number;
  feeShareCents: number;
  netDebitCents: number;
  reason: string;
  createdAt: string;
  paymentLabel: string;
  managerLabel: string;
};

/** The Refunds tab rows: the vendor's own requests with the payment and manager named. Scoped to the vendor. */
export async function listVendorRefundsForDisplay(db: SupabaseClient, vendorUserId: string): Promise<VendorRefundListItem[]> {
  const requests = await listVendorRefundRequests(db, vendorUserId);
  if (requests.length === 0) return [];
  const payoutIds = [...new Set(requests.map((r) => r.payout_id))];
  const managerIds = [...new Set(requests.map((r) => r.manager_user_id))];
  const [payouts, managers] = await Promise.all([
    db.from("vendor_payouts").select("id, invoice_id, work_order_id").eq("vendor_user_id", vendorUserId).in("id", payoutIds),
    db.from("profiles").select("id, full_name, email").in("id", managerIds),
  ]);
  const payoutRows = (payouts.data ?? []) as Array<{ id: string; invoice_id: string | null; work_order_id: string | null }>;
  const invoiceIds = payoutRows.map((p) => p.invoice_id).filter((v): v is string => Boolean(v));
  const workOrderIds = payoutRows.map((p) => p.work_order_id).filter((v): v is string => Boolean(v));
  const [invoices, workOrders] = await Promise.all([
    invoiceIds.length
      ? db.from("vendor_invoices").select("id, invoice_number").eq("vendor_user_id", vendorUserId).in("id", invoiceIds)
      : Promise.resolve({ data: [] as unknown[] }),
    workOrderIds.length
      ? db.from("portal_work_order_records").select("id, row_data").in("id", workOrderIds)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);
  const invoiceNumber = new Map(((invoices.data ?? []) as Array<{ id: string; invoice_number: string | null }>).map((i) => [i.id, i.invoice_number ?? ""]));
  const workOrderTitle = new Map(
    ((workOrders.data ?? []) as Array<{ id: string; row_data: { title?: string } | null }>).map((w) => [w.id, w.row_data?.title ?? ""]),
  );
  const managerName = new Map(
    ((managers.data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>).map((m) => [m.id, m.full_name?.trim() || "Manager"]),
  );
  const labelForPayout = new Map(
    payoutRows.map((p) => [
      p.id,
      (p.invoice_id ? invoiceNumber.get(p.invoice_id) : "") || (p.work_order_id ? workOrderTitle.get(p.work_order_id) : "") || "Payment",
    ]),
  );
  return requests.map((r) => ({
    id: r.id,
    status: r.status,
    grossCents: r.gross_cents,
    feeShareCents: r.fee_share_cents,
    netDebitCents: r.net_debit_cents,
    reason: r.reason,
    createdAt: r.created_at,
    paymentLabel: labelForPayout.get(r.payout_id) ?? "Payment",
    managerLabel: managerName.get(r.manager_user_id) ?? "Manager",
  }));
}
