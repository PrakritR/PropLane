/**
 * Manager's "Approve + Pay" core, extracted from the approve-pay route so the
 * agent tool layer runs the exact same completion + expense-logging +
 * markWorkOrderPaid + best-effort Stripe payout + notifications as the manager
 * UI. Caller owns authentication and the financials tier gate.
 *
 * Payout anchoring: the real Stripe transfer inside payoutVendorForWorkOrder
 * always prefers the accepted bid's amount_cents when one exists — the
 * caller-supplied vendorCostCents is only a fallback for jobs assigned without
 * formal bidding, so a forged amount can never inflate a payout beyond the
 * agreed bid.
 */
import { track } from "@/lib/analytics/posthog";
import { randomUUID } from "node:crypto";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { WorkOrderCategory } from "@/lib/reports/categories";
import {
  createExpensesFromWorkOrder,
  markWorkOrderPaid,
  mergeWorkOrderCompletion,
  readPostedWorkOrderExpenseLines,
} from "@/lib/work-order-expenses";
import { payoutVendorForWorkOrder, recordVendorPayoutSettled, type VendorPayoutOutcome } from "@/lib/stripe-vendor-payout";
import { createAxisAchCheckoutSession, VENDOR_INVOICE_PAY_PURPOSE } from "@/lib/stripe-axis-ach-checkout";
import { creditHoldFromPaidSession } from "@/lib/stripe-platform-hold.server";
import { creditVerifiedVendorCheckoutSource, verifyLegacyVendorCheckoutSource } from "@/lib/vendor-captured-source.server";
import { releaseVerifiedPlatformHoldsForOwner } from "@/lib/platform-hold-release.server";
import { getStripe } from "@/lib/stripe";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import {
  existingVendorPayoutWarning,
  VENDOR_DOUBLE_PAY_CONFLICT_CODE,
  vendorPayoutBlocksMarkPaid,
  type ExistingVendorPayoutSummary,
} from "@/lib/vendor-payout-guard";
import type { VendorPayoutStatus } from "@/lib/vendor-payouts";
import { centsToUsd } from "@/lib/reports/money";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { WorkOrderActionFailure } from "@/lib/work-order-bids.server";
import { workOrderEvent } from "@/lib/work-order-events.server";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";
import { proplaneBalanceEnabled } from "@/lib/proplane-balance/flag";
import { payVendorFromBalance } from "@/lib/proplane-balance/ledger.server";
import { vendorBankingEnabled } from "@/lib/vendor-banking/flag";
import { vendorPayFeeCents } from "@/lib/platform-fees";
import { residentServiceFeeBreakdown } from "@/lib/payment-policy";
import { recordVendorBankingChargeAndFee } from "@/lib/vendor-banking/ledger.server";

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ApprovePayActor = { userId: string; email: string; isAdmin: boolean };

export type ApprovePayInput = {
  workOrder?: DemoManagerWorkOrderRow;
  category?: WorkOrderCategory;
  vendorCostCents?: number;
  materialsCostCents?: number;
  materialsMemo?: string;
  workDoneSummary?: string;
  /**
   * ACH through Stripe Connect (PLAN-0916) is the default rail. `"balance"`
   * (night/vendor-pay, `PROPLANE_BALANCE_ENABLED`) pays the vendor instantly
   * out of the manager's PropLane balance instead — no Stripe call, no
   * Checkout redirect. Ignored (treated as `"ach"`) when the flag is off.
   */
  paymentChannel?: "card" | "ach" | "balance";
  /**
   * Webhook settle — skip starting another Checkout session, and skip the
   * double-pay guard: this call moves no money at all (every payout write
   * below is gated on `!settleOnly`), it only records the payment the open
   * Checkout session already made, whose own `pending` payout row is exactly
   * what the guard would refuse on.
   */
  settleOnly?: boolean;
  /** Internal webhook evidence; never accepted from the public request body. */
  verifiedSessionId?: string;
};

/** A refusal that carries the payout the caller must acknowledge to proceed. */
export type ApprovePayExistingPayoutFailure = WorkOrderActionFailure & {
  status: 409;
  code: typeof VENDOR_DOUBLE_PAY_CONFLICT_CODE;
  existingPayout: ExistingVendorPayoutSummary;
};

/** `paymentChannel: "balance"` and the PropLane balance can't cover the job — the caller falls back to the card (ACH) path. */
export type ApprovePayInsufficientBalanceFailure = WorkOrderActionFailure & {
  status: 422;
  code: "insufficient_balance";
  availableCents: number;
  requestedCents: number;
  shortfallCents: number;
};

export type ApprovePayFailure =
  | WorkOrderActionFailure
  | ApprovePayExistingPayoutFailure
  | ApprovePayInsufficientBalanceFailure;

export type ApprovePaySuccess = {
  ok: true;
  workOrder: DemoManagerWorkOrderRow;
  expenseEntryIds: string[];
  clientSecret?: string;
  sessionId?: string;
};

/**
 * The `vendor_payouts` row that would make a second mark-paid a double payment,
 * or null when none exists or the one that exists moved no money (`failed` /
 * `skipped`). A read failure counts as a blocking payout: this is the only
 * check between the manager and paying twice, so it refuses rather than
 * proceeding on an unread table.
 *
 * A service can carry several payout rows, because the estimate-visit fee is a
 * SECOND invoice on the same `work_order_id`. Paying that $50 fee is not paying
 * the job, so its payout is not a double-pay warning — and the read must not
 * assume one row either, or the fee's existence alone made every later
 * Approve + pay refuse.
 *
 * Only the server-written `estimate_visit_bid_id` marks a visit fee. The invoice
 * NUMBER cannot: it arrives verbatim in the vendor's own submission body, so
 * reading the exemption off a `VISIT-` prefix let the assigned vendor number
 * their own job bill that way and have this guard wave the second payout
 * through. An invoice id that does not come back is not exempt either.
 *
 * This is the FRIENDLY pre-check, not the arbiter: it is read-then-write. The database arbitrates
 * (`vendor_payouts_cross_rail_guard` trigger + `claim_vendor_invoice_payment`, migration
 * 20261004160000) so two racing writers can never both insert. Every rail that pays a job calls it
 * first — Approve + pay, offline/balance (`claimInvoicePayment`) and Stripe invoice pay.
 * `excludeInvoiceId` is the invoice being paid, so its own claim row never blocks a retry.
 */
export async function findBlockingVendorPayout(
  db: Db,
  workOrderId: string,
  opts: { excludeInvoiceId?: string | null } = {},
): Promise<{ ok: true; payout: ExistingVendorPayoutSummary | null } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("vendor_payouts")
    .select("id, status, amount_cents, stripe_transfer_id, created_at, invoice_id")
    .eq("work_order_id", workOrderId);
  if (error) return { ok: false, error: `Could not check for an existing payout: ${error.message}` };
  const rows = (data ?? []) as Array<{
    id: string;
    status: string;
    amount_cents: number | null;
    stripe_transfer_id: string | null;
    created_at: string | null;
    invoice_id: string | null;
  }>;
  const candidates = rows
    .filter((row) => vendorPayoutBlocksMarkPaid(row.status))
    // The invoice rail asks "is there ANOTHER payout?": its own claim row is not a duplicate.
    .filter((row) => !opts.excludeInvoiceId || row.invoice_id !== opts.excludeInvoiceId)
    .sort((left, right) => String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")));
  if (candidates.length === 0) return { ok: true, payout: null };
  const invoiceIds = [...new Set(candidates.map((row) => row.invoice_id ?? "").filter(Boolean))];
  const visitFeeInvoiceIds = new Set<string>();
  if (invoiceIds.length > 0) {
    const { data: invoices, error: invoiceError } = await db
      .from("vendor_invoices")
      .select("id, estimate_visit_bid_id")
      .in("id", invoiceIds);
    if (invoiceError) {
      return { ok: false, error: `Could not check for an existing payout: ${invoiceError.message}` };
    }
    for (const invoice of (invoices ?? []) as Array<{ id?: unknown; estimate_visit_bid_id?: unknown }>) {
      const id = invoice.id == null ? "" : String(invoice.id);
      if (id && invoice.estimate_visit_bid_id != null) visitFeeInvoiceIds.add(id);
    }
  }
  const row = candidates.find((candidate) => !candidate.invoice_id || !visitFeeInvoiceIds.has(candidate.invoice_id));
  if (!row) return { ok: true, payout: null };
  return {
    ok: true,
    payout: {
      id: String(row.id),
      status: row.status as VendorPayoutStatus,
      amountCents: Number(row.amount_cents) || 0,
      stripeTransferId: row.stripe_transfer_id ?? null,
      createdAt: row.created_at ?? null,
      rail: row.invoice_id ? "invoice" : "approve_pay",
    },
  };
}

/** Runs the same completion + expense-logging as /work-orders/complete, marks the
 * vendor paid, and (best-effort) transfers the vendor's labor cost to their connected
 * Stripe account if they've finished Connect onboarding — see payoutVendorForWorkOrder.
 * Notifies the resident and vendor.
 *
 * Double-pay guard: when the work order already has a `pending` / `paid`
 * `vendor_payouts` row, the write is refused (409, naming the payout and the
 * rail that already covers it). There is no override — see
 * `vendor-payout-guard.ts`. */
export async function approveAndPayWorkOrder(
  db: Db,
  actor: ApprovePayActor,
  input: ApprovePayInput,
): Promise<ApprovePaySuccess | ApprovePayFailure> {
  let workOrder = input.workOrder;
  if (!workOrder?.id) return { ok: false, status: 400, error: "workOrder required." };
  if (!input.category) return { ok: false, status: 400, error: "category required." };

  const { data: existing } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrder.id)
    .maybeSingle();
  if (!existing || (!actor.isAdmin && existing.manager_user_id !== actor.userId)) {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const existingRow = (existing.row_data ?? {}) as DemoManagerWorkOrderRow;
  // The request only selects a service. Property, resident, payee, and cost
  // identity come from its stored record and accepted bid, never its JSON.
  workOrder = { ...existingRow, id: workOrder.id };

  const ownerManagerUserId = String(existing.manager_user_id ?? actor.userId);
  if ((await captureTestWorkspaceEffectForUser({
    userId: ownerManagerUserId,
    kind: "payment",
    summary: "Vendor payout refused for a test workspace.",
    db,
  })).captured) {
    return { ok: false, status: 403, error: "Vendor payouts are unavailable for test accounts." };
  }

  const paymentChannel: "card" | "ach" | "balance" = input.paymentChannel === "balance"
    ? "balance" : input.paymentChannel === "card" ? "card" : "ach";

  let blocking = await findBlockingVendorPayout(db, workOrder.id);
  if (!blocking.ok) return { ok: false, status: 500, error: blocking.error };
  const pendingCheckout = (existingRow as DemoManagerWorkOrderRow & { pendingVendorPay?: PendingVendorPay }).pendingVendorPay;
  if (blocking.payout?.status === "pending" && pendingCheckout?.sessionId &&
      paymentChannel !== "balance" && !input.settleOnly) {
    if (!pendingCheckout.sessionId.startsWith("attempt:")) {
      const session = await getStripe().checkout.sessions.retrieve(pendingCheckout.sessionId);
      if (session.status === "open" && session.client_secret &&
          session.metadata?.payment_method === paymentChannel) {
        return { ok: true, workOrder: { ...existingRow, ...workOrder }, expenseEntryIds: [], clientSecret: session.client_secret, sessionId: session.id };
      }
      if (session.status === "expired") {
        await releaseFailedVendorPayCheckout(db, session);
        blocking = await findBlockingVendorPayout(db, workOrder.id);
        if (!blocking.ok) return { ok: false, status: 500, error: blocking.error };
      } else {
        return { ok: false, status: 409, error: "This payment is already submitted and processing. Check its status before trying again." };
      }
    }
  }
  const resumeAttempt = paymentChannel !== "balance" && blocking.payout?.status === "pending" && pendingCheckout?.sessionId.startsWith("attempt:")
    ? pendingCheckout.sessionId : null;
  const resumeBalance = paymentChannel === "balance" &&
    (existingRow as DemoManagerWorkOrderRow & { pendingBalancePay?: string }).pendingBalancePay === `work-order:${workOrder.id}`;
  if (!input.settleOnly && blocking.payout && !resumeAttempt && !resumeBalance) {
    return {
      ok: false,
      status: 409,
      code: VENDOR_DOUBLE_PAY_CONFLICT_CODE,
      error: existingVendorPayoutWarning(blocking.payout),
      existingPayout: blocking.payout,
    };
  }
  const { data: acceptedBid } = await db
    .from("work_order_bids")
    .select("amount_cents, materials_cents, vendor_directory_id")
    .eq("work_order_id", workOrder.id)
    .eq("status", "accepted")
    .maybeSingle();
  const bidVendorCostCents = acceptedBid?.amount_cents == null ? NaN : Number(acceptedBid.amount_cents);
  // NaN is the "no accepted bid figure" sentinel, matching the labor line above.
  // This used to default to 0, and `Number.isFinite(0)` is true — so whenever
  // there was no accepted bid (a directly-assigned work order), the caller's
  // `materialsCostCents` was silently discarded: no materials expense row, no GL
  // posting, and `mergeWorkOrderCompletion` wrote the materials back as 0. The
  // agent's own preview printed the real figure and then booked nothing.
  const bidMaterialsCostCents = acceptedBid?.materials_cents == null ? NaN : Number(acceptedBid.materials_cents);
  const acceptedVendorCostCents =
    Number.isFinite(bidVendorCostCents) ? bidVendorCostCents : existingRow.vendorCostCents;
  const acceptedMaterialsCostCents =
    Number.isFinite(bidMaterialsCostCents) ? bidMaterialsCostCents : existingRow.materialsCostCents;
  const acceptedVendorId =
    typeof acceptedBid?.vendor_directory_id === "string" && acceptedBid.vendor_directory_id.trim()
      ? acceptedBid.vendor_directory_id
      : existingRow.vendorId;

  const vendorUserId = String(existing.vendor_user_id ?? "").trim();
  const invoiceCents = Math.round(acceptedVendorCostCents ?? 0);
  if (!vendorUserId || invoiceCents < 100) {
    return { ok: false, status: 400, error: "Service payment needs an assigned vendor and accepted labor cost of at least $1.00." };
  }

  // What this job has already expensed, read BEFORE any money moves. The posting below refuses to
  // double-post off this answer, so a read that fails has to refuse the whole request here rather
  // than after the balance debit — paying the vendor and then failing to record it is the one
  // half-done state this function is built to avoid.
  const postedLines = await readPostedWorkOrderExpenseLines(db, ownerManagerUserId, workOrder.id);
  if (!postedLines.ok) {
    return {
      ok: false,
      status: 500,
      error: `Could not check what this job has already expensed; nothing was paid. ${postedLines.error}`,
    };
  }

  // night/vendor-pay: pay the vendor instantly out of the manager's PropLane
  // balance instead of starting a Stripe Checkout session. Runs BEFORE any
  // completion/expense-logging write, so an insufficient balance (or the flag
  // being off) leaves nothing half-done — the caller falls back to the card
  // (ACH) path, which stays exactly as it was.
  if (paymentChannel === "balance" && !input.settleOnly) {
    if (!proplaneBalanceEnabled()) {
      return { ok: false, status: 400, error: "The PropLane balance is not enabled." };
    }
    if (!vendorUserId || invoiceCents < 100) {
      return { ok: false, status: 400, error: "Balance payment needs a vendor and a cost of at least $1.00." };
    }
    // The unique work-order payout index claims this service before any ledger
    // move. A concurrent ACH Checkout cannot also start after this insert.
    const { error: claimError } = await db.rpc("claim_work_order_vendor_payment", {
      p_work_order: workOrder.id, p_manager: ownerManagerUserId, p_vendor: vendorUserId,
      p_amount: invoiceCents, p_channel: "balance", p_pending: null,
    });
    if (claimError) {
      return isCrossRailPayoutRefusal(claimError) ? crossRailPayoutFailure(claimError.message)
        : { ok: false, status: 409, error: "A payment is already in progress for this service." };
    }
    let move: Awaited<ReturnType<typeof payVendorFromBalance>>;
    try {
      move = await payVendorFromBalance(db, {
      managerUserId: ownerManagerUserId,
      vendorUserId,
      amountCents: invoiceCents,
      // Same idempotency-root shape as the vendor-invoice pay-from-balance
      // route (`vendor-invoice:<id>`) — scoped to this work order, so a
      // retried request can never pay the same job twice through the ledger.
      idempotencyRoot: `work-order:${workOrder.id}`,
      });
    } catch {
      // The ledger RPC may have committed before a response was lost. Keep
      // the pending claim so another payment rail cannot send money twice.
      return { ok: false, status: 503, error: "Payment status is being reconciled. Do not retry with another method yet." };
    }
    if (!move.ok) {
      if (move.code !== "insufficient_balance") {
        return { ok: false, status: 503, error: "Payment status is being reconciled. Do not retry with another method yet." };
      }
      const { error: releaseError } = await db.rpc("release_work_order_balance_claim", {
        p_work_order: workOrder.id, p_manager: ownerManagerUserId,
      });
      if (releaseError) return { ok: false, status: 503, error: "Payment claim could not be released. Try again shortly." };
      return {
        ok: false,
        status: 422,
        code: "insufficient_balance",
        error: `The PropLane balance has ${(move.availableCents / 100).toFixed(2)} available; this service needs ${(move.requestedCents / 100).toFixed(2)}. Pay by card instead.`,
        availableCents: move.availableCents,
        requestedCents: move.requestedCents,
        shortfallCents: move.shortfallCents,
      };
    }
  }

  if (paymentChannel !== "balance" && !input.settleOnly && vendorUserId && invoiceCents >= 100) {
    const checkout = await startVendorPayCheckout(db, {
      workOrderId: workOrder.id,
      ownerManagerUserId,
      vendorUserId,
      managerEmail: actor.email,
      paymentMethod: paymentChannel,
      invoiceCents,
      title: existingRow.title || workOrder.title || "Service",
      category: input.category,
      vendorCostCents: acceptedVendorCostCents,
      materialsCostCents: acceptedMaterialsCostCents,
      materialsMemo: input.materialsMemo,
      workDoneSummary: input.workDoneSummary,
      row: { ...existingRow, ...workOrder },
      existingAttempt: resumeAttempt,
    });
    if (!checkout.ok) return checkout;
    return {
      ok: true,
      workOrder: { ...existingRow, ...workOrder },
      expenseEntryIds: [],
      clientSecret: checkout.clientSecret,
      sessionId: checkout.sessionId,
    };
  }

  const expenseEntryIds = await createExpensesFromWorkOrder(db, ownerManagerUserId, {
    workOrderId: workOrder.id,
    category: input.category,
    vendorCostCents: acceptedVendorCostCents,
    materialsCostCents: acceptedMaterialsCostCents,
    materialsMemo: input.materialsMemo,
    workDoneSummary: input.workDoneSummary,
    propertyId: workOrder.propertyId || workOrder.assignedPropertyId,
    vendorId: acceptedVendorId,
  }, postedLines.posted);

  const completed = mergeWorkOrderCompletion(
    { ...existingRow, ...workOrder },
    {
      workOrderId: workOrder.id,
      category: input.category,
      vendorCostCents: acceptedVendorCostCents,
      materialsCostCents: acceptedMaterialsCostCents,
      materialsMemo: input.materialsMemo,
      workDoneSummary: input.workDoneSummary,
      propertyId: workOrder.propertyId,
      vendorId: acceptedVendorId,
    },
    expenseEntryIds,
  );
  const paidPatch = markWorkOrderPaid(completed, existingRow.paidAt || new Date().toISOString(), { channel: paymentChannel });
  const { data: paidRaw, error } = await db.rpc("mark_work_order_payment_paid", {
    p_work_order: workOrder.id,
    p_manager: ownerManagerUserId,
    p_vendor: vendorUserId,
    p_amount: invoiceCents,
    p_channel: paymentChannel,
    p_session: input.settleOnly ? input.verifiedSessionId ?? null : null,
    p_patch: paidPatch,
  });
  if (error || !paidRaw) return { ok: false, status: 500, error: error?.message ?? "Could not mark service paid." };
  const paid = paidRaw as DemoManagerWorkOrderRow;

  let payoutOutcome: VendorPayoutOutcome | null = null;
  if (!input.settleOnly && existing.vendor_user_id && paymentChannel !== "balance") {
    // amountCents here is only a fallback for jobs assigned without formal bidding —
    // payoutVendorForWorkOrder anchors to the work order's accepted bid when one exists,
    // so a forged vendorCostCents can't inflate a payout beyond the agreed bid.
    payoutOutcome = await payoutVendorForWorkOrder(db, {
      workOrderId: workOrder.id,
      managerUserId: ownerManagerUserId,
      vendorUserId: existing.vendor_user_id,
      amountCents: acceptedVendorCostCents ?? 0,
    }).catch(() => null);
  } else if (!input.settleOnly && existing.vendor_user_id && paymentChannel === "balance") {
    // The ledger move already happened above (before any write) — this only
    // records it in `vendor_payouts` so the SAME double-pay guard
    // (`findBlockingVendorPayout`) and payout timeline see a settled payout,
    // exactly as `completeVendorPayFromStripeSession` already does for a
    // platform-hold-settled Stripe payment with no transfer id yet.
    await recordVendorPayoutSettled(db, {
      workOrderId: workOrder.id,
      managerUserId: ownerManagerUserId,
      vendorUserId: existing.vendor_user_id,
      amountCents: acceptedVendorCostCents ?? 0,
      stripeTransferId: null,
    });
    payoutOutcome = { status: "paid", amountCents: acceptedVendorCostCents ?? 0 };
  }

  const propertyLabel = paid.propertyName ? `${paid.propertyName}${paid.unit ? ` · ${paid.unit}` : ""}` : "";
  const title = paid.title || "Service";
  const residentEmail = (paid.residentEmail ?? "").trim();
  if (residentEmail.includes("@")) {
    await workOrderEvent(db, {
      eventId: `${workOrder.id}:completed:${paid.completedAt || paid.paidAt || "completed"}`,
      event: "completed",
      managerUserId: ownerManagerUserId,
      workOrderId: workOrder.id,
      senderUserId: actor.userId,
      senderEmail: actor.email,
      facts: {
        reference: paid.reference || "Work order",
        propertyId: paid.assignedPropertyId || paid.propertyId || undefined,
        title,
        propertyLabel: propertyLabel || undefined,
      },
      recipients: [{ audience: "resident", email: residentEmail }],
    }).catch(() => undefined);
  }

  const managerRecipients = await resolvePropertyScopedManagerRecipientIds(db, {
    ownerManagerUserId,
    propertyId: paid.assignedPropertyId || paid.propertyId || undefined,
    channel: "services",
  });
  await workOrderEvent(db, {
    eventId: `${workOrder.id}:paid:${paid.paidAt || "completed"}`,
    event: "paid",
    managerUserId: ownerManagerUserId,
    workOrderId: workOrder.id,
    senderUserId: actor.userId,
    senderEmail: actor.email,
    facts: {
      reference: paid.reference || "Work order",
      title,
      propertyLabel: propertyLabel || undefined,
      amountCents: (acceptedVendorCostCents ?? 0) + (acceptedMaterialsCostCents ?? 0),
    },
    recipients: [
      ...(existing.vendor_user_id ? [{ audience: "vendor" as const, userId: existing.vendor_user_id }] : []),
      ...managerRecipients.map((userId) => ({ audience: "manager" as const, userId })),
    ],
  }).catch(() => undefined);

  track("work_order_completed", actor.userId, {
    work_order_id: workOrder.id,
    property_id: workOrder.propertyId ?? "",
    category: input.category ?? "",
  });
  track("work_order_paid", actor.userId, { work_order_id: workOrder.id, property_id: workOrder.propertyId ?? "" });
  return { ok: true, workOrder: paid, expenseEntryIds };
}

/** The database refused a payout insert because another rail already covers this job (SQLSTATE VP409). */
function isCrossRailPayoutRefusal(error: { code?: string; message?: string } | null | undefined): boolean {
  return error?.code === "VP409";
}

function crossRailPayoutFailure(message: string): WorkOrderActionFailure {
  return { ok: false, status: 409, error: message };
}

type PendingVendorPay = {
  sessionId: string;
  category: WorkOrderCategory;
  vendorCostCents?: number;
  materialsCostCents?: number;
  materialsMemo?: string;
  workDoneSummary?: string;
  providerTerms?: {
    managerUserId: string; vendorUserId: string; invoiceCents: number;
    platformFeeCents: number;
    request: Parameters<typeof createAxisAchCheckoutSession>[1];
  };
};

async function startVendorPayCheckout(
  db: Db,
  input: {
    workOrderId: string;
    ownerManagerUserId: string;
    vendorUserId: string;
    managerEmail: string;
    paymentMethod: "card" | "ach";
    invoiceCents: number;
    title: string;
    category: WorkOrderCategory;
    vendorCostCents?: number;
    materialsCostCents?: number;
    materialsMemo?: string;
    workDoneSummary?: string;
    row: DemoManagerWorkOrderRow;
    existingAttempt?: string | null;
  },
): Promise<
  | { ok: true; clientSecret: string; sessionId: string }
  | ApprovePayFailure
> {
  const stripe = getStripe();
  const attempt = input.existingAttempt ?? `attempt:${randomUUID()}`;
  const origin = resolveShareableAppOrigin();
  const platformFeeCents = vendorBankingEnabled() ? vendorPayFeeCents(input.invoiceCents) : 0;
  const candidateRequest: Parameters<typeof createAxisAchCheckoutSession>[1] = {
    idempotencyKey: `work-order:${input.workOrderId}:${attempt}`,
    residentEmail: input.managerEmail,
    amountCents: input.invoiceCents,
    productName: `Vendor invoice · ${input.title}`.slice(0, 120),
    productDescription: "Invoice total to the vendor. You pay Stripe’s processing cost.",
    metadata: {
      purpose: VENDOR_INVOICE_PAY_PURPOSE,
      work_order_id: input.workOrderId,
      manager_user_id: input.ownerManagerUserId,
      vendor_user_id: input.vendorUserId,
      invoice_cents: String(input.invoiceCents),
      platform_fee_cents: String(platformFeeCents),
      source_arbitration_v: "1",
      checkout_attempt: attempt,
    },
    destinationAccountId: null,
    mode: "embedded",
    paymentMethod: input.paymentMethod,
    forceExplicitCard: input.paymentMethod === "card",
    fixedFeeBreakdown: residentServiceFeeBreakdown(input.invoiceCents, input.paymentMethod, "resident"),
    feePayer: "resident",
    extraApplicationFeeCents: platformFeeCents,
    redirectOnCompletion: "if_required",
    returnUrl: `${origin}/portal/services?vendor_pay=return&session_id={CHECKOUT_SESSION_ID}`,
  };
  let providerTerms: NonNullable<PendingVendorPay["providerTerms"]>;
  if (!input.existingAttempt) {
    providerTerms = { managerUserId: input.ownerManagerUserId,
      vendorUserId: input.vendorUserId, invoiceCents: input.invoiceCents,
      platformFeeCents, request: candidateRequest };
    const pending: PendingVendorPay = {
      sessionId: attempt,
      category: input.category,
      vendorCostCents: input.vendorCostCents,
      materialsCostCents: input.materialsCostCents,
      materialsMemo: input.materialsMemo,
      workDoneSummary: input.workDoneSummary,
      providerTerms,
    };
    const { error: markerError } = await db.rpc("claim_work_order_vendor_payment", {
      p_work_order: input.workOrderId, p_manager: input.ownerManagerUserId,
      p_vendor: input.vendorUserId, p_amount: input.invoiceCents,
      p_channel: input.paymentMethod, p_pending: pending,
    });
    if (markerError) {
      return isCrossRailPayoutRefusal(markerError) ? crossRailPayoutFailure(markerError.message)
        : { ok: false, status: 409, error: markerError.message };
    }
  } else {
    const saved = (input.row as DemoManagerWorkOrderRow & { pendingVendorPay?: PendingVendorPay }).pendingVendorPay;
    if (!saved?.providerTerms || saved.sessionId !== attempt) {
      return { ok: false, status: 409,
        error: "The prior service checkout needs provider-term reconciliation." };
    }
    providerTerms = saved.providerTerms;
  }
  if (providerTerms.managerUserId !== input.ownerManagerUserId ||
      providerTerms.vendorUserId !== input.vendorUserId ||
      providerTerms.invoiceCents !== input.invoiceCents ||
      providerTerms.request.idempotencyKey !== candidateRequest.idempotencyKey ||
      providerTerms.request.amountCents !== input.invoiceCents ||
      providerTerms.request.paymentMethod !== input.paymentMethod ||
      providerTerms.request.forceExplicitCard !== (input.paymentMethod === "card") ||
      !providerTerms.request.fixedFeeBreakdown ||
      providerTerms.request.fixedFeeBreakdown.totalCents !== input.invoiceCents +
        providerTerms.request.fixedFeeBreakdown.residentAddedFeeCents ||
      providerTerms.request.destinationAccountId ||
      providerTerms.request.metadata?.source_arbitration_v !== "1" ||
      providerTerms.request.metadata?.checkout_attempt !== attempt) {
    return { ok: false, status: 409, error: "Service provider terms need reconciliation." };
  }
  const result = await createAxisAchCheckoutSession(stripe, providerTerms.request);
  if (result.mode !== "embedded" || !result.clientSecret) {
    return { ok: false, status: 500, error: "Could not start vendor checkout." };
  }
  if (result.totalCents !== input.invoiceCents + result.processingFeeCents) {
    return { ok: false, status: 500, error: "Vendor checkout total does not equal invoice plus Stripe’s cost." };
  }
  const { data: saved, error } = await db.rpc("finish_work_order_vendor_checkout", {
    p_work_order: input.workOrderId, p_manager: input.ownerManagerUserId,
    p_attempt: attempt, p_session: result.sessionId,
  });
  if (error || !saved) return { ok: false, status: 503, error: "Payment status is being reconciled. Try again shortly." };
  return { ok: true, clientSecret: result.clientSecret, sessionId: result.sessionId };
}

export async function completeVendorPayFromStripeSession(
  db: Db,
  session: import("stripe").default.Checkout.Session,
): Promise<void> {
  if (session.metadata?.purpose !== VENDOR_INVOICE_PAY_PURPOSE) return;
  // ACH Checkout emits `completed` while the bank debit is still clearing.
  // Only `async_payment_succeeded` (or a paid card session) may book payment.
  if (session.payment_status !== "paid") return;
  const workOrderId = session.metadata.work_order_id?.trim();
  const managerUserId = session.metadata.manager_user_id?.trim();
  if (!workOrderId || !managerUserId) return;

  const { data: existing } = await db
    .from("portal_work_order_records")
    .select("manager_user_id, vendor_user_id, row_data")
    .eq("id", workOrderId)
    .maybeSingle();
  if (!existing) return;
  const row = (existing.row_data ?? {}) as DemoManagerWorkOrderRow & { pendingVendorPay?: PendingVendorPay };
  const pending = row.pendingVendorPay;
  const invoiceCentsFromPending = Number(pending?.vendorCostCents);
  const processingFeeCents = Number(session.metadata.processing_fee_cents);
  const platformFeeCentsFromSession = Number(session.metadata.platform_fee_cents ?? 0);
  if (!pending || pending.sessionId !== session.id ||
      String(existing.manager_user_id ?? "") !== managerUserId ||
      String(existing.vendor_user_id ?? "") !== String(session.metadata.vendor_user_id ?? "") ||
      !Number.isSafeInteger(invoiceCentsFromPending) || invoiceCentsFromPending < 100 ||
      !Number.isSafeInteger(processingFeeCents) || processingFeeCents < 0 ||
      !Number.isSafeInteger(platformFeeCentsFromSession) ||
      platformFeeCentsFromSession < 0 ||
      platformFeeCentsFromSession >= invoiceCentsFromPending ||
      Number(session.metadata.invoice_cents ?? 0) !== invoiceCentsFromPending ||
      session.currency?.toLowerCase() !== "usd" ||
      session.amount_total !== invoiceCentsFromPending + processingFeeCents ||
      !["card", "ach"].includes(String(session.metadata.payment_method))) {
    throw new Error("Vendor payment session does not match its pending service payout.");
  }
  const markedCentral = session.metadata.source_arbitration_v === "1";
  if (session.metadata.source_arbitration_v && !markedCentral) {
    throw new Error("Unknown service source arbitration version.");
  }
  const vendorUserId = String(existing.vendor_user_id ?? "").trim();
  let verifiedHoldId: string | null = null;
  let verifiedChargeId: string | null = null;
  if (markedCentral) {
    const frozen = pending.providerTerms;
    if (!frozen || frozen.managerUserId !== managerUserId ||
        frozen.vendorUserId !== vendorUserId || frozen.invoiceCents !== invoiceCentsFromPending ||
        frozen.platformFeeCents !== platformFeeCentsFromSession ||
        frozen.request.amountCents !== invoiceCentsFromPending ||
        frozen.request.paymentMethod !== session.metadata.payment_method ||
        frozen.request.extraApplicationFeeCents !== platformFeeCentsFromSession ||
        frozen.request.forceExplicitCard !== (session.metadata.payment_method === "card") ||
        frozen.request.fixedFeeBreakdown?.residentAddedFeeCents !== processingFeeCents ||
        frozen.request.fixedFeeBreakdown?.totalCents !== session.amount_total ||
        frozen.request.destinationAccountId ||
        frozen.request.metadata?.source_arbitration_v !== "1" ||
        frozen.request.metadata?.checkout_attempt !== session.metadata.checkout_attempt ||
        frozen.request.metadata?.platform_fee_cents !== String(platformFeeCentsFromSession) ||
        frozen.request.idempotencyKey !==
          `work-order:${workOrderId}:${session.metadata.checkout_attempt}`) {
      throw new Error("Service Checkout differs from its frozen provider claim.");
    }
    const source = await creditVerifiedVendorCheckoutSource(db, getStripe(), session, {
      purpose: VENDOR_INVOICE_PAY_PURPOSE,
      managerUserId, vendorUserId, sourceId: workOrderId,
      componentId: workOrderId, componentKind: "vendor_service",
      principalCents: invoiceCentsFromPending, platformFeeCents: platformFeeCentsFromSession,
    });
    verifiedHoldId = source.holdId;
    verifiedChargeId = source.chargeId;
  } else {
    const legacy = await verifyLegacyVendorCheckoutSource(db, getStripe(), session, {
      purpose: VENDOR_INVOICE_PAY_PURPOSE,
      managerUserId, vendorUserId, principalCents: invoiceCentsFromPending,
      platformFeeCents: platformFeeCentsFromSession, sourceId: workOrderId,
    });
    verifiedChargeId = legacy.chargeId;
    await creditHoldFromPaidSession(db, session, legacy.chargeId);
  }
  if (row.automationStatus === "paid" || row.paidAt) {
    // The work-order row can commit before payout and fee books do. Replays
    // must repair those idempotent side effects instead of acknowledging early.
  } else {
    const result = await approveAndPayWorkOrder(
      db,
      {
        userId: managerUserId,
        email: session.customer_email?.trim() || "manager@proplane.app",
        isAdmin: true,
      },
      {
        workOrder: { ...row, id: workOrderId },
        category: pending?.category,
        vendorCostCents: pending?.vendorCostCents,
        materialsCostCents: pending?.materialsCostCents,
        materialsMemo: pending?.materialsMemo,
        workDoneSummary: pending?.workDoneSummary,
        paymentChannel: session.metadata.payment_method as "card" | "ach",
        settleOnly: true,
        verifiedSessionId: session.id,
      },
    );
    if (!result.ok) throw new Error(result.error);
  }

  const invoiceCents = Number(session.metadata.invoice_cents ?? pending?.vendorCostCents ?? 0);
  if (vendorUserId && invoiceCents > 0) {
    const isHold = session.metadata.platform_hold === "1";
    const platformFeeCents = platformFeeCentsFromSession;
    // Best-effort, flag-gated: resolves the real Stripe charge id so a hold
    // row can later be refunded/expired against it. `platform_payment_holds`
    // never stored this for a vendor_invoice-sourced hold before this flag —
    // populating it is itself a (harmless) behavior change, so it stays
    // behind the flag like everything else here.
    const stripeChargeId = verifiedChargeId ?? await resolveChargeIdFromCheckoutSession(getStripe(), session);
    if (isHold && !stripeChargeId) throw new Error("Paid service Checkout has no resolvable Stripe charge.");
    await recordVendorPayoutSettled(db, {
      workOrderId,
      managerUserId,
      vendorUserId,
      amountCents: invoiceCents,
      stripeTransferId: isHold ? null : session.id,
      ...((markedCentral || vendorBankingEnabled() || platformFeeCents > 0)
        ? {
            platformFeeCents,
            destination: (isHold ? "hold" : "destination_charge") as "hold" | "destination_charge",
            stripeChargeId,
            platformHoldId: verifiedHoldId,
          }
        : {}),
    });
    if (markedCentral || vendorBankingEnabled() || platformFeeCents > 0) {
      await recordVendorBankingChargeAndFee(db, {
        vendorUserId,
        managerUserId,
        grossCents: invoiceCents,
        feeCents: platformFeeCents,
        source: "work_order",
        sourceId: workOrderId,
        description: `Payment for ${row.title || "service"}`,
        stripeObjectId: stripeChargeId ?? session.id,
      });
    }
    if (verifiedHoldId) await releaseVerifiedPlatformHoldsForOwner(db, {
      ownerUserId: vendorUserId, holdId: verifiedHoldId, stripe: getStripe(),
    });
  }
}

/** A terminal Stripe session releases only its own pending service payment.
 * An older event cannot unlock a newer session or an already-paid service. */
export async function releaseFailedVendorPayCheckout(
  db: Db,
  session: import("stripe").default.Checkout.Session,
): Promise<void> {
  if (session.metadata?.purpose !== VENDOR_INVOICE_PAY_PURPOSE) return;
  const workOrderId = session.metadata.work_order_id?.trim();
  const managerUserId = session.metadata.manager_user_id?.trim();
  if (!workOrderId || !managerUserId) return;
  const stripe = getStripe();
  const current = await stripe.checkout.sessions.retrieve(session.id);
  let terminal = current.status === "expired";
  if (!terminal && current.status === "complete" && current.payment_status === "unpaid" && current.payment_intent) {
    const pi = typeof current.payment_intent === "string"
      ? await stripe.paymentIntents.retrieve(current.payment_intent)
      : current.payment_intent;
    terminal = pi.status === "requires_payment_method" || pi.status === "canceled";
  }
  if (!terminal) return;
  const { error } = await db.rpc("release_work_order_vendor_checkout", {
    p_work_order: workOrderId, p_manager: managerUserId, p_session: session.id,
  });
  if (error) throw new Error(error.message);
}

/** Resolves the real Stripe charge id behind a settled Checkout session (payment_intent → latest_charge). */
async function resolveChargeIdFromCheckoutSession(
  stripe: ReturnType<typeof getStripe>,
  session: import("stripe").default.Checkout.Session,
): Promise<string | null> {
  const pi = session.payment_intent;
  if (!pi) return null;
  const intent = typeof pi === "string" ? await stripe.paymentIntents.retrieve(pi) : pi;
  const charge = intent.latest_charge;
  return typeof charge === "string" ? charge : charge?.id ?? null;
}
