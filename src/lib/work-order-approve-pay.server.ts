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
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { creditHoldFromPaidSession } from "@/lib/stripe-platform-hold.server";
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
  paymentChannel?: "ach" | "balance";
  /**
   * Webhook settle — skip starting another Checkout session, and skip the
   * double-pay guard: this call moves no money at all (every payout write
   * below is gated on `!settleOnly`), it only records the payment the open
   * Checkout session already made, whose own `pending` payout row is exactly
   * what the guard would refuse on.
   */
  settleOnly?: boolean;
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
  checkoutUrl?: string;
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
  const workOrder = input.workOrder;
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

  const ownerManagerUserId = String(existing.manager_user_id ?? actor.userId);
  if ((await captureTestWorkspaceEffectForUser({
    userId: ownerManagerUserId,
    kind: "payment",
    summary: "Vendor payout refused for a test workspace.",
    db,
  })).captured) {
    return { ok: false, status: 403, error: "Vendor payouts are unavailable for test accounts." };
  }

  const paymentChannel: "ach" | "balance" = input.paymentChannel === "balance" ? "balance" : "ach";

  if (!input.settleOnly) {
    const blocking = await findBlockingVendorPayout(db, workOrder.id);
    if (!blocking.ok) return { ok: false, status: 500, error: blocking.error };
    if (blocking.payout) {
      return {
        ok: false,
        status: 409,
        code: VENDOR_DOUBLE_PAY_CONFLICT_CODE,
        error: existingVendorPayoutWarning(blocking.payout),
        existingPayout: blocking.payout,
      };
    }
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
    Number.isFinite(bidVendorCostCents) ? bidVendorCostCents : input.vendorCostCents;
  const acceptedMaterialsCostCents =
    Number.isFinite(bidMaterialsCostCents) ? bidMaterialsCostCents : input.materialsCostCents;
  const acceptedVendorId =
    typeof acceptedBid?.vendor_directory_id === "string" && acceptedBid.vendor_directory_id.trim()
      ? acceptedBid.vendor_directory_id
      : existingRow.vendorId;

  const vendorUserId = String(existing.vendor_user_id ?? "").trim();
  const invoiceCents = Math.round(acceptedVendorCostCents ?? 0);

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
    // Claim the job's payout BEFORE any money moves. The database refuses the claim when the job's
    // own invoice (or another Approve + pay) already has a pending/paid payout, so the read-then-
    // write pre-check above is not the only thing between the manager and paying twice.
    const claim = await claimWorkOrderPayout(db, {
      workOrderId: workOrder.id,
      managerUserId: ownerManagerUserId,
      vendorUserId,
      amountCents: invoiceCents,
    });
    if (!claim.ok) return claim;
    const move = await payVendorFromBalance(db, {
      managerUserId: ownerManagerUserId,
      vendorUserId,
      amountCents: invoiceCents,
      // Same idempotency-root shape as the vendor-invoice pay-from-balance
      // route (`vendor-invoice:<id>`) — scoped to this work order, so a
      // retried request can never pay the same job twice through the ledger.
      idempotencyRoot: `work-order:${workOrder.id}`,
    });
    if (!move.ok) {
      // Nothing moved: release the claim so the job can still be paid another way.
      await claim.release().catch(() => undefined);
      if (move.code === "insufficient_balance") {
        return {
          ok: false,
          status: 422,
          code: "insufficient_balance",
          error: `The PropLane balance has ${(move.availableCents / 100).toFixed(2)} available; this job needs ${(move.requestedCents / 100).toFixed(2)}. Pay by card instead.`,
          availableCents: move.availableCents,
          requestedCents: move.requestedCents,
          shortfallCents: move.shortfallCents,
        };
      }
      return { ok: false, status: 500, error: move.error };
    }
  }

  if (paymentChannel === "ach" && !input.settleOnly && vendorUserId && invoiceCents >= 100) {
    const checkout = await startVendorPayCheckout(db, {
      workOrderId: workOrder.id,
      ownerManagerUserId,
      vendorUserId,
      managerEmail: actor.email,
      invoiceCents,
      title: existingRow.title || workOrder.title || "Service",
      category: input.category,
      vendorCostCents: acceptedVendorCostCents,
      materialsCostCents: acceptedMaterialsCostCents,
      materialsMemo: input.materialsMemo,
      workDoneSummary: input.workDoneSummary,
      row: { ...existingRow, ...workOrder },
    });
    if (!checkout.ok) return checkout;
    return {
      ok: true,
      workOrder: { ...existingRow, ...workOrder },
      expenseEntryIds: [],
      checkoutUrl: checkout.url,
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
  const paid = markWorkOrderPaid(completed, new Date().toISOString(), { channel: paymentChannel });

  const { error } = await db.from("portal_work_order_records").upsert(
    {
      id: workOrder.id,
      manager_user_id: ownerManagerUserId,
      property_id: workOrder.propertyId ?? null,
      resident_email: workOrder.residentEmail ?? null,
      row_data: paid,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) return { ok: false, status: 500, error: error.message };

  let payoutOutcome: VendorPayoutOutcome | null = null;
  if (!input.settleOnly && existing.vendor_user_id && paymentChannel === "ach") {
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

/** The (work order, invoice) unique index refused the insert: a payout row for this job already exists. */
function isDuplicatePayoutRow(error: { code?: string } | null | undefined): boolean {
  return error?.code === "23505";
}

function crossRailPayoutFailure(message: string): WorkOrderActionFailure {
  return { ok: false, status: 409, error: message };
}

/**
 * Inserts the job's own (invoice-less) `pending` payout so the money move that follows is owned. The
 * insert is the atomic arbiter: `vendor_payouts_cross_rail_guard` (migration 20261004160000) refuses
 * it when the job's own invoice already has a pending/paid payout, and the (work order, invoice)
 * unique index refuses a second invoice-less row. A `failed`/`skipped` row from an earlier attempt
 * moved no money and is re-claimed by compare-and-swap.
 */
async function claimWorkOrderPayout(
  db: Db,
  input: { workOrderId: string; managerUserId: string; vendorUserId: string; amountCents: number },
): Promise<{ ok: true; release: () => Promise<void> } | WorkOrderActionFailure> {
  const nowIso = new Date().toISOString();
  const { error } = await db
    .from("vendor_payouts")
    .insert({
      manager_user_id: input.managerUserId,
      vendor_user_id: input.vendorUserId,
      work_order_id: input.workOrderId,
      // The job's OWN payout is the invoice-less one. Written explicitly because it is what both
      // the unique index and every reclaim/release below key on, not an incidental omission.
      invoice_id: null,
      amount_cents: input.amountCents,
      status: "pending",
      created_at: nowIso,
      updated_at: nowIso,
    });
  if (!error) {
    return {
      ok: true,
      // Keyed on what makes the claim unique rather than on an id read back from the insert: the
      // index allows exactly one invoice-less pending row per job, so this is the row just written.
      release: async () => {
        await db
          .from("vendor_payouts")
          .delete()
          .eq("work_order_id", input.workOrderId)
          .is("invoice_id", null)
          .eq("status", "pending");
      },
    };
  }
  if (isCrossRailPayoutRefusal(error)) return crossRailPayoutFailure(error.message);
  // Anything other than "a row is already there" is a real fault, not a double-pay refusal: reporting
  // a dropped connection or an RLS error as "already paid" hides it and tells the manager a lie.
  if (!isDuplicatePayoutRow(error)) {
    console.error("[approve-pay] could not claim the vendor payout", {
      workOrderId: input.workOrderId,
      code: error.code,
      message: error.message,
    });
    return { ok: false, status: 500, error: `Could not claim the payout for this service; nothing was paid. ${error.message}` };
  }
  const { data: reclaimed, error: reclaimError } = await db
    .from("vendor_payouts")
    .update({ status: "pending", amount_cents: input.amountCents, failure_reason: null, updated_at: nowIso })
    .eq("work_order_id", input.workOrderId)
    .is("invoice_id", null)
    .in("status", ["failed", "skipped"])
    .select("id, status")
    .maybeSingle();
  if (reclaimError && isCrossRailPayoutRefusal(reclaimError)) return crossRailPayoutFailure(reclaimError.message);
  if (reclaimError && !isDuplicatePayoutRow(reclaimError)) {
    console.error("[approve-pay] could not re-claim the failed vendor payout", {
      workOrderId: input.workOrderId,
      code: reclaimError.code,
      message: reclaimError.message,
    });
    return { ok: false, status: 500, error: `Could not claim the payout for this service; nothing was paid. ${reclaimError.message}` };
  }
  if (reclaimed?.id) {
    const id = String(reclaimed.id);
    return {
      ok: true,
      release: async () => {
        await db.from("vendor_payouts").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", id).eq("status", "pending");
      },
    };
  }
  return {
    ok: false,
    status: 409,
    error: "This service already has a payout in progress or paid through Approve + pay. Paying it again would pay the vendor twice.",
  };
}

type PendingVendorPay = {
  sessionId: string;
  category: WorkOrderCategory;
  vendorCostCents?: number;
  materialsCostCents?: number;
  materialsMemo?: string;
  workDoneSummary?: string;
};

async function startVendorPayCheckout(
  db: Db,
  input: {
    workOrderId: string;
    ownerManagerUserId: string;
    vendorUserId: string;
    managerEmail: string;
    invoiceCents: number;
    title: string;
    category: WorkOrderCategory;
    vendorCostCents?: number;
    materialsCostCents?: number;
    materialsMemo?: string;
    workDoneSummary?: string;
    row: DemoManagerWorkOrderRow;
  },
): Promise<
  | { ok: true; url: string; sessionId: string }
  | ApprovePayFailure
> {
  const stripe = getStripe();
  const destinationAccountId = await resolveConnectDestinationIfReady(stripe, db, input.vendorUserId);
  // Same claim as the balance rail, so a `failed`/`skipped` row from an earlier attempt is
  // re-claimed rather than deadlocking the job, and so every failure return below can hand the
  // claim back. A `pending` row left behind by a checkout that never started made the job
  // unpayable by EITHER rail once the cross-rail trigger started reading it as a live claim.
  const claim = await claimWorkOrderPayout(db, {
    workOrderId: input.workOrderId,
    managerUserId: input.ownerManagerUserId,
    vendorUserId: input.vendorUserId,
    amountCents: input.invoiceCents,
  });
  if (!claim.ok) return claim;
  const releaseAndFail = async (failure: ApprovePayFailure): Promise<ApprovePayFailure> => {
    await claim.release().catch(() => undefined);
    return failure;
  };
  const origin = resolveShareableAppOrigin();
  // VENDOR_BANKING_ENABLED: PropLane's 3% take on top of Stripe's own
  // processing cost, which the manager still pays exactly as before — the
  // fee comes out of what the vendor nets. 0 with the flag off, so the
  // checkout Stripe sees is byte-for-byte unchanged.
  const platformFeeCents = vendorBankingEnabled() ? vendorPayFeeCents(input.invoiceCents) : 0;
  const result = await createAxisAchCheckoutSession(stripe, {
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
    },
    destinationAccountId: destinationAccountId ?? undefined,
    mode: "hosted",
    paymentMethod: "ach",
    feePayer: "resident",
    extraApplicationFeeCents: platformFeeCents,
    successUrl: `${origin}/portal/services?vendor_pay=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/portal/services?vendor_pay=cancel`,
  });
  if (result.mode !== "hosted" || !result.url) {
    return releaseAndFail({ ok: false, status: 500, error: "Could not start vendor checkout." });
  }
  if (result.totalCents !== input.invoiceCents + result.processingFeeCents) {
    return releaseAndFail({
      ok: false,
      status: 500,
      error: "Vendor checkout total does not equal invoice plus Stripe’s cost.",
    });
  }
  const pending: PendingVendorPay = {
    sessionId: result.sessionId,
    category: input.category,
    vendorCostCents: input.vendorCostCents,
    materialsCostCents: input.materialsCostCents,
    materialsMemo: input.materialsMemo,
    workDoneSummary: input.workDoneSummary,
  };
  const { error } = await db
    .from("portal_work_order_records")
    .update({
      row_data: { ...input.row, pendingVendorPay: pending },
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.workOrderId);
  if (error) return releaseAndFail({ ok: false, status: 500, error: error.message });
  return { ok: true, url: result.url, sessionId: result.sessionId };
}

export async function completeVendorPayFromStripeSession(
  db: Db,
  session: import("stripe").default.Checkout.Session,
): Promise<void> {
  if (session.metadata?.purpose !== VENDOR_INVOICE_PAY_PURPOSE) return;
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
  if (row.automationStatus === "paid" || row.paidAt) {
    await creditHoldFromPaidSession(db, session).catch(() => undefined);
    return;
  }

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
      paymentChannel: "ach",
      settleOnly: true,
    },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  const vendorUserId = String(existing.vendor_user_id ?? session.metadata.vendor_user_id ?? "").trim();
  const invoiceCents = Number(session.metadata.invoice_cents ?? pending?.vendorCostCents ?? 0);
  if (vendorUserId && invoiceCents > 0) {
    const isHold = session.metadata.platform_hold === "1";
    const platformFeeCents = vendorBankingEnabled() ? Number(session.metadata.platform_fee_cents ?? 0) || 0 : 0;
    // Best-effort, flag-gated: resolves the real Stripe charge id so a hold
    // row can later be refunded/expired against it. `platform_payment_holds`
    // never stored this for a vendor_invoice-sourced hold before this flag —
    // populating it is itself a (harmless) behavior change, so it stays
    // behind the flag like everything else here.
    const stripeChargeId = vendorBankingEnabled()
      ? await resolveChargeIdFromCheckoutSession(getStripe(), session).catch(() => null)
      : null;
    await recordVendorPayoutSettled(db, {
      workOrderId,
      managerUserId,
      vendorUserId,
      amountCents: invoiceCents,
      stripeTransferId: isHold ? null : session.id,
      ...(vendorBankingEnabled()
        ? {
            platformFeeCents,
            destination: (isHold ? "hold" : "destination_charge") as "hold" | "destination_charge",
            stripeChargeId,
          }
        : {}),
    });
    await creditHoldFromPaidSession(db, session, stripeChargeId ?? undefined);
    if (vendorBankingEnabled()) {
      await recordVendorBankingChargeAndFee(db, {
        vendorUserId,
        managerUserId,
        grossCents: invoiceCents,
        feeCents: platformFeeCents,
        source: "work_order",
        sourceId: workOrderId,
        description: `Payment for ${row.title || "service"}`,
        stripeObjectId: stripeChargeId ?? session.id,
      }).catch((e) => console.error("[vendor-banking] ledger write failed for work order pay", e));
    }
  }
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
