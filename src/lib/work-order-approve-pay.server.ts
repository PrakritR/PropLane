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
import { createExpensesFromWorkOrder, markWorkOrderPaid, mergeWorkOrderCompletion } from "@/lib/work-order-expenses";
import { payoutVendorForWorkOrder, recordVendorPayoutSettled, type VendorPayoutOutcome } from "@/lib/stripe-vendor-payout";
import { createAxisAchCheckoutSession, VENDOR_INVOICE_PAY_PURPOSE } from "@/lib/stripe-axis-ach-checkout";
import { resolveConnectDestinationIfReady } from "@/lib/stripe-connect";
import { creditHoldFromPaidSession } from "@/lib/stripe-platform-hold.server";
import { getStripe } from "@/lib/stripe";
import { resolveShareableAppOrigin } from "@/lib/app-url";
import {
  existingVendorPayoutWarning,
  VENDOR_DOUBLE_PAY_ACK_ACTION,
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

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ApprovePayActor = { userId: string; email: string; isAdmin: boolean };

export type ApprovePayInput = {
  workOrder?: DemoManagerWorkOrderRow;
  category?: WorkOrderCategory;
  vendorCostCents?: number;
  materialsCostCents?: number;
  materialsMemo?: string;
  workDoneSummary?: string;
  /** ACH through Stripe Connect is the only vendor payout rail (PLAN-0916). */
  paymentChannel?: "ach";
  /**
   * The manager saw the double-pay warning naming the existing PropLane payout
   * and still wants to mark this paid. Without it, a work order that already has
   * a `pending` / `paid` `vendor_payouts` row is refused with a 409.
   */
  acknowledgeExistingPayout?: boolean;
  /** Webhook settle — skip starting another Checkout session. */
  settleOnly?: boolean;
};

/** A refusal that carries the payout the caller must acknowledge to proceed. */
export type ApprovePayExistingPayoutFailure = WorkOrderActionFailure & {
  status: 409;
  code: typeof VENDOR_DOUBLE_PAY_CONFLICT_CODE;
  existingPayout: ExistingVendorPayoutSummary;
};

export type ApprovePayFailure = WorkOrderActionFailure | ApprovePayExistingPayoutFailure;

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
 */
export async function findBlockingVendorPayout(
  db: Db,
  workOrderId: string,
): Promise<{ ok: true; payout: ExistingVendorPayoutSummary | null } | { ok: false; error: string }> {
  const { data, error } = await db
    .from("vendor_payouts")
    .select("id, status, amount_cents, stripe_transfer_id, created_at")
    .eq("work_order_id", workOrderId)
    .maybeSingle();
  if (error) return { ok: false, error: `Could not check for an existing payout: ${error.message}` };
  const row = data as
    | { id: string; status: string; amount_cents: number | null; stripe_transfer_id: string | null; created_at: string | null }
    | null;
  if (!row || !vendorPayoutBlocksMarkPaid(row.status)) return { ok: true, payout: null };
  return {
    ok: true,
    payout: {
      id: String(row.id),
      status: row.status as VendorPayoutStatus,
      amountCents: Number(row.amount_cents) || 0,
      stripeTransferId: row.stripe_transfer_id ?? null,
      createdAt: row.created_at ?? null,
    },
  };
}

/** Runs the same completion + expense-logging as /work-orders/complete, marks the
 * vendor paid, and (best-effort) transfers the vendor's labor cost to their connected
 * Stripe account if they've finished Connect onboarding — see payoutVendorForWorkOrder.
 * Notifies the resident and vendor.
 *
 * Double-pay guard: when the work order already has a `pending` / `paid`
 * `vendor_payouts` row, the write is refused (409, naming the payout) unless
 * `acknowledgeExistingPayout` is set, and the acknowledgement is recorded in
 * `audit_log` BEFORE any bookkeeping write — see `vendor-payout-guard.ts`. */
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

  const paymentChannel = "ach" as const;

  const blocking = await findBlockingVendorPayout(db, workOrder.id);
  if (!blocking.ok) return { ok: false, status: 500, error: blocking.error };
  if (blocking.payout) {
    if (input.acknowledgeExistingPayout !== true) {
      return {
        ok: false,
        status: 409,
        code: VENDOR_DOUBLE_PAY_CONFLICT_CODE,
        error: existingVendorPayoutWarning(blocking.payout),
        existingPayout: blocking.payout,
      };
    }
    // Intent first: the acknowledgement is on record even if a later write fails.
    const { error: auditError } = await db.from("audit_log").insert({
      actor_user_id: actor.userId,
      landlord_id: ownerManagerUserId,
      action: VENDOR_DOUBLE_PAY_ACK_ACTION,
      tool_name: "approve_pay",
      input_summary: {
        workOrderId: workOrder.id,
        payoutId: blocking.payout.id,
        payoutStatus: blocking.payout.status,
        payoutAmountCents: blocking.payout.amountCents,
        stripeTransferId: blocking.payout.stripeTransferId,
        paymentChannel,
      },
      created_at: new Date().toISOString(),
    });
    if (auditError) {
      return {
        ok: false,
        status: 500,
        error: `Could not record the acknowledgement; nothing was marked paid. ${auditError.message}`,
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
  if (!input.settleOnly && vendorUserId && invoiceCents >= 100) {
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
  });

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
  const nowIso = new Date().toISOString();
  const { error: payoutInsertError } = await db.from("vendor_payouts").insert({
    manager_user_id: input.ownerManagerUserId,
    vendor_user_id: input.vendorUserId,
    work_order_id: input.workOrderId,
    amount_cents: input.invoiceCents,
    status: "pending",
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (payoutInsertError) {
    return { ok: false, status: 500, error: payoutInsertError.message };
  }
  const origin = resolveShareableAppOrigin();
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
    },
    destinationAccountId: destinationAccountId ?? undefined,
    mode: "hosted",
    paymentMethod: "ach",
    feePayer: "resident",
    successUrl: `${origin}/portal/services?vendor_pay=success&session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${origin}/portal/services?vendor_pay=cancel`,
  });
  if (result.mode !== "hosted" || !result.url) {
    return { ok: false, status: 500, error: "Could not start vendor checkout." };
  }
  if (result.totalCents !== input.invoiceCents + result.processingFeeCents) {
    return { ok: false, status: 500, error: "Vendor checkout total does not equal invoice plus Stripe’s cost." };
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
  if (error) return { ok: false, status: 500, error: error.message };
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
      acknowledgeExistingPayout: true,
      settleOnly: true,
    },
  );
  if (!result.ok) {
    throw new Error(result.error);
  }

  const vendorUserId = String(existing.vendor_user_id ?? session.metadata.vendor_user_id ?? "").trim();
  const invoiceCents = Number(session.metadata.invoice_cents ?? pending?.vendorCostCents ?? 0);
  if (vendorUserId && invoiceCents > 0) {
    await recordVendorPayoutSettled(db, {
      workOrderId,
      managerUserId,
      vendorUserId,
      amountCents: invoiceCents,
      stripeTransferId: session.metadata.platform_hold === "1" ? null : session.id,
    });
    await creditHoldFromPaidSession(db, session);
  }
}
