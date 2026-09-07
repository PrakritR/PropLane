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
import { payoutVendorForWorkOrder, type VendorPayoutOutcome } from "@/lib/stripe-vendor-payout";
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

type Db = ReturnType<typeof createSupabaseServiceRoleClient>;

export type ApprovePayActor = { userId: string; email: string; isAdmin: boolean };

export type ApprovePayInput = {
  workOrder?: DemoManagerWorkOrderRow;
  category?: WorkOrderCategory;
  vendorCostCents?: number;
  materialsCostCents?: number;
  materialsMemo?: string;
  workDoneSummary?: string;
  paymentChannel?: "ach" | "zelle" | "venmo";
  /**
   * The manager saw the double-pay warning naming the existing PropLane payout
   * and still wants to mark this paid. Without it, a work order that already has
   * a `pending` / `paid` `vendor_payouts` row is refused with a 409.
   */
  acknowledgeExistingPayout?: boolean;
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

  const paymentChannel = input.paymentChannel === "zelle" || input.paymentChannel === "venmo" || input.paymentChannel === "ach"
    ? input.paymentChannel
    : "ach";

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

  const { data: vendorDirectory } = acceptedVendorId
    ? await db
        .from("manager_vendor_records")
        .select("row_data")
        .eq("id", acceptedVendorId)
        .eq("manager_user_id", ownerManagerUserId)
        .maybeSingle()
    : { data: null };
  const vendorRow = (vendorDirectory?.row_data ?? null) as {
    zelleContact?: string;
    venmoContact?: string;
    zellePaymentsEnabled?: boolean;
    venmoPaymentsEnabled?: boolean;
  } | null;

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
  const paid = markWorkOrderPaid(completed, new Date().toISOString(), {
    channel: paymentChannel,
    zelleContactSnapshot:
      paymentChannel === "zelle" && vendorRow?.zellePaymentsEnabled ? vendorRow.zelleContact?.trim() : undefined,
    venmoContactSnapshot:
      paymentChannel === "venmo" && vendorRow?.venmoPaymentsEnabled ? vendorRow.venmoContact?.trim() : undefined,
  });

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
  if (existing.vendor_user_id && paymentChannel === "ach") {
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
      facts: { reference: paid.reference || "Work order", title, propertyLabel: propertyLabel || undefined },
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
